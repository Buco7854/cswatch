import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

test('bounded authored-sky filtering lights actual metallic pixels and restores renderer/resources after failure', async ({
  page,
}, info) => {
  const graphicsDiagnostics: string[] = [];
  page.on('console', (message) => {
    if (
      ['error', 'warning'].includes(message.type()) &&
      /WebGL|framebuffer|INVALID_|EXT_color_buffer/i.test(message.text())
    )
      graphicsDiagnostics.push(message.text());
  });
  const root = fileURLToPath(new URL('../../', import.meta.url)),
    bundle = await build({
      stdin: {
        contents: "export { createMapSkyLighting } from './frontend/src/map-ibl';",
        resolveDir: root,
      },
      bundle: true,
      write: false,
      format: 'esm',
      external: ['three'],
    });
  await page.route('**/__qa_sky_lighting__/**', async (route) => {
    const name = new URL(route.request().url()).pathname.split('/').pop();
    if (name === 'lighting.js')
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
  await page.goto('/__qa_sky_lighting__/index.html');
  const report = await page.evaluate(async () => {
    const threeURL = location.origin + '/__qa_sky_lighting__/three.module.js',
      lightingURL = location.origin + '/__qa_sky_lighting__/lighting.js',
      T = await import(/* @vite-ignore */ threeURL),
      { createMapSkyLighting } = await import(/* @vite-ignore */ lightingURL);
    const renderer = new T.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
    renderer.setSize(192, 128);
    renderer.toneMapping = T.ACESFilmicToneMapping;
    document.body.append(renderer.domElement);
    // Original asymmetric colored faces and original geometry only, no game art.
    const images = ['#ef4030', '#27ca62', '#425fe7', '#d8c62f', '#d93cdd', '#35ced8'].map(
        (color) => {
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 512;
          const context = canvas.getContext('2d')!;
          context.fillStyle = color;
          context.fillRect(0, 0, 512, 512);
          context.fillStyle = '#eeeeee';
          context.fillRect(0, 0, 128, 128);
          return canvas;
        },
      ),
      cube = new T.CubeTexture(images),
      scene = new T.Scene(),
      camera = new T.PerspectiveCamera(40, 192 / 128, 0.1, 20),
      geometry = new T.SphereGeometry(0.8, 32, 16),
      material = new T.MeshStandardMaterial({ color: '#ffffff', metalness: 1, roughness: 0.12 }),
      sphere = new T.Mesh(geometry, material);
    cube.colorSpace = T.SRGBColorSpace;
    cube.needsUpdate = true;
    let sourceDisposals = 0;
    cube.addEventListener('dispose', () => sourceDisposals++);
    camera.position.set(0, 0, 3);
    camera.lookAt(0, 0, 0);
    scene.background = new T.Color('#191919');
    scene.add(sphere);
    const pixels = () => {
        renderer.render(scene, camera);
        const data = new Uint8Array(192 * 128 * 4),
          gl = renderer.getContext();
        gl.readPixels(0, 0, 192, 128, gl.RGBA, gl.UNSIGNED_BYTE, data);
        return data;
      },
      changed = (a: Uint8Array, b: Uint8Array) => {
        let count = 0;
        for (let i = 0; i < a.length; i += 4)
          if (
            Math.max(
              Math.abs(a[i] - b[i]),
              Math.abs(a[i + 1] - b[i + 1]),
              Math.abs(a[i + 2] - b[i + 2]),
            ) > 5
          )
            count++;
        return count;
      },
      baseline = pixels(),
      originalTextures = renderer.info.memory.textures;
    const stateTarget = new T.WebGLRenderTarget(128, 64);
    renderer.setRenderTarget(stateTarget);
    renderer.setViewport(3, 4, 80, 50);
    renderer.setScissor(5, 6, 70, 40);
    renderer.setScissorTest(true);
    renderer.autoClear = false;
    const renderTargetMethod = renderer.setRenderTarget,
      state = () => ({
        target: renderer.getRenderTarget() === stateTarget,
        method: renderer.setRenderTarget === renderTargetMethod,
        viewport: renderer.getViewport(new T.Vector4()).toArray(),
        scissor: renderer.getScissor(new T.Vector4()).toArray(),
        scissorTest: renderer.getScissorTest(),
        currentViewport: renderer.getCurrentViewport(new T.Vector4()).toArray(),
        glViewport: Array.from(renderer.getContext().getParameter(renderer.getContext().VIEWPORT)),
        glScissor: Array.from(
          renderer.getContext().getParameter(renderer.getContext().SCISSOR_BOX),
        ),
        glScissorTest: renderer.getContext().isEnabled(renderer.getContext().SCISSOR_TEST),
        targetViewport: stateTarget.viewport.toArray(),
        targetScissor: stateTarget.scissor.toArray(),
        targetScissorTest: stateTarget.scissorTest,
        autoClear: renderer.autoClear,
        toneMapping: renderer.toneMapping,
        xr: renderer.xr.enabled,
      }),
      beforeState = state(),
      profiles = [];
    // Target-local state differs from global settings. No global setters run
    // after binding, which is the normal render-target case the old probe missed.
    stateTarget.viewport.set(7, 8, 90, 40);
    stateTarget.scissor.set(9, 10, 60, 30);
    stateTarget.scissorTest = false;
    renderer.setRenderTarget(stateTarget);
    const targetLocalBefore = state(),
      targetLocalResource = createMapSkyLighting(renderer, cube, true),
      targetLocalAfter = state();
    targetLocalResource.dispose();
    // Keep the complementary post-bind global-override path below.
    renderer.setViewport(3, 4, 80, 50);
    renderer.setScissor(5, 6, 70, 40);
    renderer.setScissorTest(true);
    const overriddenBefore = state();
    for (const low of [true, false]) {
      const resource = createMapSkyLighting(renderer, cube, low),
        restored = JSON.stringify(state()) === JSON.stringify(overriddenBefore);
      renderer.setRenderTarget(null);
      renderer.setViewport(0, 0, 192, 128);
      renderer.setScissorTest(false);
      renderer.autoClear = true;
      scene.environment = resource.texture;
      const lit = pixels();
      scene.environmentRotation.y = Math.PI / 2;
      const rotated = pixels();
      scene.environmentRotation.y = 0;
      scene.environment = null;
      const unlit = pixels();
      resource.dispose();
      const texturesAfterSingleDispose = renderer.info.memory.textures;
      resource.dispose();
      profiles.push({
        low,
        size: resource.size,
        width: resource.texture.image.width,
        height: resource.texture.image.height,
        restored,
        litPixels: changed(baseline, lit),
        reflectedOrientationPixels: changed(lit, rotated),
        resetPixels: changed(baseline, unlit),
        texturesAfterSingleDispose,
        sourceDisposals,
        imagesRemainDecoded: images.every((image) => image.width === 512 && image.height === 512),
        texturesAfter: renderer.info.memory.textures,
      });
      renderer.setRenderTarget(stateTarget);
      renderer.setViewport(3, 4, 80, 50);
      renderer.setScissor(5, 6, 70, 40);
      renderer.setScissorTest(true);
      renderer.autoClear = false;
    }
    // Force a real converter draw failure after allocation, without changing
    // the filtering code, then prove state and private GPU allocation recover.
    const draw = renderer.render,
      texturesBeforeFailure = renderer.info.memory.textures;
    renderer.render = () => {
      throw new Error('Original QA conversion failure');
    };
    let failed = false;
    try {
      createMapSkyLighting(renderer, cube, true);
    } catch (error) {
      failed = error instanceof Error && error.message === 'Original QA conversion failure';
    } finally {
      renderer.render = draw;
    }
    const failure = {
      failed,
      restored: JSON.stringify(state()) === JSON.stringify(overriddenBefore),
      texturesBeforeFailure,
      texturesAfterFailure: renderer.info.memory.textures,
      sourceDisposals,
    };
    const capabilityFailures = [],
      gl = renderer.getContext(),
      has = renderer.extensions.has,
      checkFramebufferStatus = gl.checkFramebufferStatus,
      createTexture = gl.createTexture,
      createFramebuffer = gl.createFramebuffer;
    for (const mode of ['missing-extension', 'incomplete-output', 'incomplete-blur']) {
      const before = state(),
        texturesBefore = renderer.info.memory.textures;
      let textureAllocations = 0,
        framebufferAllocations = 0,
        statusQueries = 0,
        error = '';
      renderer.extensions.has = function (name: string) {
        if (
          mode === 'missing-extension' &&
          ['EXT_color_buffer_float', 'EXT_color_buffer_half_float'].includes(name)
        )
          return false;
        return has.call(this, name);
      };
      gl.createTexture = function () {
        textureAllocations++;
        return createTexture.call(this);
      };
      gl.createFramebuffer = function () {
        framebufferAllocations++;
        return createFramebuffer.call(this);
      };
      gl.checkFramebufferStatus = function (target: number) {
        statusQueries++;
        if (
          (mode === 'incomplete-output' && statusQueries === 1) ||
          (mode === 'incomplete-blur' && statusQueries === 2)
        )
          return gl.FRAMEBUFFER_INCOMPLETE_ATTACHMENT;
        return checkFramebufferStatus.call(this, target);
      };
      try {
        const unexpected = createMapSkyLighting(renderer, cube, true);
        unexpected.dispose();
      } catch (failure) {
        error = failure instanceof Error ? failure.message : 'Unexpected failure';
      } finally {
        renderer.extensions.has = has;
        gl.checkFramebufferStatus = checkFramebufferStatus;
        gl.createTexture = createTexture;
        gl.createFramebuffer = createFramebuffer;
      }
      capabilityFailures.push({
        mode,
        error,
        textureAllocations,
        framebufferAllocations,
        statusQueries,
        texturesBefore,
        texturesAfter: renderer.info.memory.textures,
        restored: JSON.stringify(state()) === JSON.stringify(before),
      });
    }
    const defaultFramebuffer = [];
    renderer.setRenderTarget(null);
    renderer.setPixelRatio(1.5);
    renderer.setViewport(0.5, 1.5, 100.5, 50.5);
    renderer.setScissor(2.5, 3.5, 60.5, 40.5);
    renderer.setScissorTest(false);
    for (const rebind of [false, true]) {
      if (rebind) renderer.setRenderTarget(null);
      const before = state(),
        resource = createMapSkyLighting(renderer, cube, true),
        after = state();
      resource.dispose();
      defaultFramebuffer.push({ rebind, before, after });
    }
    renderer.setRenderTarget(null);
    stateTarget.dispose();
    geometry.dispose();
    material.dispose();
    cube.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    return {
      profiles,
      failure,
      originalTextures,
      targetLocalBefore,
      targetLocalAfter,
      beforeState,
      defaultFramebuffer,
      capabilityFailures,
    };
  });
  expect(report.targetLocalBefore.currentViewport).toEqual([7, 8, 90, 40]);
  expect(report.targetLocalBefore.glViewport).toEqual([7, 8, 90, 40]);
  expect(report.targetLocalBefore.glScissor).toEqual([9, 10, 60, 30]);
  expect(report.targetLocalBefore.glScissorTest).toBe(false);
  expect(report.targetLocalBefore.viewport).toEqual([3, 4, 80, 50]);
  expect(report.targetLocalBefore.scissorTest).toBe(true);
  expect(report.targetLocalAfter).toEqual(report.targetLocalBefore);
  for (const scenario of report.defaultFramebuffer) expect(scenario.after).toEqual(scenario.before);
  for (const scenario of report.capabilityFailures) {
    expect(scenario.restored, scenario.mode).toBe(true);
    expect(scenario.texturesAfter, scenario.mode).toBe(scenario.texturesBefore);
    if (scenario.mode === 'missing-extension') {
      expect(scenario.error).toBe('Half-float skylight rendering is unavailable');
      expect(scenario.textureAllocations).toBe(0);
      expect(scenario.framebufferAllocations).toBe(0);
      expect(scenario.statusQueries).toBe(0);
    } else {
      expect(scenario.error).toBe('Skylight framebuffer is incomplete');
      expect(scenario.textureAllocations).toBeGreaterThan(0);
      expect(scenario.statusQueries).toBe(scenario.mode === 'incomplete-output' ? 1 : 2);
    }
  }
  await info.attach('original-skylight-evidence', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  });
  for (const profile of report.profiles) {
    expect(profile.size).toBe(profile.low ? 128 : 256);
    expect(profile.width * profile.height * 8).toBeLessThanOrEqual(
      (profile.low ? 1.5 : 6) * 1024 * 1024,
    );
    expect(profile.restored).toBe(true);
    expect(profile.litPixels).toBeGreaterThan(1000);
    expect(profile.reflectedOrientationPixels).toBeGreaterThan(1000);
    expect(profile.resetPixels).toBe(0);
    expect(profile.sourceDisposals).toBe(0);
    expect(profile.imagesRemainDecoded).toBe(true);
    // The separately retained state target accounts for the one extra texture.
    expect(profile.texturesAfter).toBe(report.originalTextures + 1);
    expect(profile.texturesAfterSingleDispose).toBe(profile.texturesAfter);
  }
  expect(report.failure.failed).toBe(true);
  expect(report.failure.restored).toBe(true);
  expect(report.failure.texturesAfterFailure).toBe(report.failure.texturesBeforeFailure);
  expect(report.failure.sourceDisposals).toBe(0);
  expect(graphicsDiagnostics).toEqual([]);
});

test('skylight hook owns StrictMode generations, cube/quality replacement, failure recovery and unmount', async ({
  page,
}, info) => {
  const graphicsDiagnostics: string[] = [];
  page.on('console', (message) => {
    if (
      ['error', 'warning'].includes(message.type()) &&
      /WebGL|framebuffer|INVALID_|EXT_color_buffer/i.test(message.text())
    )
      graphicsDiagnostics.push(message.text());
  });
  const root = fileURLToPath(new URL('../../', import.meta.url)),
    bundle = await build({
      stdin: {
        contents: `
import React, { StrictMode, useLayoutEffect } from 'react';
import { createRoot, act, context, useStore } from '@react-three/fiber';
import { createRoot as createDOMRoot } from 'react-dom/client';
import { useMapSkyLighting } from './src/useMapSkyLighting';
export async function exercise(renderer, cubes) {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const canvasRoot = createRoot(renderer.domElement);
  await canvasRoot.configure({ gl: renderer, frameloop: 'never', dpr: 1,
    size: { width: 64, height: 64, top: 0, left: 0 } });
  let store;
  function CaptureStore() { store = useStore(); return null; }
  await act(async () => canvasRoot.render(React.createElement(CaptureStore)));
  // React 19 does not replay initial effects for a nested StrictMode under
  // R3F's non-strict Provider. Use a root StrictMode with its actual configured
  // R3F store so this verifies the hook's genuine effect cleanup/reacquisition.
  const container = document.createElement('div');
  document.body.append(container);
  const root = createDOMRoot(container);
  let latest = null;
  const outputs = new Map(), history = [], snapshots = [];
  const setRenderTarget = renderer.setRenderTarget;
  renderer.setRenderTarget = function(target, ...rest) {
    if (target && target.texture.name === 'PMREM.cubeUv' && !outputs.has(target)) {
      const entry = { texture: target.texture, disposed: 0 };
      outputs.set(target, entry);
      target.addEventListener('dispose', () => entry.disposed++);
    }
    return setRenderTarget.call(this, target, ...rest);
  };
  function Probe({ cube, low, label }) {
    const texture = useMapSkyLighting(cube, low);
    useLayoutEffect(() => {
      latest = { texture, label };
      history.push({ label, present: Boolean(texture) });
    }, [texture, label]);
    return null;
  }
  async function update(cube, low, label) {
    await act(async () => {
      root.render(React.createElement(StrictMode, null,
        React.createElement(context.Provider, { value: store },
          React.createElement(Probe, { cube, low, label }))));
    });
    const texture = latest.texture;
    snapshots.push({ label, present: Boolean(texture),
      width: texture?.image.width || 0, height: texture?.image.height || 0,
      textures: renderer.info.memory.textures,
      liveOutputs: [...outputs.values()].filter(entry => entry.disposed === 0).length,
      allocations: outputs.size,
      disposed: [...outputs.values()].filter(entry => entry.disposed > 0).length });
    return texture;
  }
  try {
    const initial = await update(cubes[0], true, 'strict-initial');
    const high = await update(cubes[0], false, 'quality-replacement');
    const nextCube = await update(cubes[1], false, 'cube-replacement');
    const draw = renderer.render;
    renderer.render = () => { throw new Error('Original QA replacement failure'); };
    try { await update(cubes[2], false, 'failed-replacement'); }
    finally { renderer.render = draw; }
    await update(cubes[2], true, 'recovered-quality');
    const has = renderer.extensions.has;
    renderer.extensions.has = function(name) {
      if (['EXT_color_buffer_float', 'EXT_color_buffer_half_float'].includes(name)) return false;
      return has.call(this, name);
    };
    try { await update(cubes[0], true, 'unsupported-half-float'); }
    finally { renderer.extensions.has = has; }
    const gl = renderer.getContext(), status = gl.checkFramebufferStatus;
    gl.checkFramebufferStatus = () => gl.FRAMEBUFFER_INCOMPLETE_ATTACHMENT;
    try { await update(cubes[1], true, 'incomplete-framebuffer'); }
    finally { gl.checkFramebufferStatus = status; }
    await update(cubes[1], false, 'recovered-capability');
    await update(null, true, 'missing-cube');
    const remounted = await update(cubes[0], true, 'new-lease');
    await act(async () => root.render(null));
    snapshots.push({ label: 'unmounted', present: Boolean(latest?.texture),
      textures: renderer.info.memory.textures,
      liveOutputs: [...outputs.values()].filter(entry => entry.disposed === 0).length });
    return { snapshots, history,
      identitiesDistinct: initial !== high && high !== nextCube && remounted !== initial,
      everyOwnedTargetDisposedOnce: [...outputs.values()].every(entry => entry.disposed === 1) };
  } finally {
    renderer.setRenderTarget = setRenderTarget;
    await act(async () => root.unmount());
    await act(async () => canvasRoot.unmount());
    container.remove();
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
}
`,
        resolveDir: root + 'frontend',
      },
      bundle: true,
      write: false,
      format: 'esm',
      external: ['three'],
      define: { 'process.env.NODE_ENV': '"development"' },
    });
  await page.route('**/__qa_sky_hook__/**', async (route) => {
    const name = new URL(route.request().url()).pathname.split('/').pop();
    if (name === 'hook.js')
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
  await page.goto('/__qa_sky_hook__/index.html');
  const report = await page.evaluate(async () => {
    const threeURL = location.origin + '/__qa_sky_hook__/three.module.js',
      hookURL = location.origin + '/__qa_sky_hook__/hook.js',
      T = await import(/* @vite-ignore */ threeURL),
      { exercise } = await import(/* @vite-ignore */ hookURL),
      renderer = new T.WebGLRenderer({ antialias: false });
    renderer.setSize(64, 64);
    document.body.append(renderer.domElement);
    let sourceDisposals = 0;
    const cubes = ['#b07840', '#48ac72', '#5969d3'].map((color) => {
      const images = Array.from({ length: 6 }, () => {
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 256;
          const context = canvas.getContext('2d')!;
          context.fillStyle = color;
          context.fillRect(0, 0, 256, 256);
          return canvas;
        }),
        cube = new T.CubeTexture(images);
      cube.colorSpace = T.SRGBColorSpace;
      cube.needsUpdate = true;
      cube.addEventListener('dispose', () => sourceDisposals++);
      return cube;
    });
    const result = await exercise(renderer, cubes);
    const alive = cubes.every((cube) =>
      cube.images.every((image: HTMLCanvasElement) => image.width === 256 && image.height === 256),
    );
    const disposals = sourceDisposals;
    for (const cube of cubes) cube.dispose();
    return { ...result, sourceDisposals: disposals, sourceImagesRemainDecoded: alive };
  });
  await info.attach('original-skylight-hook-evidence', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  });
  expect(report.identitiesDistinct).toBe(true);
  expect(report.everyOwnedTargetDisposedOnce).toBe(true);
  expect(report.sourceDisposals).toBe(0);
  expect(report.sourceImagesRemainDecoded).toBe(true);
  expect(graphicsDiagnostics).toEqual([]);
  expect(
    report.snapshots.find((item: { label: string }) => item.label === 'unsupported-half-float')
      .allocations,
  ).toBe(
    report.snapshots.find((item: { label: string }) => item.label === 'recovered-quality')
      .allocations,
  );
  const initial = report.snapshots.find(
    (item: { label: string }) => item.label === 'strict-initial',
  );
  // Each filter creates its retained output and one blur temporary. A genuine
  // development StrictMode replay must allocate/release at least two filters.
  expect(initial.allocations).toBeGreaterThanOrEqual(4);
  expect(initial.disposed).toBeGreaterThanOrEqual(3);
  for (const snapshot of report.snapshots) {
    const absent = [
      'failed-replacement',
      'unsupported-half-float',
      'incomplete-framebuffer',
      'missing-cube',
      'unmounted',
    ].includes(snapshot.label);
    expect(snapshot.textures, snapshot.label).toBe(absent ? 0 : 1);
    expect(snapshot.liveOutputs, snapshot.label).toBe(absent ? 0 : 1);
    if (snapshot.label !== 'unmounted') expect(snapshot.present, snapshot.label).toBe(!absent);
  }
  expect(
    report.snapshots.find((item: { label: string }) => item.label === 'quality-replacement').width,
  ).toBe(768);
  expect(
    report.snapshots.find((item: { label: string }) => item.label === 'recovered-quality').width,
  ).toBe(384);
});
