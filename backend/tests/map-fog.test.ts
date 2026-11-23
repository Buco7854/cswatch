import assert from 'node:assert/strict';
import test from 'node:test';
import { authoredFog, invalidFogCases } from '../../tools/assets/fixtures/fog-cases.mjs';
import { validateMapCubeFog } from '../../frontend/src/map-fog.js';
import { mapEnvironmentKey } from '../../frontend/src/map-environment.js';
import {
  Group,
  Mesh,
  MeshStandardMaterial,
  CubeTexture,
  FrontSide,
  NoBlending,
} from '../../frontend/node_modules/three/build/three.module.js';
import { installSourceBlackMaterials } from '../../frontend/src/source-black-material.js';
import type { MapCubeFog } from '../../shared/map-assets.js';

test('browser fog validation matches original operator/backend cases and descriptor identity includes fog', () => {
  const fog = authoredFog();
  assert.deepEqual(validateMapCubeFog(fog), fog);
  for (const invalid of invalidFogCases()) assert.throws(() => validateMapCubeFog(invalid));
  const environment = {
    assetVersion: 'original-qa',
    landscape: false,
    sky: {
      faces: ['a', 'b', 'c', 'd', 'e', 'f'] as [string, string, string, string, string, string],
      brightness: 1,
    },
    fog: validateMapCubeFog(fog),
  };
  assert.notEqual(
    mapEnvironmentKey(environment),
    mapEnvironmentKey({ ...environment, fog: { ...environment.fog, maxOpacity: 0.2 } }),
  );
});
test('only exact Source shader metadata gets clone-owned opaque unlit compatibility and disposable live fog uniforms', () => {
  const original = new MeshStandardMaterial({ color: 'white' }),
    other = new MeshStandardMaterial({ color: 'white' }),
    root = new Group(),
    mesh = new Mesh(undefined, original),
    second = new Mesh(undefined, original),
    unrelated = new Mesh(undefined, other);
  original.userData = {
    vmat: {
      Name: 'materials/dev/black_simple.vmat',
      ShaderName: 'csgo_black_unlit.vfx',
      IntParams: { g_bFogEnabled: 1 },
    },
  };
  other.name = 'black_simple';
  root.add(mesh, second, unrelated);
  let state = { fog: null as MapCubeFog | null, cube: null as CubeTexture | null };
  const compatibility = installSourceBlackMaterials([root], () => state),
    material = compatibility.materials[0];
  assert.equal(compatibility.materials.length, 1);
  assert.notEqual(material, original);
  assert.equal(mesh.material, material);
  assert.equal(second.material, material);
  assert.equal(unrelated.material, other);
  assert.equal(original.type, 'MeshStandardMaterial');
  assert.equal(original.color.getHexString(), 'ffffff');
  assert.equal(material.transparent, false);
  assert.equal(material.opacity, 1);
  assert.equal(material.depthTest, true);
  assert.equal(material.depthWrite, true);
  assert.equal(material.side, FrontSide);
  assert.equal(material.blending, NoBlending);
  assert.equal(material.lights, false);
  (material.onBeforeRender as () => void)();
  assert.equal(material.uniforms.sourceFogReady.value, 0);
  state = { fog: validateMapCubeFog(authoredFog()), cube: new CubeTexture() };
  state.cube.images = Array.from({ length: 6 }, () => ({ width: 1024, height: 1024 }));
  (material.onBeforeRender as () => void)();
  assert.equal(material.uniforms.sourceFogReady.value, 1);
  assert.equal(material.uniforms.sourceFogCube.value, state.cube);
  assert.equal(material.uniforms.sourceFogColor.value.w, 7);
  state = { fog: null, cube: null };
  (material.onBeforeRender as () => void)();
  assert.equal(material.uniforms.sourceFogReady.value, 0);
  let disposed = 0;
  material.addEventListener('dispose', () => disposed++);
  compatibility.dispose();
  assert.equal(disposed, 1);
});
