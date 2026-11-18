import assert from 'node:assert/strict';
import test from 'node:test';
import { authoredFog, invalidFogCases } from '../../tools/assets/fixtures/fog-cases.mjs';
import { cubeFogAmount, cubeFogDirection, validateMapCubeFog } from '../../frontend/src/map-fog.js';
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

const identity: [number, number, number, number, number, number, number, number, number] = [
  1, 0, 0, 0, 1, 0, 0, 0, 1,
];
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
test('authored cube fog uses distance and signed height powers in expanded main-world meters', () => {
  const fog: MapCubeFog = {
      blend: 'multiply',
      start: 0,
      end: 20,
      exponent: 2,
      height: { start: 0, end: 20, exponent: 1 },
      maxOpacity: 0.8,
      lodBias: 0,
      brightness: 1,
      rotation: identity,
    },
    point = { x: 10, y: 10, z: 0 },
    camera = { x: 0, y: 10, z: 0 };
  assert.equal(cubeFogAmount(fog, point, camera), 0.1);
  assert.equal(cubeFogAmount({ ...fog, height: null }, point, camera), 0.2);
  assert.equal(
    cubeFogAmount({ ...fog, height: { start: 20, end: 0, exponent: 1 } }, point, camera),
    0.1,
  );
  assert.equal(cubeFogAmount(fog, { x: 0, y: 20, z: 0 }, camera), 0);
  assert.equal(cubeFogAmount(fog, camera, camera), 0);
  const scale = 16,
    origin = { x: 3, y: 4, z: 5 },
    tiny = (point: { x: number; y: number; z: number }) => ({
      x: point.x / scale + origin.x,
      y: point.y / scale + origin.y,
      z: point.z / scale + origin.z,
    }),
    adjusted = {
      ...fog,
      start: fog.start / scale,
      end: fog.end / scale,
      height: {
        ...fog.height!,
        start: fog.height!.start / scale + origin.y,
        end: fog.height!.end / scale + origin.y,
      },
    };
  assert.equal(
    cubeFogAmount(adjusted, tiny(point), tiny(camera)),
    cubeFogAmount(fog, point, camera),
  );
  assert.deepEqual(cubeFogDirection(fog, { x: 1, y: 0, z: 0 }), { x: -1, y: 0, z: 0 });
  assert.deepEqual(
    cubeFogDirection({ ...fog, rotation: [0, 0, -1, 0, 1, 0, 1, 0, 0] }, { x: 1, y: 0, z: 0 }),
    { x: -0, y: 0, z: -1 },
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
