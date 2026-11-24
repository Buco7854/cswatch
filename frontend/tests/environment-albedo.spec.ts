import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

test('exported environment paint uses the native vertex weights and requires its declared UV', async ({
  page,
}) => {
  const bundle = await build({
    stdin: {
      contents: `export * as T from 'three';
        export {GLTFLoader, GLTFExporter} from 'three-stdlib';
        export {registerEnvironmentAlbedo, applyEnvironmentAlbedo} from './src/environment-albedo';`,
      resolveDir: fileURLToPath(new URL('../', import.meta.url)),
    },
    bundle: true,
    write: false,
    format: 'esm',
  });
  await page.route('**/__environment_test__/**', (route) =>
    route.fulfill(
      route.request().url().endsWith('.js')
        ? { contentType: 'text/javascript', body: bundle.outputFiles[0].text }
        : { contentType: 'text/html', body: '<canvas></canvas>' },
    ),
  );
  await page.goto('/__environment_test__/');
  const samples = await page.evaluate(async () => {
    const { T, GLTFLoader, GLTFExporter, registerEnvironmentAlbedo, applyEnvironmentAlbedo } =
      await import('/__environment_test__/lib.js' as string);
    const geometry = new T.PlaneGeometry(2, 2);
    const paint = new Float32Array(4 * geometry.attributes.position.count);
    geometry.setAttribute('paint', new T.BufferAttribute(paint, 4));
    const source = new T.Mesh(geometry, new T.MeshStandardMaterial());
    const gltf = await new GLTFExporter().parseAsync(source);
    const attributes = gltf.meshes[0].primitives[0].attributes;
    attributes._TEXCOORD_4 = attributes._PAINT;
    delete attributes._PAINT;
    gltf.extensionsUsed = ['CSWATCH_environment_albedo'];
    gltf.images = ['#b81010', '#808080', '#10bb10'].map((color) => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      return { uri: canvas.toDataURL() };
    });
    gltf.textures = [0, 1, 2].map((index) => ({ source: index }));
    const layer = {
      uv: [1, 0, 0, 1, 0, 0],
      channel: 1,
      values: [1, 0.5, 0.01, 1, 0, 0, 1, 0.5, 0.1],
      facing: [0, 0, 0],
    };
    gltf.materials[0] = {
      pbrMetallicRoughness: {
        baseColorTexture: { index: 0 },
        metallicFactor: 0,
        roughnessFactor: 1,
      },
      extensions: {
        CSWATCH_environment_albedo: {
          schemaVersion: 1,
          baseHeight: { index: 1 },
          paintLayer2: { index: 2 },
          parameters: {
            baseOnlyOverlay: false,
            base: [1, 0.5],
            modern: true,
            secondaryAttribute: false,
            layers: [layer],
          },
        },
      },
    };
    const renderer = new T.WebGLRenderer({ canvas: document.querySelector('canvas') });
    renderer.setSize(12, 12, false);
    const scene = new T.Scene();
    scene.add(new T.AmbientLight(0xffffff, Math.PI));
    const camera = new T.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    camera.position.z = 2;
    const gl = renderer.getContext(),
      results = [];
    for (const channel of [1, 2]) {
      layer.channel = channel;
      const loader = new GLTFLoader();
      registerEnvironmentAlbedo(loader);
      const model = await loader.parseAsync(JSON.stringify(gltf), '');
      applyEnvironmentAlbedo(model);
      scene.add(model.scene);
      const weights = model.scene.children[0].geometry.getAttribute('_texcoord_4');
      for (const weight of [0, 1]) {
        for (let i = 0; i < weights.count; i++) weights.setXYZW(i, weight, 0, 0, 0.15);
        weights.needsUpdate = true;
        renderer.render(scene, camera);
        const pixel = new Uint8Array(4);
        gl.readPixels(6, 6, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        results.push([...pixel]);
      }
      scene.remove(model.scene);
    }
    renderer.dispose();
    return results;
  });
  const [base, painted, invalidBase, invalidPaint] = samples;
  expect(base[0]).toBeGreaterThan(base[1] + 100);
  expect(painted[1]).toBeGreaterThan(painted[0] + 100);
  expect(invalidBase).toEqual(base);
  expect(invalidPaint).toEqual(base);
});
