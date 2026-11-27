import test from 'node:test';
import assert from 'node:assert/strict';
import { Document, NodeIO } from '@gltf-transform/core';
import {
  addNativeEject,
  addNativeMuzzle,
  inspectNativeEject,
  inspectNativeMuzzle,
  nativeEjectNode,
  nativeMuzzleNode,
  validateNativeMuzzle,
} from './native-weapon-muzzle.mjs';

const authored = { bone: 'original_weapon', position: [20, 2, 4], rotation: [0, 0, 0, 1] };
function mesh({
  position = authored.position,
  weight = 1,
  root = false,
  bone = authored.bone,
} = {}) {
  return `--- Data for block "MDAT" ---
{
 m_attachments = [ {
  key = "muzzle_flash"
  value = {
   m_name = "muzzle_flash"
   m_influenceNames = [ "${bone}", "", "" ]
   m_vInfluenceRotations = [ [0,0,0,1], [0,0,0,1], [0,0,0,1] ]
   m_vInfluenceOffsets = [ [${position}], [0,0,0], [0,0,0] ]
   m_influenceWeights = [ ${weight}, 0, 0 ]
   m_bInfluenceRootTransform = [ ${root}, false, false ]
   m_nInfluences = 1
   m_bIgnoreRotation = false
  }
 } ]
}`;
}

test('native muzzle requires exact unique single-bone evidence and agreement across mesh variants', () => {
  assert.deepEqual(inspectNativeMuzzle(mesh()), authored);
  assert.deepEqual(inspectNativeMuzzle(mesh() + '\n' + mesh()), authored);
  assert.equal(inspectNativeMuzzle(mesh() + '\n' + mesh({ position: [21, 2, 4] })), undefined);
  assert.equal(inspectNativeMuzzle(mesh({ weight: 0.5 })), undefined);
  assert.equal(inspectNativeMuzzle(mesh({ root: true })), undefined);
  assert.equal(inspectNativeMuzzle('--- Data for block "MDAT" ---\nm_attachments = []'), undefined);
  assert.equal(
    inspectNativeMuzzle(mesh() + '\n--- Data for block "MDAT" ---\nm_attachments = []'),
    undefined,
  );
  assert.throws(() => inspectNativeMuzzle('x'.repeat(4 * 1024 ** 2 + 1)), /bounded/);
  assert.equal(
    inspectNativeMuzzle('--- Data for block "MDAT" ---\n' + '\n'.repeat(100000)),
    undefined,
  );
  assert.throws(() => inspectNativeMuzzle(mesh().replace('[20,2,4]', '['.repeat(20))), /nesting/);
});

test('missing or unsupported optional mesh evidence remains unavailable while allocation bounds fail closed', () => {
  // Successful fixed CLI inspection of a valid native model need not contain
  // embedded MDAT (for example a different supported source representation).
  assert.equal(
    inspectNativeMuzzle('Resource Type: Model\n--- Resource Blocks: Count 0 ---'),
    undefined,
  );
  for (const unsupported of [
    mesh().replace('m_nInfluences = 1', 'm_nInfluences = 1\nm_nInfluences = 1'),
    mesh({ bone: '../other' }),
    mesh({ position: [Infinity, 2, 4] }),
    mesh().slice(0, -3),
    mesh().replace('m_influenceNames = [', 'm_influenceNames = resource:['),
  ])
    assert.equal(inspectNativeMuzzle(unsupported), undefined);
  assert.throws(() => inspectNativeMuzzle(mesh() + '\0'), /bounded/);
  assert.throws(() => inspectNativeMuzzle(Array(129).fill(mesh()).join('\n')), /Too many/);
  assert.throws(() => inspectNativeMuzzle(mesh().replace('[20,2,4]', '['.repeat(20))), /nesting/);
});

test('authored muzzle is local to its actual bone and survives a self-contained GLB roundtrip', async () => {
  const document = new Document(),
    scene = document.createScene(),
    // The root stands for the S2V skeleton's world conversion plus the existing
    // equipment correction; the attachment must not apply either again.
    root = document.createNode('source-root').setRotation([0, Math.SQRT1_2, 0, Math.SQRT1_2]),
    bone = document.createNode(authored.bone).setTranslation([1, 2, 3]);
  scene.addChild(root);
  root.addChild(bone);
  const provenance = addNativeMuzzle(document, authored);
  assert.equal(provenance.units, 'source-inches');
  const marker = document
    .getRoot()
    .listNodes()
    .find((node) => node.getName() === nativeMuzzleNode);
  assert.deepEqual(marker.getTranslation(), [0.508, 0.0508, 0.1016]);
  assert.equal(marker.getParentNode(), bone);
  const world = marker.getWorldMatrix();
  [3.1016, 2.0508, -1.508].forEach((value, i) => assert.ok(Math.abs(world[12 + i] - value) < 1e-8));
  const decoded = await new NodeIO().readBinary(await new NodeIO().writeBinary(document)),
    published = decoded
      .getRoot()
      .listNodes()
      .find((node) => node.getName() === nativeMuzzleNode);
  assert.ok(published);
  assert.deepEqual(published.getExtras(), { cswatchNativeAttachment: 'muzzle_flash' });
  assert.deepEqual(published.getTranslation(), marker.getTranslation());
  assert.equal(addNativeMuzzle(document, authored), undefined);
});

test('missing/ambiguous bones never become fabricated authored anchors, and metadata is bounded', () => {
  const document = new Document();
  assert.equal(addNativeMuzzle(document, authored), undefined);
  document.createNode(authored.bone);
  document.createNode(authored.bone);
  assert.equal(addNativeMuzzle(document, authored), undefined);
  assert.equal(addNativeMuzzle(document, undefined), undefined);
  for (const bad of [
    { ...authored, extra: true },
    { ...authored, position: [129, 0, 0] },
    { ...authored, rotation: [0, 0, 0, 0] },
    { ...authored, position: [NaN, 0, 0] },
    { ...authored, bone: 'x'.repeat(101) },
  ])
    assert.throws(() => validateNativeMuzzle(bad), /attachment/);
});

test('the shell ejection port follows the same exact-evidence rules as the muzzle', async () => {
  const eject = { bone: 'weapon_offset', position: [3.3, -0.38, -0.07], rotation: [0, 0, 0, 1] };
  const port = mesh({ bone: eject.bone, position: eject.position }).replaceAll(
    'muzzle_flash',
    'shell_eject',
  );
  assert.deepEqual(inspectNativeEject(port), eject);
  // Each name is read only from its own attachment.
  assert.equal(inspectNativeMuzzle(port), undefined);
  assert.equal(inspectNativeEject(mesh()), undefined);
  assert.equal(
    inspectNativeEject(port + '\n' + port.replace('3.3', '3.4')),
    undefined,
    'variants must agree',
  );
  const document = new Document();
  document.createScene().addChild(document.createNode(eject.bone));
  const provenance = addNativeEject(document, eject);
  assert.equal(provenance.node, nativeEjectNode);
  const decoded = await new NodeIO().readBinary(await new NodeIO().writeBinary(document)),
    published = decoded
      .getRoot()
      .listNodes()
      .find((node) => node.getName() === nativeEjectNode);
  assert.deepEqual(published.getExtras(), { cswatchNativeAttachment: 'shell_eject' });
  assert.equal(addNativeEject(document, eject), undefined);
  // Both anchors can coexist on one weapon.
  assert.ok(addNativeMuzzle(document, { ...eject, position: [20, 0, 1] }));
});
