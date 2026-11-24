import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

test('packed world material keeps all three PBR channels and an independent occlusion UV', async ({
  page,
}) => {
  const bundle = await build({
    stdin: {
      contents:
        "export * as T from 'three'; export { reusePackedMapSamples } from './src/map-packed-material';",
      resolveDir: fileURLToPath(new URL('../', import.meta.url)),
    },
    bundle: true,
    write: false,
    format: 'esm',
  });
  await page.route('**/__packed_map__/**', (route) =>
    route.fulfill(
      route.request().url().endsWith('.js')
        ? { contentType: 'text/javascript', body: bundle.outputFiles[0].text }
        : { contentType: 'text/html', body: '<canvas></canvas>' },
    ),
  );
  await page.goto('/__packed_map__/');
  const results = await page.evaluate(async () => {
    const { T, reusePackedMapSamples } = await import(
      /* @vite-ignore */ '/__packed_map__/lib.js' as string
    );
    const renderer = new T.WebGLRenderer({
      canvas: document.querySelector('canvas'),
      antialias: false,
    });
    const target = new T.WebGLRenderTarget(48, 48);
    renderer.setSize(48, 48);
    renderer.setRenderTarget(target);
    const camera = new T.PerspectiveCamera(45, 1, 0.1, 10);
    camera.position.z = 2;
    const texture = new T.DataTexture(new Uint8Array([10, 70, 230, 255, 245, 205, 20, 255]), 2, 1);
    texture.needsUpdate = true;
    const shifted = texture.clone();
    shifted.offset.x = 0.5;
    shifted.wrapS = T.RepeatWrapping;
    const results = [];
    for (const [metal, ao] of [
      [texture, texture],
      [texture, shifted],
      [shifted, texture],
    ]) {
      const scene = new T.Scene();
      const mat = new T.MeshStandardMaterial({
        aoMap: ao,
        roughnessMap: texture,
        metalnessMap: metal,
        metalness: 0.8,
        roughness: 0.7,
      });
      // Source lighting adds work after the AO chunk on materials with a baked atlas.
      mat.onBeforeCompile = (shader: { fragmentShader: string }) => {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <aomap_fragment>',
          '#include <aomap_fragment>\nreflectedLight.directDiffuse *= ambientOcclusion;',
        );
      };
      mat.customProgramCacheKey = () => 'test-baked-ao';
      const mesh = new T.Mesh(new T.PlaneGeometry(2, 2), mat);
      const sun = new T.DirectionalLight(0xffffff, 1.8);
      sun.position.set(2, 1, 2);
      scene.add(mesh, sun, new T.HemisphereLight(0xffffff, 0x404040, 0.8));
      const sample = () => {
        renderer.render(scene, camera);
        const data = new Uint8Array(48 * 48 * 4);
        renderer.readRenderTargetPixels(target, 0, 0, 48, 48, data);
        const gl = renderer.getContext(),
          p = gl.getParameter(gl.CURRENT_PROGRAM);
        const uniforms = ['roughnessMap', 'metalnessMap', 'aoMap'].filter(
          (name) => gl.getUniformLocation(p, name) !== null,
        );
        return { data, uniforms };
      };
      const before = sample();
      reusePackedMapSamples([scene]);
      mat.needsUpdate = true;
      const after = sample();
      results.push({
        before: before.uniforms,
        after: after.uniforms,
        equal: after.data.every((v, i) => v === before.data[i]),
        left: after.data[(24 * 48 + 12) * 4],
        right: after.data[(24 * 48 + 36) * 4],
      });
      mat.dispose();
      mesh.geometry.dispose();
    }
    target.dispose();
    texture.dispose();
    shifted.dispose();
    renderer.dispose();
    return results;
  });
  for (const result of results) {
    expect(result.before).toEqual(['roughnessMap', 'metalnessMap', 'aoMap']);
    expect(result.equal).toBe(true);
    expect(result.left).not.toBe(result.right);
  }
  expect(results[0].after).toEqual(['roughnessMap']);
  expect(results[1].after).toEqual(['roughnessMap', 'aoMap']);
  expect(results[2].after).toEqual(['roughnessMap', 'metalnessMap', 'aoMap']);
  expect(results[0].left).not.toBe(results[1].left);
});
