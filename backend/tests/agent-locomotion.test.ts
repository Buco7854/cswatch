import test from 'node:test';
import assert from 'node:assert/strict';
import {
  locomotionWeights,
  recordedLocomotion,
  nativeClipIndices,
  nativeAgentRoles,
  nativeAgentNames,
} from '../../frontend/src/agent-locomotion.js';
import type { Position } from '../../shared/playback.js';
const player = {
  id: '76561198000000001',
  x: 0,
  y: 0,
  z: 0,
  yaw: 0,
  pitch: 0,
  health: 100,
  alive: true,
  team: 3,
  weapon: 'ak47',
} as Position;
test('native locomotion blends normalized five-role weights continuously without runtime history', () => {
  for (const speed of [0, 0.05, 0.2, 0.5, 2, 3, 4, 5, 8, NaN, Infinity])
    for (const duck of [0, 0.25, 0.5, 1, NaN]) {
      const weights = locomotionWeights(speed, duck);
      assert.ok(Object.values(weights).every((v) => Number.isFinite(v) && v >= 0 && v <= 1));
      assert.ok(Math.abs(Object.values(weights).reduce((a, b) => a + b, 0) - 1) < 1e-12);
    }
  assert.equal(locomotionWeights(0, 0).idle, 1);
  assert.equal(locomotionWeights(6, 0).run, 1);
  assert.equal(locomotionWeights(1, 1)['crouch-walk'], 1);
  assert.equal(locomotionWeights(0, 1)['crouch-idle'], 1);
  assert.equal(locomotionWeights(4, 0.5).run, 0.25);
  assert.equal(locomotionWeights(4, 0.5).walk, 0.25);
  const at = locomotionWeights(2, 0.3);
  locomotionWeights(9, 1);
  assert.deepEqual(locomotionWeights(2, 0.3), at);
});
test('motion uses only immutable contiguous horizontal position and recorded duck, never vertical jump guesses', () => {
  const to = { ...player, x: 25, y: 0, z: 999, duck: 1 };
  assert.equal(recordedLocomotion({ ...player, duck: 0 }, to, 0, 8, 64, 0.5).speed, 5.08);
  assert.equal(recordedLocomotion({ ...player, duck: 0 }, to, 0, 8, 64, 0.5).duck, 0.5);
  for (const [other, end] of [
    [{ ...to, id: 'different' }, 8],
    [{ ...to, alive: false }, 8],
    [to, 64],
    [to, 0],
  ] as const)
    assert.equal(recordedLocomotion(player, other, 0, end, 64, 0).speed, 0);
  assert.equal(recordedLocomotion(player, { ...player, z: 100 }, 0, 8, 64, 0).speed, 0);
});
test('exact prepared clip metadata is required and generic or incomplete cycles are not native', () => {
  const clips = nativeAgentRoles.map((role) => ({
    name: nativeAgentNames[role],
    duration: role.includes('idle') ? 0.0333 : 1,
  }));
  const declarations = nativeAgentRoles.map((role) => ({
    name: nativeAgentNames[role],
    extras: {
      cswatch: {
        kind: 'native-locomotion',
        schemaVersion: 1,
        role,
        rootMotion: 'recorded-position',
      },
    },
  }));
  assert.equal(nativeClipIndices(clips, declarations)?.run, 2);
  assert.equal(nativeClipIndices(clips, declarations.slice(1)), undefined);
  assert.equal(nativeClipIndices(clips, [...declarations, declarations[0]]), undefined);
  assert.equal(
    nativeClipIndices(
      clips.map((c) => ({ ...c, duration: NaN })),
      declarations,
    ),
    undefined,
  );
  assert.equal(
    nativeClipIndices(
      clips,
      declarations.map((c) => ({
        ...c,
        extras: { cswatch: { ...c.extras.cswatch, rootMotion: 'native' } },
      })),
    ),
    undefined,
  );
});

