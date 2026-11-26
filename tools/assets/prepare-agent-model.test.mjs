import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import {
  prepareAgentModel,
  prepareRecordedAgentModel,
  sharedAgentBones,
} from './prepare-agent-model.mjs';
import { modelResourceId } from '../../shared/model-resource-id.mjs';
import { MeshoptDecoder } from './meshopt-glb.mjs';
import contract from '../../shared/agent-animation.json' with { type: 'json' };
import {
  directionalRoles,
  directionalMovementRoles,
} from '../../shared/agent-animation-contract.mjs';
async function fixture(path, { clip = false, direction } = {}) {
  const doc = new Document(),
    buffer = doc.createBuffer(),
    scene = doc.createScene(),
    joints = [];
  for (let i = 0; i < 20; i++) {
    const node = doc
      .createNode(
        i === 18 ? 'ball_L' : i === 19 ? 'ball_R' : i ? 'native_bone_' + i : 'root_motion',
      )
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
    const angle = (contract.directions.indexOf(direction) * Math.PI) / 4;
    const input = create('SCALAR', new Float32Array([0, 1])),
      output = create(
        'VEC3',
        new Float32Array(
          direction
            ? [0, 0, 0, Math.sin(angle) * 2, 0, Math.cos(angle) * 2]
            : [0.1, 0.05, 0, 0.1, 0.05, 0],
        ),
      ),
      sampler = doc
        .createAnimationSampler()
        .setInterpolation('LINEAR')
        .setInput(input)
        .setOutput(output),
      channel = doc
        .createAnimationChannel()
        .setSampler(sampler)
        .setTargetNode(joints[direction ? 0 : 1])
        .setTargetPath('translation');
    doc.createAnimation('original_native_idle').addSampler(sampler).addChannel(channel);
  }
  await new NodeIO().write(path, doc);
}
test('native animation preparation retains every bounded clip through lossless packing and records separate source versions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cswatch-agent-curves-'));
  try {
    const input = join(root, 'agent.glb'),
      clip = join(root, 'native.glb'),
      output = join(root, 'agents');
    await fixture(input);
    await fixture(clip, { clip: true });
    const directional = new Map();
    for (const direction of contract.directions) {
      const path = join(root, `native-${direction}.glb`);
      await fixture(path, { clip: true, direction });
      directional.set(direction, path);
    }
    const animations = Object.fromEntries(
      directionalRoles.map((role) => [
        role,
        directionalMovementRoles.has(role) ? directional.get(role.split('-').at(-1)) : clip,
      ]),
    );
    const result = await prepareAgentModel({
      input,
      animations,
      output,
      team: 't',
      assetVersion: 'combined-model-v1-clips-v2',
      sourceAssetVersion: 'model-v1',
      animationAssetVersion: 'clips-v2',
    });
    assert.equal(result.manifest.pose, 'directional-native-agent');
    assert.equal(result.provenance.sourceAssetVersion, 'model-v1');
    assert.equal(result.provenance.animationAssetVersion, 'clips-v2');
    assert.equal(result.manifest.animationRoles.length, directionalRoles.length);
    assert.equal(
      JSON.parse(await readFile(join(output, 't.manifest.json'), 'utf8')).sha256,
      result.manifest.sha256,
    );
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
      directionalRoles.map((role) => `cswatch:${role}`),
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
      assert.equal(animation.getExtras().cswatch.kind, 'native-agent');
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

async function skinFixture(path, { drop } = {}) {
  const doc = new Document(),
    buffer = doc.createBuffer(),
    scene = doc.createScene();
  const names = [...sharedAgentBones, 'jiggle_variant_gear'].filter((name) => name !== drop);
  const joints = names.map((name, i) =>
    doc.createNode(name).setTranslation(i ? [0, 0.05, 0] : [0, 0, 0]),
  );
  joints.forEach((joint, i) => (i ? joints[i - 1].addChild(joint) : scene.addChild(joint)));
  const create = (type, array) =>
    doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
  const primitive = doc
    .createPrimitive()
    .setAttribute('POSITION', create('VEC3', new Float32Array([0, 0, 0, 0.2, 0, 0, 0, 1.8, 0])))
    .setAttribute('JOINTS_0', create('VEC4', new Uint8Array(12)))
    .setAttribute(
      'WEIGHTS_0',
      create('VEC4', new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])),
    );
  const matrices = joints.flatMap((_, i) => [
    1,
    0,
    0,
    0,
    0,
    1,
    0,
    0,
    0,
    0,
    1,
    0,
    0,
    -i * 0.05,
    0,
    1,
  ]);
  const skin = doc.createSkin().setInverseBindMatrices(create('MAT4', new Float32Array(matrices)));
  for (const joint of joints) skin.addJoint(joint);
  scene.addChild(
    doc.createNode('native_mesh').setMesh(doc.createMesh().addPrimitive(primitive)).setSkin(skin),
  );
  // A native export may carry its own clip; the prepared skin never does.
  const sampler = doc
    .createAnimationSampler()
    .setInput(create('SCALAR', new Float32Array([0, 1])))
    .setOutput(create('VEC3', new Float32Array([0, 0, 0, 0, 0.1, 0])));
  doc
    .createAnimation('native_idle')
    .addSampler(sampler)
    .addChannel(
      doc
        .createAnimationChannel()
        .setSampler(sampler)
        .setTargetNode(joints[1])
        .setTargetPath('translation'),
    );
  await new NodeIO().write(path, doc);
}

