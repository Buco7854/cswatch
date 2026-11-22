import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { DemoReader } from 'cs2parser';
import type { ItemSample, PresentItemSample } from '../../shared/item-state.js';
import { equipmentForDefinition, itemTransform, observeItemState } from '../src/item-state.js';
import {
  itemSampleSchema,
  ItemArtifactValidator,
  ItemSliceIndex,
} from '../src/item-state-replay.js';
import { validateReplayArtifacts, writeReplay } from '../src/replay.js';
import { sample } from '../../frontend/src/sample.js';

class Reader extends EventEmitter {
  currentTick = 0;
  entities: { properties: Record<string, unknown> }[] = [];
  create(index: number, className: string, definition?: number, serial = 1) {
    const properties: Record<string, unknown> = {
      [`${className}.m_hOwnerEntity`]: 0xffffffff,
      [`${className}.m_AttributeManager.m_Item.m_iItemDefinitionIndex`]: definition,
      [`${className}.CBodyComponentBaseAnimGraph.m_skeletonInstance.m_angRotation`]: [10, 20, 30],
      [`${className}.CBodyComponentBaseAnimGraph.m_skeletonInstance.m_hParent`]: 0xffffffff,
    };
    for (const axis of ['X', 'Y', 'Z']) {
      properties[
        `${className}.CBodyComponentBaseAnimGraph.m_skeletonInstance.m_vecOrigin.m_cell${axis}`
      ] = 32;
      properties[
        `${className}.CBodyComponentBaseAnimGraph.m_skeletonInstance.m_vecOrigin.m_vec${axis}`
      ] = axis.charCodeAt(0);
    }
    this.entities[index] = { properties };
    this.emit('entitycreated', [index, 1, 4, className, serial]);
    return properties;
  }
  tick(value: number) {
    this.currentTick = value;
    this.emit('tickend');
  }
}
const observe = (reader: Reader) => observeItemState(reader as unknown as DemoReader, 10000);
const present = (tick: number, id = 'item:1:1:0'): PresentItemSample => ({
  id,
  tick,
  present: true,
  equipment: 'ak47',
  kind: 'dropped',
  x: tick,
  y: 2,
  z: 3,
});

test('recorded item identities and transforms require exact known data without defaulting missing origins', () => {
  assert.equal(equipmentForDefinition(60), 'm4a1silencer');
  assert.equal(equipmentForDefinition(59), 'knifet');
  for (const value of [null, undefined, '7', 9999, Infinity])
    assert.equal(equipmentForDefinition(value), undefined);
  const reader = new Reader(),
    values = reader.create(1, 'CAK47', 7);
  assert.deepEqual(itemTransform(values, 'CAK47'), {
    x: 88,
    y: 89,
    z: 90,
    pitch: 10,
    yaw: 20,
    roll: 30,
  });
  values['CAK47.CBodyComponentBaseAnimGraph.m_skeletonInstance.m_angRotation'] = [1, NaN, 3];
  assert.deepEqual(itemTransform(values, 'CAK47'), { x: 88, y: 89, z: 90 });
  delete values['CAK47.CBodyComponentBaseAnimGraph.m_skeletonInstance.m_vecOrigin.m_cellX'];
  assert.equal(itemTransform(values, 'CAK47'), undefined);
  const rooted = reader.create(2, 'CAK47', 7);
  delete rooted['CAK47.CBodyComponentBaseAnimGraph.m_skeletonInstance.m_hParent'];
  assert.equal(itemTransform(rooted, 'CAK47'), undefined);
  rooted['CAK47.CBodyComponentBaseAnimGraph.m_skeletonInstance.m_hParent'] = 10;
  assert.equal(itemTransform(rooted, 'CAK47'), undefined);
});

test('actual ownerless entities deduplicate and close on pickup, disappearance and serial reuse', () => {
  const reader = new Reader(),
    finish = observe(reader);
  const values = reader.create(1, 'CAK47', 7);
  reader.tick(0);
  reader.tick(4);
  reader.tick(8);
  assert.equal(finish(true).samples.length, 1);
  values['CAK47.m_hOwnerEntity'] = (2 << 14) | 100;
  reader.tick(9);
  values['CAK47.m_hOwnerEntity'] = 0xffffff;
  reader.tick(10);
  reader.currentTick = 11;
  reader.create(1, 'CWeaponAWP', 9, 2);
  reader.tick(11);
  reader.currentTick = 12;
  reader.emit('entitydeleted', 1);
  const result = finish(true);
  assert.equal(result.complete, true);
  assert.deepEqual(
    result.samples.map((entry) => [entry.tick, entry.id, entry.present]),
    [
      [0, 'item:1:1:0', true],
      [9, 'item:1:1:0', false],
      [10, 'item:1:1:0', true],
      [11, 'item:1:1:0', false],
      [11, 'item:1:2:11', true],
      [12, 'item:1:2:11', false],
    ],
  );
});