test('actual Three native blending samples bone deformation deterministically across back-seeks and instances', async () => {
  const { AnimationClip, AnimationMixer, Bone, Group, VectorKeyframeTrack } =
    await import('../../frontend/node_modules/three/build/three.module.js');
  const { agentAnimation } = await import('../../frontend/src/agent-animation.js');
  const root = new Group(),
    bone = new Bone();
  bone.name = 'native-test-bone';
  root.add(bone);
  const clips = nativeAgentRoles.map(
    (role, index) =>
      new AnimationClip(nativeAgentNames[role], 1, [
        new VectorKeyframeTrack(
          'native-test-bone.position',
          [0, 0.5, 1],
          [0, 0, 0, 0, index + 1, 0, 0, 0, 0],
        ),
      ]),
  );
  const defs = nativeAgentRoles.map((role) => ({
    name: nativeAgentNames[role],
    extras: {
      cswatch: {
        kind: 'native-locomotion',
        schemaVersion: 1,
        role,
        rootMotion: 'recorded-position',
      },
    },
  }));
  const control = agentAnimation(new AnimationMixer(root), clips, defs);
  assert.equal(control.native, true);
  control.sample(0.25, 4, 0.5);
  // standing walk/run contribute.25each, crouchwalk.5: (.25*2+.25*3+.5*5)*.5
  assert.ok(Math.abs(bone.position.y - 1.875) < 1e-8);
  control.sample(71.83, 0, 1);
  control.sample(0.25, 4, 0.5);
  assert.ok(Math.abs(bone.position.y - 1.875) < 1e-8);
  const another = root.clone(true),
    otherbone = another.getObjectByName('native-test-bone')!;
  const other = agentAnimation(new AnimationMixer(another), clips, defs);
  other.sample(0.25, 0, 0);
  assert.ok(Math.abs(otherbone.position.y - 0.5) < 1e-8);
  assert.ok(Math.abs(bone.position.y - 1.875) < 1e-8);
  assert.deepEqual(root.position.toArray(), [0, 0, 0]);
  control.stop();
  other.stop();
});

test('original embedded glTF cycle metadata and actual skinned bone tracks survive the production loader contract', async () => {
  const { GLTFLoader } =
    await import('../../frontend/node_modules/three-stdlib/loaders/GLTFLoader.js');
  const { AnimationMixer } =
    await import('../../frontend/node_modules/three/build/three.module.js');
  const { originalAnimatedAgentGLB } =
    await import('../../frontend/tests/fixtures/original-agent.js');
  const { prepareAgentModel } = await import('../../frontend/src/agent-model.js');
  const { agentAnimation } = await import('../../frontend/src/agent-animation.js');
  const { disposeEquipmentInstance } = await import('../../frontend/src/equipment-model.js');
  const bytes = originalAnimatedAgentGLB();
  const gltf = await new Promise<
    import('../../frontend/node_modules/three-stdlib/loaders/GLTFLoader.js').GLTF
  >((resolve, reject) =>
    new GLTFLoader().parse(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
      '',
      resolve,
      reject,
    ),
  );
  const model = prepareAgentModel(gltf.scene),
    mixer = new AnimationMixer(model.instance),
    control = agentAnimation(mixer, gltf.animations, gltf.parser.json.animations);
  assert.equal(control.native, true);
  assert.equal(gltf.animations.length, 5);
  control.sample(0.25, 1.6256, 0);
  assert.ok(
    Math.abs(model.instance.getObjectByName('qa-original-agent-bone')!.position.y - 0.04) < 1e-7,
  );
  control.sample(2.25, 0, 1);
  assert.ok(
    Math.abs(model.instance.getObjectByName('qa-original-agent-bone')!.position.y + 0.6) < 1e-7,
  );
  control.sample(0.25, 1.6256, 0);
  assert.ok(
    Math.abs(model.instance.getObjectByName('qa-original-agent-bone')!.position.y - 0.04) < 1e-7,
  );
  assert.deepEqual(
    gltf.scene.getObjectByName('qa-original-agent-bone')!.position.toArray(),
    [0, 0, 0],
  );
  control.stop();
  mixer.uncacheRoot(model.instance);
  disposeEquipmentInstance(model.root);
});
