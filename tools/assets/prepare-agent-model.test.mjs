import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prepareAgentModel } from './prepare-agent-model.mjs';
import { MeshoptDecoder } from './meshopt-glb.mjs';
import { agentAnimationRoles } from './agent-animation-registry.mjs';
async function fixture(path, { clip = false } = {}) {
  const doc = new Document(),
    buffer = doc.createBuffer(),
    scene = doc.createScene(),
    joints = [];
  for (let i = 0; i < 20; i++) {
    const node = doc
      .createNode(i ? 'native_bone_' + i : 'root_motion')
      .setTranslation(i ? [0, 0.05, 0] : [0, 0, 0]);
    if (i) joints[i - 1].addChild(node);
    else scene.addChild(node);
    joints.push(node);
  }
  const create = (type, array) =>
    doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
  const positions = create('VEC3', new Float32Array([0, 0, 0, 0.2, 0, 0, 0, 1.8, 0]));
  const primitive = doc
    .createPrimitive()
    .setAttribute('POSITION', positions)
    .setAttribute('JOINTS_0', create('VEC4', new Uint8Array(12)))
    .setAttribute('TEXCOORD_1', create('VEC2', new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6])))
    .setAttribute(
      'WEIGHTS_0',
      create('VEC4', new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])),
    );
  const matrices = [];
  for (let i = 0; i < 20; i++)
    matrices.push(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -i * 0.05, 0, 1);
  const skin = doc.createSkin().setInverseBindMatrices(create('MAT4', new Float32Array(matrices)));
  for (const joint of joints) skin.addJoint(joint);
  scene.addChild(
    doc.createNode('native_mesh').setMesh(doc.createMesh().addPrimitive(primitive)).setSkin(skin),
  );
  if (clip) {
    const input = create('SCALAR', new Float32Array([0, 1])),
      output = create('VEC3', new Float32Array([0.1, 0.05, 0, 0.1, 0.05, 0])),
      sampler = doc
        .createAnimationSampler()
        .setInterpolation('LINEAR')
        .setInput(input)
        .setOutput(output),
      channel = doc
        .createAnimationChannel()
        .setSampler(sampler)
        .setTargetNode(joints[1])
        .setTargetPath('translation');
    doc.createAnimation('original_native_idle').addSampler(sampler).addChannel(channel);
  }
  await new NodeIO().write(path, doc);
}
test('static agent preparation publishes one native-sized posed agent without a second axis conversion or fake animation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cswatch-agent-pose-'));
  try {
    const input = join(root, 'agent.glb'),
      idle = join(root, 'idle.glb'),
      output = join(root, 'agents');
    await fixture(input);
    await fixture(idle, { clip: true });
    const result = await prepareAgentModel({
      input,
      idle,
      output,
      team: 'ct',
      assetVersion: 'original-fixture',
    });
    assert.equal(result.manifest.pose, 'approximate-static-native-idle');
    assert.equal(result.provenance.posePreparation.mappedBones, 20);
    assert.equal(result.manifest.coordinateSystem, 's2v-meters-y-up-viewer-rotates-positive-90y');
    assert.ok(Math.abs(result.manifest.bounds.max[1] - 1.8) < 1e-6);
    await MeshoptDecoder.ready;
    const doc = await new NodeIO()
      .registerExtensions(ALL_EXTENSIONS)
      .registerDependencies({ 'meshopt.decoder': MeshoptDecoder })
      .read(result.path);
    assert.equal(doc.getRoot().listAnimations().length, 0);
    assert.ok(
      Math.abs(
        doc
          .getRoot()
          .listNodes()
          .find((x) => x.getName() === 'native_bone_1')
          .getTranslation()[0] - 0.1,
      ) < 1e-6,
    );
    assert.equal(
      JSON.parse(await readFile(join(output, 'ct.manifest.json'), 'utf8')).sha256,
      result.manifest.sha256,
    );
    await assert.rejects(
      () => prepareAgentModel({ input, idle, output, team: 'ct', assetVersion: 'replacement' }),
      /overwrite/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native animation preparation retains five bounded clips through lossless packing and records separate source versions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cswatch-agent-curves-'));
  try {
    const input = join(root, 'agent.glb'),
      clip = join(root, 'native.glb'),
      output = join(root, 'agents');
    await fixture(input);
    await fixture(clip, { clip: true });
    const animations = Object.fromEntries(agentAnimationRoles.map((role) => [role, clip]));
    const result = await prepareAgentModel({
      input,
      animations,
      output,
      team: 't',
      assetVersion: 'combined-model-v1-clips-v2',
      sourceAssetVersion: 'model-v1',
      animationAssetVersion: 'clips-v2',
    });
    assert.equal(result.manifest.pose, 'approximate-native-locomotion');
    assert.equal(result.provenance.sourceAssetVersion, 'model-v1');
    assert.equal(result.provenance.animationAssetVersion, 'clips-v2');
    assert.equal(result.manifest.animations.length, 5);
    assert.ok(result.manifest.geometryBytes < 8 * 1024 ** 2);
    const document = await new NodeIO()
      .registerExtensions(ALL_EXTENSIONS)
      .registerDependencies({ 'meshopt.decoder': MeshoptDecoder })
      .read(result.path);
    assert.deepEqual(
      document
        .getRoot()
        .listAnimations()
        .map((animation) => animation.getName()),
      agentAnimationRoles.map((role) => `cswatch:${role}`),
    );
    assert.deepEqual(
      Array.from(
        document
          .getRoot()
          .listMeshes()[0]
          .listPrimitives()[0]
          .getAttribute('TEXCOORD_1')
          .getArray(),
      ),
      Array.from(new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6])),
      'unused authored UV attributes remain byte-exact',
    );
    for (const animation of document.getRoot().listAnimations()) {
      assert.ok(animation.listChannels().length > 0);
      assert.equal(animation.getExtras().cswatch.kind, 'native-locomotion');
      assert.ok(
        animation
          .listSamplers()
          .every((sampler) => sampler.getInput().getCount() === sampler.getOutput().getCount()),
      );
    }
    await assert.rejects(
      () => prepareAgentModel({ input, animations, output, team: 't', assetVersion: 'overwrite' }),
      /overwrite/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
