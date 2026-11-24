import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { triangle } from '../../tools/assets/fixtures/embedded-glb.mjs';

test('prepared water transmits the bed at the authored angles in a single color draw', async ({
  page,
}) => {
  const bundle = await build({
    stdin: {
      contents: `export * as T from 'three';
    export { GLTFLoader } from 'three-stdlib';
    export { registerMapBakedLighting } from './src/map-baked-lighting';
    export { cloneMapModel } from './src/map-model';`,
      resolveDir: fileURLToPath(new URL('../', import.meta.url)),
    },
    bundle: true,
    write: false,
    format: 'esm',
  });
  const glb = triangle((d) => {
    d.extensionsUsed = ['KHR_materials_ior'];
    d.materials = [
      {
        doubleSided: true,
        alphaMode: 'BLEND',
        pbrMetallicRoughness: {
          baseColorFactor: [0.1, 0.2, 0.3, 0.25],
          metallicFactor: 0,
          roughnessFactor: 0.2,
        },
        extensions: { KHR_materials_ior: { ior: 1.5 } },
        extras: {
          vmat: { ShaderName: 'csgo_water_fancy.vfx' },
          cswatch: { water: { schemaVersion: 1, reflectance: 0.04, exponent: 6 } },
        },
      },
    ];
    d.meshes[0].primitives[0].material = 0;
  });
  await page.route('**/__water__/**', (route) => {
    const url = route.request().url();
    return route.fulfill(
      url.endsWith('.js')
        ? { contentType: 'text/javascript', body: bundle.outputFiles[0].text }
        : url.endsWith('.glb')
          ? { contentType: 'model/gltf-binary', body: glb }
          : { contentType: 'text/html', body: '<canvas></canvas>' },
    );
  });
  await page.goto('/__water__/index.html');
  const result = await page.evaluate(async () => {
    const { T, GLTFLoader, registerMapBakedLighting, cloneMapModel } = await import(
      /* @vite-ignore */ location.origin + '/__water__/bundle.js'
    );
    const loader = new GLTFLoader();
    registerMapBakedLighting(loader);
    const model = cloneMapModel((await loader.loadAsync('/__water__/test.glb')).scene);
    const water = model.children[0],
      mat = water.material;
    water.geometry.dispose();
    water.geometry = new T.PlaneGeometry(4, 4);
    const renderer = new T.WebGLRenderer({ canvas: document.querySelector('canvas') });
    const target = new T.WebGLRenderTarget(48, 48);
    renderer.setRenderTarget(target);
    const scene = new T.Scene(),
      camera = new T.OrthographicCamera(-1, 1, 1, -1, 0.1, 20);
    scene.add(model);
    scene.background = new T.Color(1, 1, 1);
    camera.position.z = 5;
    function sample(rotation: number) {
      water.rotation.y = rotation;
      renderer.render(scene, camera);
      const pixel = new Uint8Array(4);
      renderer.readRenderTargetPixels(target, 24, 24, 1, 1, pixel);
      return { transmitted: pixel[0] / 255, draws: renderer.info.render.calls };
    }
    const front = sample(0),
      oblique = sample(Math.PI * 0.4);
    water.visible = false;
    const omitted = sample(0);
    return {
      front,
      oblique,
      omitted,
      casts: water.castShadow,
      depthWrite: mat.depthWrite,
      single: mat.forceSinglePass,
      transmission: mat.transmission,
    };
  });
  expect(result.front.transmitted).toBeCloseTo(0.75 * 0.96, 2);
  expect(result.oblique.transmitted).toBeCloseTo(
    0.75 * 0.96 * (1 - (1 - Math.cos(Math.PI * 0.4)) ** 6),
    2,
  );
  expect(result.front.draws).toBe(1);
  expect(result.oblique.draws).toBe(1);
  expect(result.omitted).toEqual({ transmitted: 1, draws: 0 });
  expect(result.casts).toBe(false);
  expect(result.depthWrite).toBe(false);
  expect(result.single).toBe(true);
  expect(result.transmission).toBe(0);
});