test('unknown ownership and missing or out-of-range identities never fabricate dropped items', () => {
  const reader = new Reader(),
    finish = observe(reader);
  const values = reader.create(1, 'CAK47', 7);
  delete values['CAK47.m_hOwnerEntity'];
  reader.tick(0);
  assert.deepEqual(finish(true), {
    samples: [],
    complete: false,
    coverage: { dropped: false, planted: true, projectile: true },
  });
  values['CAK47.m_hOwnerEntity'] = 0;
  reader.tick(4);
  assert.equal(finish(true).samples.length, 0);
  reader.create(2, 'CAK47', 7, 131072);
  reader.tick(8);
  assert.equal(finish(true).samples.length, 0);
});

test('all six grenade models use recorded class/type and effect lifetime while C4 uses its real entity', () => {
  const reader = new Reader(),
    finish = observe(reader);
  const classes = [
    'CFlashbangProjectile',
    'CHEGrenadeProjectile',
    'CSmokeGrenadeProjectile',
    'CDecoyProjectile',
    'CMolotovProjectile',
    'CMolotovProjectile',
  ];
  const values = classes.map((name, i) => reader.create(i + 1, name));
  values[4]['CMolotovProjectile.m_bIsIncGrenade'] = false;
  values[5]['CMolotovProjectile.m_bIsIncGrenade'] = true;
  const bomb = reader.create(20, 'CPlantedC4');
  reader.tick(0);
  assert.deepEqual(
    finish(true)
      .samples.filter((entry) => entry.present)
      .map((entry) => entry.present && entry.equipment),
    ['flashbang', 'hegrenade', 'smokegrenade', 'decoy', 'molotov', 'incgrenade', 'plantedc4'],
  );
  values[2]['CSmokeGrenadeProjectile.m_nSmokeEffectTickBegin'] = 10;
  bomb['CPlantedC4.m_bHasExploded'] = true;
  reader.tick(10);
  assert.deepEqual(
    finish(true)
      .samples.slice(-2)
      .map((entry) => [entry.id, entry.present]),
    [
      ['item:3:1:0', false],
      ['item:20:1:0', false],
    ],
  );
  values[2]['CSmokeGrenadeProjectile.m_nSmokeEffectTickBegin'] = 0;
  reader.tick(12);
  assert.equal(finish(true).samples.length, 9, 'ended projectile cannot resurrect');
});

test('category coverage preserves exact projectiles and planted evidence when unrelated dropped state is unknown', () => {
  const reader = new Reader(),
    finish = observe(reader);
  const gun = reader.create(1, 'CAK47', 7);
  delete gun['CAK47.m_hOwnerEntity'];
  const grenade = reader.create(2, 'CFlashbangProjectile');
  reader.create(3, 'CPlantedC4');
  reader.tick(0);
  assert.deepEqual(finish(true).coverage, { dropped: false, planted: true, projectile: true });
  assert.equal(finish(true).samples.filter((entry) => entry.present).length, 2);
  delete grenade[
    'CFlashbangProjectile.CBodyComponentBaseAnimGraph.m_skeletonInstance.m_angRotation'
  ];
  reader.tick(4);
  assert.deepEqual(finish(true).coverage, { dropped: false, planted: true, projectile: false });
  assert.equal(finish(true).complete, false);
});

test('entity tracking and invalid mid-life definition changes remain bounded and explicitly partial', () => {
  const reader = new Reader(),
    finish = observe(reader);
  for (let index = 1; index <= 129; index++) reader.create(index, 'CAK47', 7);
  reader.tick(0);
  assert.equal(finish(true).samples.length, 128);
  assert.equal(finish(true).complete, false);
  reader.entities[1].properties['CAK47.m_AttributeManager.m_Item.m_iItemDefinitionIndex'] = 9;
  reader.tick(4);
  assert.deepEqual(finish(true).samples.at(-1), { id: 'item:1:1:0', tick: 4, present: false });
});

test('tick coalescing omits zero-duration entities and incomplete parsing hides remaining world state', () => {
  const reader = new Reader(),
    finish = observe(reader);
  reader.create(1, 'CAK47', 7);
  reader.tick(0);
  reader.emit('entitydeleted', 1);
  assert.deepEqual(finish(true).samples, []);
  reader.currentTick = 4;
  reader.create(2, 'CAK47', 7);
  reader.tick(4);
  reader.tick(8);
  const result = finish(false);
  assert.equal(result.complete, false);
  assert.deepEqual(
    result.samples.map((entry) => [entry.tick, entry.present]),
    [
      [4, true],
      [8, false],
    ],
  );
});

