import assert from 'node:assert/strict';
import test from 'node:test';
import { Group, Object3D, Vector3 } from '../../frontend/node_modules/three/build/three.module.js';
import { prepareAgentModel } from '../../frontend/src/agent-model.js';
import { validateAgentAssets } from '../../frontend/src/agent-assets.js';

test('raw S2V agent forward receives exactly one runtime quarter-turn without changing cached source units/pose', () => {
  const source = new Group(),
    forward = new Object3D();
  forward.name = 'qa-native-front';
  forward.position.set(0, 1.2, 1);
  source.add(forward);
  const prepared = prepareAgentModel(source);
  prepared.root.updateMatrixWorld(true);
  const actual = prepared.instance.getObjectByName(forward.name)!.getWorldPosition(new Vector3());
  assert.ok(actual.distanceTo(new Vector3(1, 1.2, 0)) < 1e-10);
  assert.deepEqual(source.rotation.toArray(), [0, 0, 0, 'XYZ']);
  assert.deepEqual(forward.position.toArray(), [0, 1.2, 1]);
  assert.equal(prepared.instance.scale.x, 1);
  assert.equal(prepared.root.scale.x, 1);
});

test('optional native agent discovery accepts only fixed local CT/T URLs and preserves honest missing bodies', () => {
  assert.deepEqual(validateAgentAssets({ ct: null, t: null }), { ct: null, t: null });
  assert.deepEqual(
    validateAgentAssets({ ct: '/map-assets/agents/ct.glb', t: '/map-assets/agents/t.glb' }),
    { ct: '/map-assets/agents/ct.glb', t: '/map-assets/agents/t.glb' },
  );
  for (const value of [
    { ct: 'https://example.com/model.glb', t: null },
    { ct: '/map-assets/agents/t.glb', t: null },
    { ct: '/api/private-data', t: null },
    { ct: null },
  ])
    assert.throws(() => validateAgentAssets(value));
});

test('original skinned QA actor has genuine weighted native-axis geometry after actual GLTF parsing', async () => {
  const { GLTFLoader } =
    await import('../../frontend/node_modules/three-stdlib/loaders/GLTFLoader.js');
  const { originalAgentGLB } = await import('../../frontend/tests/fixtures/original-agent.js');
  const bytes = originalAgentGLB(),
    array = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const gltf = await new Promise<
    import('../../frontend/node_modules/three-stdlib/loaders/GLTFLoader.js').GLTF
  >((resolve, reject) => new GLTFLoader().parse(array, '', resolve, reject));
  const prepared = prepareAgentModel(gltf.scene);
  prepared.root.updateMatrixWorld(true);
  const mesh = prepared.instance.getObjectByName(
    'qa-original-agent-native-front',
  ) as import('../../frontend/node_modules/three/src/Three.js').SkinnedMesh;
  mesh.skeleton.update();
  const points = Array.from({ length: mesh.geometry.attributes.position.count }, (_, index) =>
    mesh.getVertexPosition(index, new Vector3()).applyMatrix4(mesh.matrixWorld),
  );
  assert.ok(Math.abs(Math.min(...points.map((point) => point.x)) - 0.08) < 1e-6);
  assert.ok(Math.abs(Math.max(...points.map((point) => point.x)) - 0.56) < 1e-6);
  assert.ok(Math.abs(Math.min(...points.map((point) => point.y)) - 1.02) < 1e-6);
  assert.ok(Math.abs(Math.max(...points.map((point) => point.z)) - 0.15) < 1e-6);
});

test('cloth agents, their x-ray masks and their corpses share one physical shader setup', async () => {
  const { Mesh, BoxGeometry, MeshStandardMaterial, MeshPhysicalMaterial, Texture } =
    await import('../../frontend/node_modules/three/build/three.module.js');
  const { agentXray } = await import('../../frontend/src/agent-xray.js');
  const packed = new Texture();
  const cloth = new MeshStandardMaterial({
    normalMap: new Texture(),
    roughnessMap: packed,
    metalnessMap: packed,
  });
  cloth.userData.vmat = {
    ShaderName: 'csgo_character.vfx',
    IntParams: { F_CLOTH_SHADING: 1 },
    FloatParams: { g_flSheenScale: 0.5 },
    VectorParams: { g_flSheenTintColor: [0.4, 0.4, 0.4, 1] },
  };
  const source = new Group();
  source.add(new Mesh(new BoxGeometry(), cloth));
  const living = prepareAgentModel(source),
    corpse = prepareAgentModel(source);
  const material = (prepared: ReturnType<typeof prepareAgentModel>) =>
    (prepared.instance.children[0] as InstanceType<typeof Mesh>).material as InstanceType<
      typeof MeshPhysicalMaterial
    >;
  for (const prepared of [living, corpse]) {
    assert.ok(material(prepared) instanceof MeshPhysicalMaterial);
    assert.deepEqual(material(prepared).defines, { STANDARD: '', PHYSICAL: '' });
  }
  const original = material(living);
  const xray = agentXray(living.instance);
  const release = xray.acquire();
  const mask = material(living);
  assert.notEqual(mask, original);
  assert.deepEqual(mask.defines, { STANDARD: '', PHYSICAL: '' });
  // The mask keeps the packed-sample patch, so it compiles the corpse's program.
  assert.equal(mask.onBeforeCompile, original.onBeforeCompile);
  assert.equal(mask.customProgramCacheKey(), material(corpse).customProgramCacheKey());
  assert.match(mask.customProgramCacheKey(), /:packed-mr$/);
  release();
  assert.equal(material(living), original);
});
