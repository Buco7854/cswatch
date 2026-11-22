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
