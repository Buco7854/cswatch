import test from 'node:test';
import assert from 'node:assert/strict';
import { Document } from '@gltf-transform/core';
import { poseAgentIdle } from './pose-agent-idle.mjs';
function skeleton({ animation = false, extra = false } = {}) {
  const doc = new Document(),
    buffer = doc.createBuffer(),
    scene = doc.createScene(),
    root = doc.createNode('root'),
    hand = doc.createNode('hand').setTranslation([0, 1, 0]);
  root.addChild(hand);
  scene.addChild(root);
  const joints = [root, hand];
  if (extra) {
    const finger = doc.createNode('finger').setTranslation([0, 0.1, 0]);
    hand.addChild(finger);
    joints.push(finger);
  }
  const skin = doc.createSkin();
  for (const node of joints) skin.addJoint(node);
  if (animation) {
    const times = doc
        .createAccessor()
        .setType('SCALAR')
        .setArray(new Float32Array([0, 1]))
        .setBuffer(buffer),
      positions = doc
        .createAccessor()
        .setType('VEC3')
        .setArray(new Float32Array([0.4, 0.8, 0, 0.4, 0.8, 0]))
        .setBuffer(buffer),
      sampler = doc
        .createAnimationSampler()
        .setInterpolation('LINEAR')
        .setInput(times)
        .setOutput(positions),
      channel = doc
        .createAnimationChannel()
        .setSampler(sampler)
        .setTargetNode(hand)
        .setTargetPath('translation');
    doc.createAnimation('authored_idle').addSampler(sampler).addChannel(channel);
  }
  return doc;
}
test('static idle reproduces exact mapped world poses while untracked bones follow authored bind transforms', () => {
  const target = skeleton({ extra: true }),
    source = skeleton({ animation: true });
  const result = poseAgentIdle(target, source, { minimumMappedBones: 2 });
  assert.equal(result.mappedBones, 2);
  assert.equal(result.pose, 'approximate-static-native-idle');
  const hand = target
      .getRoot()
      .listNodes()
      .find((x) => x.getName() === 'hand'),
    finger = target
      .getRoot()
      .listNodes()
      .find((x) => x.getName() === 'finger');
  assert.ok(Math.abs(hand.getWorldMatrix()[12] - 0.4) < 1e-6);
  assert.ok(Math.abs(hand.getWorldMatrix()[13] - 0.8) < 1e-6);
  assert.ok(Math.abs(finger.getWorldMatrix()[13] - 0.9) < 1e-6);
  assert.equal(target.getRoot().listAnimations().length, 0);
});
test('static idle rejects missing/unmatched clips and non-rigid source poses rather than displaying a guessed pose', () => {
  assert.throws(() => poseAgentIdle(skeleton(), skeleton(), { minimumMappedBones: 2 }), /clip/);
  assert.throws(
    () => poseAgentIdle(skeleton(), skeleton({ animation: true }), { minimumMappedBones: 20 }),
    /matching/,
  );
  const scaled = skeleton({ animation: true });
  scaled
    .getRoot()
    .listNodes()
    .find((x) => x.getName() === 'root')
    .setScale([2, 1, 1]);
  assert.throws(() => poseAgentIdle(skeleton(), scaled, { minimumMappedBones: 2 }), /non-rigid/);
});
test('native float32 quaternion drift does not accumulate through deep retargeted finger hierarchies', () => {
  const build = (animated) => {
    const doc = new Document(),
      scene = doc.createScene(),
      buffer = doc.createBuffer(),
      skin = doc.createSkin(),
      nodes = [];
    for (let i = 0; i < 20; i++) {
      const node = doc
        .createNode('rounded_bone_' + i)
        .setTranslation([0.01, 0.05, 0])
        .setRotation([0, 0, 0.707107, 0.707107]);
      if (i) nodes[i - 1].addChild(node);
      else scene.addChild(node);
      nodes.push(node);
      skin.addJoint(node);
    }
    if (animated) {
      const input = doc
          .createAccessor()
          .setType('SCALAR')
          .setArray(new Float32Array([0]))
          .setBuffer(buffer),
        output = doc
          .createAccessor()
          .setType('VEC3')
          .setArray(new Float32Array([0.01, 0.05, 0]))
          .setBuffer(buffer);
      const sampler = doc
          .createAnimationSampler()
          .setInterpolation('LINEAR')
          .setInput(input)
          .setOutput(output),
        channel = doc
          .createAnimationChannel()
          .setSampler(sampler)
          .setTargetNode(nodes[0])
          .setTargetPath('translation');
      doc.createAnimation('rounded_native_idle').addSampler(sampler).addChannel(channel);
    }
    return { doc, nodes };
  };
  const target = build(false),
    source = build(true);
  poseAgentIdle(target.doc, source.doc);
  target.nodes.forEach((node, index) =>
    node
      .getWorldMatrix()
      .forEach((value, axis) =>
        assert.ok(Math.abs(value - source.nodes[index].getWorldMatrix()[axis]) < 1e-8),
      ),
  );
});