test('a recorded official agent is prepared as a bounded skin on the shared skeleton', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cswatch-agent-skin-'));
  try {
    const handle = modelResourceId('characters/models/tm_leet/tm_leet_varianta.vmdl');
    const input = join(root, 'agent.glb'),
      output = join(root, 'agent-models', handle);
    await skinFixture(input);
    const result = await prepareRecordedAgentModel({
      input,
      output,
      handle,
      assetVersion: 'steam-2347770-5924479096069937098',
    });
    assert.deepEqual(
      {
        schemaVersion: result.manifest.schemaVersion,
        id: result.manifest.id,
        team: result.manifest.team,
        entry: result.manifest.entry,
        pose: result.manifest.pose,
      },
      {
        schemaVersion: 2,
        id: handle,
        team: 't',
        entry: 'tm_leet/tm_leet_varianta',
        pose: 'shared-team-clips',
      },
    );
    assert.equal(result.provenance.sourceResource, 'agents/models/tm_leet/tm_leet_varianta.vmdl_c');
    const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
    assert.equal(manifest.sha256, result.manifest.sha256);
    await MeshoptDecoder.ready;
    const document = await new NodeIO()
      .registerExtensions(ALL_EXTENSIONS)
      .registerDependencies({ 'meshopt.decoder': MeshoptDecoder })
      .read(join(output, 'model.glb'));
    assert.equal(document.getRoot().listAnimations().length, 0);
    const joints = new Set(
      document
        .getRoot()
        .listSkins()
        .flatMap((skin) => skin.listJoints())
        .map((node) => node.getName()),
    );
    for (const bone of [...sharedAgentBones, 'jiggle_variant_gear']) assert.ok(joints.has(bone));
    await assert.rejects(
      prepareRecordedAgentModel({ input, output, handle, assetVersion: 'v' }),
      /Refusing to overwrite/,
    );
    // The team default and unknown handles are not catalogued agents.
    for (const other of [modelResourceId('characters/models/tm_phoenix/tm_phoenix.vmdl'), '12345'])
      await assert.rejects(
        prepareRecordedAgentModel({
          input,
          output: join(root, other),
          handle: other,
          assetVersion: 'v',
        }),
        /catalogued agent/,
      );
    // A skin that cannot share the team clips keeps the team model.
    const partial = join(root, 'partial.glb');
    await skinFixture(partial, { drop: 'hand_R' });
    await assert.rejects(
      prepareRecordedAgentModel({
        input: partial,
        output: join(root, 'partial'),
        handle,
        assetVersion: 'v',
      }),
      /shared skeleton: hand_R/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
