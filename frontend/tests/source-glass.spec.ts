import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

test('a verified dust mask transmits the view through a door pane and keeps its solid frame', async ({
  page,
}) => {
  const bundle = await build({
    stdin: {
      contents: `export * as T from 'three';
        export { cloneMapModel } from './src/map-model';
        export { applyPreparedGlass } from './src/source-glass-material';`,
      resolveDir: fileURLToPath(new URL('../', import.meta.url)),
    },
    bundle: true,
    write: false,
    format: 'esm',
  });
  await page.route('**/__qa_glass__/**', (route) =>
    route.request().url().endsWith('.js')
      ? route.fulfill({ contentType: 'text/javascript', body: bundle.outputFiles[0].text })
      : route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Glass</title>' }),
  );
  await page.goto('/__qa_glass__/index.html');
  const result = await page.evaluate(async () => {
    const { T, cloneMapModel, applyPreparedGlass } = await import(
      /* @vite-ignore */ location.origin + '/__qa_glass__/fixture.js'
    );
    const gl = new T.WebGLRenderer(),
      target = new T.WebGLRenderTarget(64, 64);
    const scene = new T.Scene(),
      camera = new T.OrthographicCamera(-1, 1, 1, -1, 0.1, 20);
    camera.position.z = 5;
    const surface = new T.PlaneGeometry(1.8, 1.8);
    const material = new T.MeshStandardMaterial({ transparent: true, depthWrite: false });
    // This legacy S2V material has no prepared optical data.
    material.userData.vmat = {
      ShaderName: 'csgo_glass.vfx',
      IntParams: { F_DO_NOT_CAST_SHADOWS: 1 },
    };
    const leaf = new T.MeshStandardMaterial({ color: 0x305090 });
    const glass = new T.Mesh(surface, material);
    scene.add(glass);
    const color = () => {
      const center = new Uint8Array(4);
      gl.setRenderTarget(target);
      gl.render(scene, camera);
      gl.readRenderTargetPixels(target, 32, 32, 1, 1, center);
      return center[1];
    };
    scene.background = new T.Color(0, 1, 0);
    const before = color();
    const legacy = material.clone();
    applyPreparedGlass(legacy);
    material.userData.cswatch = { constantGlass: { schemaVersion: 1, castsShadow: false } };
    material.opacity = 13 / 255;
    material.metalness = 0;
    const hooked = material.clone(),
      originalHook = () => {};
    hooked.onBeforeCompile = originalHook;
    const future = material.clone();
    future.userData.cswatch.constantGlass.schemaVersion = 2;
    for (const item of [material, hooked, future, leaf]) applyPreparedGlass(item);
    const after = color();
    glass.rotation.y = Math.PI * 0.4;
    const oblique = color();
    glass.visible = false;
    const unobstructed = color();
    const group = new T.Group();
    group.add(glass, new T.Mesh(surface, leaf), new T.Mesh(surface, [material, leaf]));
    const [pane, frame, mixed] = cloneMapModel(group).children;
    const evidence = {
      before,
      after,
      oblique,
      unobstructed,
      alpha: material.opacity,
      fallback: [
        legacy.opacity,
        legacy.onBeforeCompile === T.Material.prototype.onBeforeCompile,
        future.onBeforeCompile === T.Material.prototype.onBeforeCompile,
        hooked.onBeforeCompile === originalHook,
        leaf.opacity,
      ],
      shadows: [pane.castShadow, frame.castShadow, mixed.castShadow],
    };
    target.dispose();
    gl.dispose();
    return evidence;
  });
  expect(result.before).toBe(0);
  expect(result.alpha).toBeCloseTo(13 / 255);
  expect(result.after / result.unobstructed).toBeCloseTo(0.96 * (1 - 13 / 255), 2);
  const obliqueTransmission =
    0.96 * (1 - Math.pow(1 - Math.cos(Math.PI * 0.4), 5)) * (1 - 13 / 255);
  expect(result.oblique / result.unobstructed).toBeCloseTo(obliqueTransmission, 2);
  expect(result.fallback).toEqual([1, true, true, true, 1]);
  expect(result.shadows).toEqual([false, true, true]);
});
