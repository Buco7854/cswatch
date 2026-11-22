import test from 'node:test';
import assert from 'node:assert/strict';
import { Document } from '@gltf-transform/core';
import contract from '../../shared/agent-animation.json' with { type: 'json' };
import {
  directionalRoles,
  directionalMovementRoles,
} from '../../shared/agent-animation-contract.mjs';
import { inverseRigid } from './agent-retarget.mjs';
import { retargetAgentAnimations } from './retarget-agent-animations.mjs';

function fixture({ animated = false, extra = false, stride } = {}) {
  const document = new Document(),
    buffer = document.createBuffer(),
    scene = document.createScene(),
    motion = document.createNode('root_motion'),
    pelvis = document.createNode('pelvis').setTranslation([0, 1, 0]),
    hand = document.createNode('hand').setTranslation([0.3, 0.3, 0]),
    between = extra ? document.createNode('target_only').setTranslation([0, 0.1, 0]) : null;
  scene.addChild(motion);
  motion.addChild(pelvis);
  if (between) {
    pelvis.addChild(between);
    between.addChild(hand);
  } else pelvis.addChild(hand);
  const feet = stride
    ? ['ball_L', 'ball_R'].map((name, i) => {
        const node = document.createNode(name).setTranslation([0.1 - i * 0.2, 0, 0]);
        motion.addChild(node);
        return node;
      })
    : [];
  const joints = [motion, pelvis, hand, ...(between ? [between] : []), ...feet],
    create = (type, array) =>
      document.createAccessor().setType(type).setArray(array).setBuffer(buffer),
    skin = document
      .createSkin()
      .setInverseBindMatrices(
        create(
          'MAT4',
          new Float32Array(joints.flatMap((joint) => inverseRigid(joint.getWorldMatrix()))),
        ),
      );
  for (const joint of joints) skin.addJoint(joint);
  const mesh = document.createMesh().addPrimitive(
    document
      .createPrimitive()
      .setAttribute('POSITION', create('VEC3', new Float32Array([0, 1, 0, 0.3, 1.3, 0, 0, 1.8, 0])))
      .setAttribute(
        'JOINTS_0',
        create('VEC4', new Uint8Array([1, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0])),
      )
      .setAttribute(
        'WEIGHTS_0',
        create('VEC4', new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])),
      ),
  );
  scene.addChild(document.createNode('original_weighted_mesh').setMesh(mesh).setSkin(skin));
  if (animated) {
    const animation = document.createAnimation('original_native_clip'),
      input = create('SCALAR', new Float32Array([0, 1]));
    const [x, z] = stride ?? [10, 0];
    for (const [node, path, values] of [
      [motion, 'translation', [0, 0, 0, x, 0, z]],
      [pelvis, 'translation', [0, 1, 0, 0, 1.1, 0]],
      [hand, 'rotation', [0, 0, 0, 1, 0, 0, Math.SQRT1_2, Math.SQRT1_2]],
      [motion, 'rotation', [0, 0, 0, 1, 0, Math.SQRT1_2, 0, Math.SQRT1_2]],
    ]) {
      const output = create(path === 'rotation' ? 'VEC4' : 'VEC3', new Float32Array(values)),
        sampler = document
          .createAnimationSampler()
          .setInput(input)
          .setOutput(output)
          .setInterpolation('LINEAR'),
        channel = document
          .createAnimationChannel()
          .setTargetNode(node)
          .setTargetPath(path)
          .setSampler(sampler);
      animation.addSampler(sampler).addChannel(channel);
    }
  }
  return { document, motion, pelvis, hand, between };
}
const fixtureClips = ({ staticPoses = false } = {}) =>
  Object.fromEntries(
    directionalRoles.map((role) => {
      const moving = directionalMovementRoles.has(role);
      const angle = (contract.directions.indexOf(role.split('-').at(-1)) * Math.PI) / 4;
      const { document } = fixture({
        animated: true,
        stride: moving ? [Math.sin(angle) * 2, Math.cos(angle) * 2] : undefined,
      });
      if (staticPoses && !moving)
        for (const sampler of document.getRoot().listAnimations()[0].listSamplers()) {
          const output = sampler.getOutput();
          output.setElement(1, output.getElement(0, []));
        }
      return [role, document];
    }),
  );

