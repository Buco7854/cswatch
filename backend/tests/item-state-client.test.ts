import assert from 'node:assert/strict';
import test from 'node:test';
import { Vector3, Euler } from '../../frontend/node_modules/three/build/three.module.js';
import {
  indexItems,
  itemsAt,
  itemPose,
  validateItemSamples,
  validateItemState,
  hasRecordedProjectiles,
} from '../../frontend/src/item-state.js';
import { ReplayCache, validateManifest } from '../../frontend/src/replay-cache.js';
import type { ItemSample } from '../../shared/item-state.js';
import type { PlaybackManifest, PlaybackChunk } from '../../shared/playback.js';
const body = (tick: number, overrides = {}): ItemSample => ({
  id: 'item:34:6:0',
  tick,
  present: true,
  equipment: 'smokegrenade',
  kind: 'projectile',
  x: tick,
  y: 40,
  z: 80,
  ...overrides,
});

test('recorded item lookup is seek-safe across hide/show and serial reuse, retaining unknown rotation', () => {
  const samples = [
    body(4),
    body(8),
    { id: 'item:34:6:0', tick: 10, present: false } as ItemSample,
    body(16, { kind: 'projectile', x: 160 }),
    body(20, { x: 200 }),
    body(20, { id: 'item:34:7:20', x: 900 }),
  ];
  const index = indexItems(validateItemSamples(samples, 20));
  assert.deepEqual(itemsAt(index, -1), []);
  assert.equal(itemsAt(index, 6)[0].x, 6);
  assert.equal(itemsAt(index, 9)[0].x, 8, 'removal does not invent movement');
  assert.deepEqual(itemsAt(index, 10), []);
  assert.deepEqual(itemsAt(index, 15), []);
  assert.equal(itemsAt(index, 18)[0].x, 180);
  assert.equal(itemsAt(index, 6)[0].x, 6, 'backward seek does not use a future lifetime');
  assert.equal(itemsAt(index, 20).length, 2, 'reused entity index has a separate serial identity');
  assert.equal(itemPose(itemsAt(index, 4)[0]).rotation, null);
});

test('dropped equipment stays at rest through omitted samples and only moves over the final sample interval', () => {
  const drop = { kind: 'dropped', equipment: 'deagle', pitch: 0, yaw: 350, roll: 90 };
  const resting = body(1, { ...drop, x: 100 });
  const moved = body(1800, { ...drop, x: 140, yaw: 10 });
  const index = indexItems([resting, moved, { id: resting.id, tick: 1802, present: false }]);
  for (const tick of [1, 1796, 800]) assert.equal(itemsAt(index, tick)[0], resting);
  assert.equal(itemsAt(index, 1798)[0].x, 120);
  assert.equal(itemsAt(index, 1798)[0].yaw, 360);
  assert.deepEqual(itemsAt(index, 1802), []);
  assert.equal(itemsAt(index, 1800)[0], moved);
  assert.equal(itemsAt(index, 1)[0], resting);
});

test('recorded item angles interpolate through wrap and Source forward maps consistently into viewer coordinates', () => {
  const index = indexItems([
    body(0, { pitch: 10, yaw: 350, roll: 20 }),
    body(4, { pitch: 10, yaw: 10, roll: 20 }),
  ]);
  const middle = itemsAt(index, 2)[0];
  assert.equal(middle.yaw, 360);
  const pose = itemPose(middle),
    forward = new Vector3(1, 0, 0).applyEuler(new Euler(...pose.rotation!, 'YZX'));
  assert.ok(Math.abs(forward.x - Math.cos(Math.PI / 18)) < 1e-6);
  assert.ok(Math.abs(forward.y + Math.sin(Math.PI / 18)) < 1e-6);
  assert.ok(Math.abs(forward.z) < 1e-6);
  assert.deepEqual(pose.position, [2 * 0.0254, 80 * 0.0254, -40 * 0.0254]);
});

test('client item validation rejects stale identity changes, duplicate samples, unknown equipment and partial transforms', () => {
  for (const samples of [
    [body(0), body(0)],
    [body(1), body(0)],
    [body(0), body(1, { equipment: 'ak47', kind: 'dropped' })],
    [body(0, { equipment: 'external.glb' })],
    [body(0, { pitch: 0 })],
    [body(0, { x: Infinity })],
    [body(0, { id: 'item:16383:0:0' })],
    [body(0, { id: 'item:1:131072:0' })],
    [body(0, { id: 'item:1:0:1' })],
    [{ id: 'item:34:6:0', tick: 0, present: false }],
    [body(0, { kind: 'planted' })],
    [body(0, { kind: 'dropped', equipment: 'plantedc4' })],
    [
      body(0),
      { id: 'item:34:6:0', tick: 1, present: false },
      { id: 'item:34:6:0', tick: 2, present: false },
    ],
    [body(0, { kind: 'projectile', equipment: 'ak47' })],
    [body(0, { yaw: 0, pitch: 0, roll: NaN })],
  ])
    assert.throws(() => validateItemSamples(samples, 10));
  const many = Array.from({ length: 129 }, (_, i) => body(0, { id: `item:${i}:0:0` }));
  assert.throws(() => validateItemSamples(many, 10));
  assert.equal(validateItemSamples([body(0, { id: 'item:1:131071:0' })], 10)!.length, 1);
  assert.throws(() => validateItemSamples(undefined, 10));
  assert.equal(validateItemSamples([body(0, { pitch: 0, yaw: 0, roll: 0 })], 10)![0].present, true);
});

