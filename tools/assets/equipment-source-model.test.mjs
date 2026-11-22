import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectEquipmentSourceModel, staticModelDependency } from './equipment-source-model.mjs';
import { scanEquipmentDependencies } from './equipment-dependencies.mjs';
import { directionalAgentRegistry } from './agent-animation-registry.mjs';
function metadata({ groups = '2,1', mask = '1', lod = '255,255' } = {}) {
  return {
    data: `--- Data for block "DATA" ---\nm_refMeshes = [ ]\nm_refMeshGroupMasks = [${groups}]\nm_refLODGroupMasks = [${lod}]\nm_nDefaultMeshGroupMask = ${mask}\n`,
    control:
      '--- Data for block "CTRL" ---\nm_Name = "body_legacy"\nm_nMeshIndex = 0\nm_Name = "body_hd"\nm_nMeshIndex = 1\n',
  };
}
test('native uint64 default groups and first actual LOD select only authored meshes', () => {
  assert.deepEqual(inspectEquipmentSourceModel(metadata()).meshes, ['body_hd']);
  assert.deepEqual(
    inspectEquipmentSourceModel(
      metadata({ groups: '18446744073709551615,1', mask: '18446744073709551615', lod: '4,8' }),
    ).meshes,
    ['body_legacy'],
  );
  for (const patch of [
    { mask: '0' },
    { groups: '1' },
    { mask: '18446744073709551616' },
    { lod: '0,0' },
  ])
    assert.throws(() => inspectEquipmentSourceModel(metadata(patch)));
  const referenced = metadata();
  referenced.data = referenced.data.replace(
    'm_refMeshes = [ ]',
    'm_refMeshes = [ resource:"outside.vmesh" ]',
  );
  assert.throws(() => inspectEquipmentSourceModel(referenced), /embedded/);
  const duplicate = metadata();
  duplicate.control = duplicate.control.replace('m_nMeshIndex = 1', 'm_nMeshIndex = 0');
  assert.throws(() => inspectEquipmentSourceModel(duplicate), /inconsistent/);
});
test('locomotion closure accepts only the fixed clips and their skeleton, never other clips or animation graphs', async () => {
  const seeds = Object.values(directionalAgentRegistry),
    skeleton = 'animation/skeletons/characters/worldmodel.vnmskel_c',
    graph = 'animation/graphs/unselected.vnmgraph_c';
  const clip = resource([skeleton, graph]),
    data = new Map(seeds.map((seed) => [seed, clip]));
  data.set(skeleton, resource([]));
  const entries = new Map(
      [...data].map(([name, bytes]) => [
        name,
        { resource: name, length: bytes.length, preloadBytes: 0, preload: Buffer.alloc(0) },
      ]),
    ),
    read = [];
  const index = async (path) => ({
    provenance: { path },
    entries: path.includes('/csgo/') ? entries : new Map(),
    readEntry: async (name) => {
      read.push(name);
      return data.get(name);
    },
  });
  const result = await scanEquipmentDependencies({ game: '/fixed', seeds, index });
  assert.deepEqual(result.pending, { csgo: [], core: [] });
  assert.deepEqual(result.skipped, [graph]);
  assert.ok(read.includes(skeleton));
  assert.equal(read.includes(graph), false);
  await assert.rejects(
    () =>
      scanEquipmentDependencies({
        game: '/fixed',
        seeds: ['animation/anims/world/rifle/_default_rifle/unselected.vnmclip_c'],
        index,
      }),
    /fixed selected/,
  );
});
function resource(references) {
  const strings = references.map((x) => Buffer.from(x + '\0')),
    rerl = Buffer.alloc(8 + 16 * references.length + strings.reduce((s, x) => s + x.length, 0));
  rerl.writeUInt32LE(8);
  rerl.writeUInt32LE(strings.length, 4);
  let offset = 8 + 16 * strings.length;
  strings.forEach((bytes, i) => {
    const at = 8 + 16 * i;
    rerl.writeBigUInt64LE(BigInt(i + 1), at);
    rerl.writeInt32LE(offset - at - 8, at + 8);
    bytes.copy(rerl, offset);
    offset += bytes.length;
  });
  const result = Buffer.alloc(28 + rerl.length);
  result.writeUInt32LE(result.length);
  result.writeUInt16LE(12, 4);
  result.writeUInt32LE(8, 8);
  result.writeUInt32LE(1, 12);
  result.write('RERL', 16);
  result.writeUInt32LE(8, 20);
  result.writeUInt32LE(rerl.length, 24);
  rerl.copy(result, 28);
  return result;
}
test('static closure seeds only selected models and skips graph/customization expansion, retaining exact material requirements', async () => {
  const model = 'weapons/models/original/original.vmdl_c',
    material = 'materials/original.vmat_c',
    image = 'materials/original.vtex_c',
    graph = 'animation/graphs/huge.vnmgraph_c';
  const data = new Map([
    [model, resource([material, graph])],
    [material, resource([image])],
  ]);
  const entries = new Map(
    [...data].map(([resource, bytes]) => [
      resource,
      { resource, length: bytes.length, preloadBytes: 0, preload: Buffer.alloc(0) },
    ]),
  );
  entries.set(image, { resource: image, length: 256, preloadBytes: 0, preload: Buffer.alloc(0) });
  entries.set('weapons/models/unselected/unselected.vmdl_c', {
    resource: 'weapons/models/unselected/unselected.vmdl_c',
    length: 1000000000,
    preloadBytes: 0,
  });
  const read = [];
  const index = async (path) => ({
    provenance: { path },
    entries: path.includes('/csgo/') ? entries : new Map(),
    readEntry: async (name) => {
      read.push(name);
      return data.get(name);
    },
  });
  const result = await scanEquipmentDependencies({ game: '/fixed', seeds: [model], index });
  assert.deepEqual(
    result.pending.csgo.map((x) => x.resource),
    [image],
  );
  assert.deepEqual(result.skipped, [graph]);
  assert.equal(result.materials[0].resource, material);
  assert.ok(!read.includes(graph));
  assert.ok(!read.some((x) => x.includes('unselected')));
  assert.ok(staticModelDependency('animation/skeletons/original.vnmskel_c'));
  await assert.rejects(() =>
    scanEquipmentDependencies({ game: '/fixed', seeds: ['../secret'], index }),
  );
});