test('native cycles preserve named world deformation across different hierarchies while recorded position owns travel', () => {
  const target = fixture({ extra: true }),
    result = retargetAgentAnimations(target.document, fixtureClips(), { minimumMappedBones: 3 });
  assert.equal(result.pose, 'directional-native-agent');
  assert.equal(result.totalSamples, 174);
  assert.deepEqual(
    result.clips.map((clip) => clip.name),
    directionalRoles.map((role) => `cswatch:${role}`),
  );
  assert.equal(
    result.clips.every((clip) => clip.mappedBones === 3),
    true,
  );
  assert.equal(
    result.clips.every(
      (clip) =>
        Math.abs(clip.nativeGroundSpeed - (directionalMovementRoles.has(clip.role) ? 2 : 10)) <
        1e-6,
    ),
    true,
  );
  assert.ok(result.sampledBounds.max[0] < 1, 'native 10m travel must not be applied twice');
  const animation = target.document.getRoot().listAnimations()[0];
  for (const channel of animation.listChannels()) {
    const output = channel.getSampler().getOutput(),
      value = output.getElement(output.getCount() - 1, []),
      node = channel.getTargetNode();
    if (channel.getTargetPath() === 'translation') node.setTranslation(value);
    else if (channel.getTargetPath() === 'rotation') node.setRotation(value);
    else node.setScale(value);
  }
  assert.ok(Math.abs(target.motion.getTranslation()[0]) < 1e-6);
  assert.ok(
    Math.abs(target.motion.getWorldMatrix()[0] - 1) < 1e-6,
    'native root yaw does not rotate recorded aim twice',
  );
  assert.ok(Math.abs(target.pelvis.getWorldMatrix()[13] - 1.1) < 0.0001);
  assert.ok(Math.abs(target.hand.getWorldMatrix()[12] - 0.3) < 0.0001);
  assert.ok(Math.abs(target.hand.getWorldMatrix()[13] - 1.4) < 0.0001);
  assert.ok(Math.abs(target.hand.getWorldMatrix()[0]) < 0.0001, 'genuine hand rotation retained');
  assert.deepEqual(target.between.getTranslation(), [0, 0.1, 0]);
});

test('native animation rejects missing roles, uncomposed deltas and unsupported channels rather than inventing motion', () => {
  assert.throws(() => retargetAgentAnimations(fixture().document, {}), /complete/);
  const delta = fixtureClips();
  delta['rifle-idle']
    .getRoot()
    .listAnimations()[0]
    .setExtras({ additive: true, additive_composed: false });
  assert.throws(
    () => retargetAgentAnimations(fixture().document, delta, { minimumMappedBones: 3 }),
    /delta/,
  );
  const unsupported = fixtureClips();
  unsupported['rifle-idle']
    .getRoot()
    .listAnimations()[0]
    .listSamplers()[0]
    .setInterpolation('CUBICSPLINE');
  assert.throws(
    () => retargetAgentAnimations(fixture().document, unsupported, { minimumMappedBones: 3 }),
    /channel/,
  );
});

test('native animation bounds time, duplicate channels, non-rigid poses and total decoded track allocation', () => {
  for (const modify of [
    (clip) =>
      clip
        .getRoot()
        .listAnimations()[0]
        .listSamplers()[0]
        .getInput()
        .setArray(new Float32Array([0, 31])),
    (clip) =>
      clip
        .getRoot()
        .listAnimations()[0]
        .listSamplers()[0]
        .getInput()
        .setArray(new Float32Array([0, 0])),
    (clip) =>
      clip
        .getRoot()
        .listAnimations()[0]
        .listSamplers()[2]
        .getOutput()
        .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 2, 2])),
    (clip) => {
      const animation = clip.getRoot().listAnimations()[0],
        original = animation.listChannels()[0];
      animation.addChannel(
        clip
          .createAnimationChannel()
          .setTargetNode(original.getTargetNode())
          .setTargetPath(original.getTargetPath())
          .setSampler(original.getSampler()),
      );
    },
  ]) {
    const clips = fixtureClips();
    modify(clips['rifle-idle']);
    assert.throws(
      () => retargetAgentAnimations(fixture().document, clips, { minimumMappedBones: 3 }),
      /invalid|ambiguous/,
    );
  }
  const clips = fixtureClips(),
    count = 2049;
  clips['rifle-idle']
    .getRoot()
    .listAnimations()[0]
    .listSamplers()[0]
    .getInput()
    .setArray(new Float32Array(Array.from({ length: count }, (_, index) => index / count)));
  assert.throws(
    () => retargetAgentAnimations(fixture().document, clips, { minimumMappedBones: 3 }),
    /channel/,
  );
  const oversized = fixture();
  oversized.document
    .createAccessor()
    .setType('SCALAR')
    .setArray(new Float32Array(2 * 1024 ** 2))
    .setBuffer(oversized.document.getRoot().listBuffers()[0]);
  assert.throws(
    () => retargetAgentAnimations(oversized.document, fixtureClips(), { minimumMappedBones: 3 }),
    /allocation/,
  );
});

test('directional packs preserve the positive duration of entirely static poses', () => {
  const target = fixture().document;
  const result = retargetAgentAnimations(target, fixtureClips({ staticPoses: true }), {
    minimumMappedBones: 3,
  });
  assert.equal(result.schemaVersion, 2);
  const idle = target
    .getRoot()
    .listAnimations()
    .find((animation) => animation.getName() === 'cswatch:rifle-idle');
  assert.ok(idle.listSamplers().some((sampler) => sampler.getInput().getCount() === 2));
  assert.ok(idle.listSamplers().some((sampler) => sampler.getInput().getCount() === 1));
  assert.ok(
    result.clips
      .filter(({ role }) => directionalMovementRoles.has(role))
      .every(({ strideMeters }) => Math.abs(strideMeters - 2) < 1e-6),
  );
});