test('streamed item carry preserves full state after chunk eviction and a tombstone ends it exactly', async () => {
  const frame = (tick: number) => ({ tick, players: [] });
  const parts: PlaybackChunk[] = Array.from({ length: 4 }, (_, index) => ({
    version: 3,
    index,
    frames: [frame(index * 10), frame(index * 10 + 10)],
    grenades: [],
    voice: [],
    sounds: [],
    itemSamples:
      index < 2
        ? [
            body(0),
            ...(index === 1 ? [{ id: 'item:34:6:0', tick: 20, present: false } as ItemSample] : []),
          ]
        : [],
  }));
  const manifest = validateManifest({
    version: 3,
    deadTimes: [],
    warnings: [],
    chat: [],
    throwInputs: [],
    objectives: { samples: [], complete: false },
    matchState: { samples: [], complete: false },
    crosshairs: { samples: [], complete: false },
    communications: {
      voice: 'absent',
      chat: 'absent',
      captions: 'unavailable',
      unsupportedPackets: 0,
    },
    eventAvailability: { player_death: false, player_hurt: false },
    capabilities: {
      economy: false,
      equipment: false,
      inventory: false,
      inputButtons: 'unavailable',
      mouseInput: false,
      utilityThrows: false,
    },
    gameplaySounds: {
      coverage: Object.fromEntries(
        ['weapon', 'footstep', 'reload', 'utility', 'objective', 'round'].map((name) => [
          name,
          'unavailable',
        ]),
      ),
      truncated: false,
    },
    worldBounds: { minX: 0, minY: 0, minZ: 0, maxX: 100, maxY: 100, maxZ: 100 },
    map: 'de_qa',
    tickRate: 64,
    sample: false,
    players: [],
    events: [],
    rounds: [],
    firstTick: 0,
    lastTick: 40,
    itemState: { complete: true, coverage: { dropped: true, planted: true, projectile: true } },
    chunks: parts.map((part, index) => ({
      index,
      startTick: index * 10,
      endTick: index * 10 + 10,
      firstFrameTick: index * 10,
      frames: 2,
      bytes: 100,
    })),
  } as PlaybackManifest);
  const requests: number[] = [];
  const cache = new ReplayCache(manifest, async (index) => {
    requests.push(index);
    return parts[index];
  });
  for (const tick of [0, 10, 20, 30]) await cache.at(tick);
  const original = await cache.at(0);
  assert.equal(itemsAt(indexItems(original.itemSamples), 5)[0].equipment, 'smokegrenade');
  assert.equal(
    requests.filter((index) => index === 0).length,
    2,
    'canonical old chunk reloads after LRU eviction',
  );
  const replay = await cache.at(10),
    index = indexItems(replay.itemSamples);
  assert.equal(itemsAt(index, 19)[0].equipment, 'smokegrenade');
  assert.deepEqual(itemsAt(index, 20), []);
  assert.equal(replay.itemState?.complete, true);
  cache.close();
});

test('category coverage keeps exact projectile state despite unrelated missing drops and rejects contradictions', () => {
  const known = { complete: false, coverage: { dropped: false, planted: true, projectile: true } };
  assert.equal(validateItemState(known), known);
  assert.equal(hasRecordedProjectiles({ itemState: known }), true);
  assert.equal(
    hasRecordedProjectiles({
      itemState: { complete: true, coverage: { dropped: true, planted: true, projectile: true } },
    }),
    true,
  );
  assert.equal(
    hasRecordedProjectiles({
      itemState: {
        complete: false,
        coverage: { dropped: false, planted: false, projectile: false },
      },
    }),
    false,
  );
  assert.equal(hasRecordedProjectiles({}), false);
  for (const value of [
    { complete: false, coverage: { dropped: true, planted: true, projectile: true } },
    { complete: true, coverage: { dropped: false, planted: true, projectile: true } },
    { complete: false, coverage: { projectile: true } },
    { complete: false, coverage: null },
    { complete: true },
  ])
    assert.throws(() => validateItemState(value));
});
