import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

test('actual WebGL static shadow reuse preserves pixels and updates moving casters, lights and map placement', async ({
  page,
}, info) => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const bundle = await build({
    stdin: {
      contents:
        "export { MapShadowCache } from './frontend/src/map-shadow-cache'; export { StaticMapGroup } from './frontend/src/static-map-group'; export { playerShadows } from './frontend/src/player-shadows';",
      resolveDir: root,
    },
    bundle: true,
    write: false,
    format: 'esm',
    external: ['three'],
  });
  await page.route('**/__qa_shadows__/**', async (route) => {
    const name = new URL(route.request().url()).pathname.split('/').pop();
    if (name === 'cache.js')
      return route.fulfill({ contentType: 'text/javascript', body: bundle.outputFiles[0].text });
    if (name === 'three.module.js' || name === 'three.core.js')
      return route.fulfill({
        contentType: 'text/javascript',
        body: await readFile(root + 'frontend/node_modules/three/build/' + name),
      });
    return route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><head><script type="importmap">{"imports":{"three":"./three.module.js"}}</script></head><body></body></html>',
    });
  });
  await page.goto('/__qa_shadows__/index.html');
  const report = await page.evaluate(async () => {
    // This is original test geometry in a real WebGL renderer, not game artwork.
    const threeURL = location.origin + '/__qa_shadows__/three.module.js',
      cacheURL = location.origin + '/__qa_shadows__/cache.js';
    const T = await import(/* @vite-ignore */ threeURL),
      { MapShadowCache, StaticMapGroup, playerShadows } = await import(/* @vite-ignore */ cacheURL);
    const renderer = new T.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
    renderer.setSize(320, 240);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = T.PCFShadowMap;
    renderer.info.autoReset = false;
    document.body.append(renderer.domElement);
    const scene = new T.Scene(),
      camera = new T.PerspectiveCamera(45, 320 / 240, 0.1, 100);
    scene.background = new T.Color('#b7b7b7');
    camera.position.set(6, 7, 9);
    camera.lookAt(0, 0, 0);
    const map = new StaticMapGroup(),
      floor = new T.Mesh(
        new T.PlaneGeometry(12, 12),
        new T.MeshStandardMaterial({ color: '#c8bca9' }),
      ),
      cube = new T.Mesh(
        new T.BoxGeometry(1.5, 2, 1.5),
        new T.MeshStandardMaterial({ color: '#486e86' }),
      );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    cube.position.y = 1;
    cube.castShadow = true;
    map.add(floor, cube);
    map.seal([]);
    const light = new T.DirectionalLight(0xffffff, 3);
    light.position.set(-4, 6, -3);
    light.castShadow = true;
    light.shadow.mapSize.set(512, 512);
    light.shadow.camera.left = -8;
    light.shadow.camera.right = 8;
    light.shadow.camera.top = 8;
    light.shadow.camera.bottom = -8;
    light.shadow.camera.far = 30;
    light.shadow.camera.updateProjectionMatrix();
    scene.add(map, light, light.target, new T.AmbientLight(0xffffff, 0.5));
    const pixels = () => {
      const gl = renderer.getContext(),
        data = new Uint8Array(320 * 240 * 4);
      gl.readPixels(0, 0, 320, 240, gl.RGBA, gl.UNSIGNED_BYTE, data);
      return data;
    };
    const draw = () => {
      renderer.info.reset();
      renderer.render(scene, camera);
      return { calls: renderer.info.render.calls, pixels: pixels() };
    };
    const original = draw(),
      normal = draw();
    light.castShadow = false;
    floor.material.needsUpdate = true;
    const unshadowed = draw();
    light.castShadow = true;
    floor.material.needsUpdate = true;
    draw();
    const cache = new MapShadowCache();
    renderer.shadowMap.autoUpdate = false;
    scene.onBeforeRender = (r: typeof renderer, s: typeof scene, c: typeof camera) =>
      cache.update(s, c, r);
    draw();
    draw();
    const cached = draw();
    const changed = (a: Uint8Array, b: Uint8Array) => {
      let count = 0;
      for (let i = 0; i < a.length; i += 4)
        if (
          Math.max(
            Math.abs(a[i] - b[i]),
            Math.abs(a[i + 1] - b[i + 1]),
            Math.abs(a[i + 2] - b[i + 2]),
          ) > 2
        )
          count++;
      return count;
    };
    const changeAndCompare = (mutate: () => void) => {
      mutate();
      const refreshed = draw(),
        quiet = draw();
      scene.onBeforeRender = () => {};
      renderer.shadowMap.autoUpdate = true;
      const uncached = draw();
      renderer.shadowMap.autoUpdate = false;
      scene.onBeforeRender = (r: typeof renderer, s: typeof scene, c: typeof camera) =>
        cache.update(s, c, r);
      return {
        refreshCalls: refreshed.calls,
        quietCalls: quiet.calls,
        uncachedCalls: uncached.calls,
        differentPixels: changed(refreshed.pixels, uncached.pixels),
      };
    };
    const dynamic = new T.Mesh(
      new T.BoxGeometry(1, 2, 1),
      new T.MeshStandardMaterial({ color: '#b05c32' }),
    );
    dynamic.position.set(-2, 1, 0);
    dynamic.castShadow = true;
    const added = changeAndCompare(() => scene.add(dynamic));
    const moved = changeAndCompare(() => {
      dynamic.position.z = 2;
    });
    const relit = changeAndCompare(() => {
      light.position.x = 4;
    });
    const relocated = changeAndCompare(() => {
      map.position.x = 1;
    });
    const removed = changeAndCompare(() => {
      scene.remove(dynamic);
    });
    const result = {
      normalCalls: normal.calls,
      cachedCalls: cached.calls,
      staticDifferentPixels: changed(normal.pixels, cached.pixels),
      visibleShadowPixels: changed(normal.pixels, unshadowed.pixels),
      distinctColors: new Set(
        Array.from({ length: normal.pixels.length / 4 }, (_, i) =>
          normal.pixels.slice(i * 4, i * 4 + 3).join(','),
        ),
      ).size,
      baselineStablePixels: changed(original.pixels, normal.pixels),
      added,
      moved,
      relit,
      relocated,
      removed,
    };
    dynamic.castShadow = false;
    dynamic.userData.playerShadowCaster = true;
    dynamic.position.set(-1, 1, 2);
    const actors = new T.Group();
    actors.add(dynamic);
    scene.add(actors);
    draw();
    const liveShadows = playerShadows();
    const release = liveShadows.receivers(map);
    const sun = {
      position: light.position.toArray(),
      target: [0, 0, 0],
      up: [0, 1, 0],
      shadow: { left: -8, right: 8, bottom: -8, top: 8, near: 0.1, far: 30 },
      color: [1, 1, 1],
    };
    const renderPlayerDepth = () => {
      renderer.info.reset();
      liveShadows.render(renderer, actors, sun);
      return renderer.info.render.calls;
    };
    const baseline = draw();
    const playerDrawCalls = renderPlayerDepth();
    const outside = draw();
    dynamic.position.x = 2;
    renderPlayerDepth();
    const playerMoved = draw();
    liveShadows.disable();
    const movedUnshadowed = draw();
    const live = {
      playerDrawCalls,
      playerShadowPixels: changed(baseline.pixels, outside.pixels),
      movedShadowPixels: changed(playerMoved.pixels, movedUnshadowed.pixels),
      staticPassStayedCached:
        outside.calls === baseline.calls && playerMoved.calls === movedUnshadowed.calls,
    };
    release();
    liveShadows.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    return { ...result, ...live };
  });
  await info.attach('original-shadow-cache-evidence', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  });
  expect(report.playerDrawCalls).toBe(1);
  expect(report.playerShadowPixels).toBeGreaterThan(100);
  expect(report.movedShadowPixels).toBeGreaterThan(100);
  expect(report.staticPassStayedCached).toBe(true);
  expect(report.normalCalls).toBeGreaterThan(report.cachedCalls);
  expect(report.baselineStablePixels).toBe(0);
  expect(report.staticDifferentPixels).toBe(0);
  expect(report.visibleShadowPixels).toBeGreaterThan(100);
  expect(report.distinctColors).toBeGreaterThan(20);
  for (const scenario of [
    report.added,
    report.moved,
    report.relit,
    report.relocated,
    report.removed,
  ]) {
    expect(scenario.refreshCalls).toBeGreaterThan(scenario.quietCalls);
    expect(scenario.refreshCalls).toBe(scenario.uncachedCalls);
    expect(scenario.differentPixels).toBe(0);
  }
});