test('sample exhaustion reserves real closing tombstones and never keeps stale last states visible', () => {
  const reader = new Reader();
  const finish = observeItemState(reader as unknown as DemoReader, 600000);
  const first = reader.create(1, 'CAK47', 7),
    second = reader.create(2, 'CWeaponAWP', 9);
  for (let index = 0; index < 125001; index++) {
    first['CAK47.CBodyComponentBaseAnimGraph.m_skeletonInstance.m_vecOrigin.m_vecX'] = index % 512;
    second['CWeaponAWP.CBodyComponentBaseAnimGraph.m_skeletonInstance.m_vecOrigin.m_vecX'] =
      index % 512;
    reader.tick(index * 4);
  }
  const result = finish(true);
  assert.equal(result.complete, false);
  assert.deepEqual(result.coverage, { dropped: false, planted: false, projectile: false });
  assert.ok(result.samples.length <= 250000);
  assert.equal(result.samples.at(-1)?.present, false);
  assert.equal(result.samples.at(-2)?.present, false);
});

test('untrusted item schema rejects unknown resources, partial angles, fabricated projectile weapons and malformed IDs', () => {
  assert.equal(itemSampleSchema.safeParse(present(10)).success, true);
  assert.equal(itemSampleSchema.safeParse(present(10, 'item:1:131071:0')).success, true);
  for (const update of [
    { equipment: '../bad' },
    { x: Infinity },
    { pitch: 5 },
    { kind: 'projectile' },
    { kind: 'planted' },
    { id: 'item:1:131072:0' },
    { url: 'https://bad' },
  ])
    assert.equal(itemSampleSchema.safeParse({ ...present(10), ...update }).success, false);
});

test('ordered slice indexing carries only live state and artifact validation rejects missing carry or conflicting overlaps', () => {
  const states: ItemSample[] = [
    present(0),
    present(10),
    { id: 'item:1:1:0', tick: 20, present: false },
    present(30),
  ];
  const index = new ItemSliceIndex(states);
  assert.deepEqual(index.from(0)(15), states.slice(0, 2));
  assert.deepEqual(index.from(15)(25), [states[1], states[2]]);
  assert.deepEqual(index.from(25)(35), [states[3]]);
  const validator = new ItemArtifactValidator();
  validator.validate(states.slice(0, 2), 0, 15, 40);
  assert.throws(() => validator.validate([states[2]], 10, 25, 40), /Missing recorded item carry/);
  const conflict = new ItemArtifactValidator();
  conflict.validate(states.slice(0, 2), 0, 15, 40);
  assert.throws(
    () => conflict.validate([{ ...present(10), x: 999 }, states[2]], 10, 25, 40),
    /carry mismatch/,
  );
});

test('streamed world equipment survives byte-bounded chunking and rejects altered private artifacts', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'cswatch-items-'));
  try {
    const frames = Array.from({ length: 1201 }, (_, i) => ({ ...sample.frames[0], tick: i * 4 }));
    await writeReplay(folder, {
      ...sample,
      frames,
      itemState: { complete: true, coverage: { dropped: true, planted: true, projectile: true } },
      itemSamples: [present(0), present(2000), { id: 'item:1:1:0', tick: 3500, present: false }],
    });
    const manifest = validateReplayArtifacts(folder).manifest;
    assert.ok(manifest.chunks.length >= 3);
    const secondPath = join(folder, 'chunks/1.json.gz');
    const second = JSON.parse(gunzipSync(readFileSync(secondPath)).toString());
    assert.equal(
      second.itemSamples[0].tick,
      0,
      'original live state is carried before a middle seek',
    );
    const thirdPath = join(folder, 'chunks/2.json.gz');
    const third = JSON.parse(gunzipSync(readFileSync(thirdPath)).toString());
    assert.ok(second.itemSamples.some((entry: ItemSample) => !entry.present));
    assert.deepEqual(
      third.itemSamples,
      [],
      'an earlier tombstone prevents carry into a later seek',
    );
    second.itemSamples = second.itemSamples.slice(1);
    const changed = Buffer.from(JSON.stringify(second));
    writeFileSync(secondPath, gzipSync(changed));
    const manifestPath = join(folder, 'manifest.json.gz');
    const updated = JSON.parse(gunzipSync(readFileSync(manifestPath)).toString());
    updated.chunks[1].bytes = changed.length;
    writeFileSync(manifestPath, gzipSync(JSON.stringify(updated)));
    assert.throws(() => validateReplayArtifacts(folder), /Missing recorded item carry/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
