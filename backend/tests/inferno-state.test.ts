import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { DemoReader } from 'cs2parser';
import {
  infernoLimits,
  validInfernoBank,
  type InfernoBank,
  type InfernoUpdate,
} from '../../shared/inferno-state.mjs';
import { observeInfernos } from '../src/inferno-state.js';
import { validateReplayArtifacts, writeReplay } from '../src/replay.js';
import { ReplayCache, validateManifest } from '../../frontend/src/replay-cache.js';
import { indexFireEffects } from '../../frontend/src/utility-effects.js';
import { sample } from '../../frontend/src/sample.js';

function capture() {
  const reader = Object.assign(new EventEmitter(), {
    currentTick: 0,
    entities: [] as { properties: Record<string, unknown> }[],
  });
  const finish = observeInfernos(reader as unknown as DemoReader, 50000);
  return {
    finish,
    create(tick: number, entity: number, serial: number) {
      reader.currentTick = tick;
      reader.emit('entitycreated', [entity, 1, 0, 'CInferno', serial]);
    },
    update(tick: number, entity: number, points: ([number, number, number] | null)[]) {
      reader.currentTick = tick;
      reader.entities[entity] = {
        properties: {
          'CInferno.m_fireCount': points.length,
          'CInferno.m_firePositions': Array.from({ length: 64 }, (_, i) => points[i] ?? [0, 0, 0]),
          'CInferno.m_bFireIsBurning': Array.from({ length: 64 }, (_, i) => Boolean(points[i])),
        },
      };
      reader.emit('tickend');
    },
    remove(tick: number, entity: number) {
      reader.currentTick = tick;
      reader.emit('entitydeleted', entity);
      delete reader.entities[entity];
    },
  };
}

test('confined observer encodes only changed burning slots and preserves lifecycle and full snapshots', () => {
  const c = capture();
  c.create(10, 4, 20);
  c.update(10, 4, [[30.015, -15, 2.875]]);
  c.create(11, 4, 20);
  c.update(11, 4, [[30.015, -15, 2.875]]);
  c.update(12, 4, [
    [30.015, -15, 2.875],
    [33, -12, 8],
  ]);
  c.update(13, 4, [null, [33, -12, 8]]);
  c.create(14, 4, 21);
  c.update(14, 4, [[18, 0, 1]]);
  c.remove(16, 4);
  c.create(18, 4, 21);
  c.update(18, 4, [[20, 0, 1]]);
  c.update(19, 4, []);
  c.remove(20, 4);
  assert.deepEqual(c.finish(true), {
    version: 1,
    tracks: [
      {
        entity: 4,
        serial: 20,
        end: 14,
        updates: [
          [10, [[0, 960, -480, 92]]],
          [12, [[1, 1056, -384, 256]]],
          [13, [[0]]],
        ],
      },
      { entity: 4, serial: 21, end: 16, updates: [[14, [[0, 576, 0, 32]]]] },
      {
        entity: 4,
        serial: 21,
        end: 20,
        updates: [
          [18, [[0, 640, 0, 32]]],
          [19, [[0]]],
        ],
      },
    ],
  });
});

test('producer and validator bound entity and recording workloads', () => {
  const c = capture();
  c.create(1, 10, 5);
  for (let tick = 1; tick <= 270; tick++) c.update(tick, 10, [[tick, 1, -1]]);
  const captured = c.finish(true)!;
  assert.equal(captured.tracks[0].updates.length, infernoLimits.trackUpdates);
  assert.equal(captured.tracks[0].end, infernoLimits.trackUpdates + 1);

  const dense = capture();
  dense.create(1, 10, 5);
  for (let tick = 1; tick <= 20; tick++)
    dense.update(
      tick,
      10,
      Array.from({ length: 64 }, (_, i) => [i + 80000, tick + 80000, -81000]),
    );
  const bounded = dense.finish(true)!;
  assert.ok(bounded.tracks[0].updates.length < 10);
  const oversized = structuredClone(bounded);
  oversized.tracks[0].updates.push([oversized.tracks[0].end++, bounded.tracks[0].updates[0][1]]);
  assert.equal(validInfernoBank(oversized, 50000), false);

  const overflow = capture();
  for (let i = 1; i <= infernoLimits.tracks + 1; i++) {
    overflow.create(i * 2, 10, i);
    overflow.update(i * 2, 10, [[10, 20, 30]]);
    overflow.remove(i * 2 + 1, 10);
  }
  const bank = overflow.finish(true)!;
  assert.equal(bank.tracks.length, infernoLimits.tracks);
  const excessive = { ...bank, tracks: [...bank.tracks, bank.tracks[0]] };
  assert.equal(validInfernoBank(excessive, 50000), false);
  const repeated = (track: InfernoBank['tracks'][number], count: number): InfernoBank => ({
    version: 1,
    tracks: Array.from({ length: count }, (_, entity) => {
      const offset = track.end * entity;
      return {
        entity,
        serial: 1,
        end: track.end + offset,
        updates: track.updates.map(([tick, changes]) => [tick + offset, changes]),
      };
    }),
  });
  assert.equal(validInfernoBank(repeated(bounded.tracks[0], 20), 50000), true);
  assert.equal(validInfernoBank(repeated(bounded.tracks[0], 100), 50000), false);
  assert.equal(validInfernoBank(repeated(captured.tracks[0], 32), 50000), true);
  assert.equal(validInfernoBank(repeated(captured.tracks[0], 33), 50000), false);
  const concurrent = {
    version: 1,
    tracks: Array.from({ length: infernoLimits.active + 1 }, (_, entity) => ({
      entity,
      serial: 1,
      end: 100,
      updates: [[1, [[0, 640, 640, 640]]]],
    })),
  };
  assert.equal(validInfernoBank(concurrent, 50000), false);
});

const journal: InfernoUpdate[] = [
  [1900, [[0, 64, 0, 96]]],
  [1950, [[0]]],
];
const infernos: InfernoBank = {
  version: 1,
  tracks: [{ entity: 17, serial: 3, end: 1980, updates: journal }],
};

test('validator rejects malformed values, noncanonical deltas and overlapping entity lifecycles', () => {
  for (const updates of [
    [[1900, [[0]]]],
    [[1900, [[64, 0, 0, 0]]]],
    [[1900, [[0, Infinity, 0, 0]]]],
    [[1900, [[0, 0.1, 0, 0]]]],
    [[1900, [[0, 3_200_001, 0, 0]]]],
    [
      [
        1900,
        [
          [1, 0, 0, 0],
          [0, 1, 0, 0],
        ],
      ],
    ],
    [
      [
        1900,
        [
          [0, 0, 0, 0],
          [0, 1, 0, 0],
        ],
      ],
    ],
    [
      [1900, [[0, 0, 0, 0]]],
      [1901, [[0, 0, 0, 0]]],
    ],
    [
      [1900, [[0, 0, 0, 0]]],
      [1900, [[0]]],
    ],
    [
      [1900, [[0, 0, 0, 0]]],
      [1980, [[0]]],
    ],
  ])
    assert.equal(
      validInfernoBank({ version: 1, tracks: [{ ...infernos.tracks[0], updates }] }, 2000),
      false,
    );
  assert.equal(validInfernoBank({ ...infernos, version: 2 }, 2000), false);
  assert.equal(validInfernoBank({ ...infernos, extra: 0 }, 2000), false);
  assert.equal(
    validInfernoBank(
      { version: 1, tracks: [infernos.tracks[0], { ...infernos.tracks[0], serial: 4 }] },
      2000,
    ),
    false,
  );
});

test('an optional inferno bank survives a real streamed boundary and old artifacts still validate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cswatch-inferno-'));
  const decode = (path: string) => JSON.parse(gunzipSync(readFileSync(path)).toString());
  try {
    const data = {
      version: 1 as const,
      sample: true,
      map: sample.map,
      tickRate: sample.tickRate,
      players: sample.players,
      rounds: [],
      events: [],
      frames: Array.from({ length: 511 }, (_, i) => ({ ...sample.frames[0], tick: i * 4 })),
      infernos,
    };
    await writeReplay(dir, data);
    const path = join(dir, 'manifest.json.gz');
    const { manifest } = validateReplayArtifacts(dir);
    const boundary = manifest.chunks[1].startTick;
    assert.ok(boundary > 1900 && boundary < 1950);
    const cache = new ReplayCache(validateManifest(manifest), async (i) =>
      decode(join(dir, 'chunks', `${i}.json.gz`)),
    );
    const before = await cache.at(boundary - 1);
    const after = await cache.at(boundary);
    assert.deepEqual(before.infernos, infernos);
    assert.equal(after.infernos, before.infernos);
    const atBoundary = indexFireEffects(after.infernos, [], 64)(boundary, false);
    assert.equal(atBoundary.length, 1);
    assert.deepEqual(indexFireEffects(before.infernos, [], 64)(boundary, false), atBoundary);
    cache.close();

    const invalid = { ...manifest, infernos: { ...infernos, version: 2 } };
    writeFileSync(path, gzipSync(JSON.stringify(invalid)));
    assert.throws(() => validateReplayArtifacts(dir), /Invalid recorded inferno bank/);
    assert.equal(validateManifest(invalid as typeof manifest).infernos, undefined);
    delete manifest.infernos;
    writeFileSync(path, gzipSync(JSON.stringify(manifest)));
    assert.equal(validateReplayArtifacts(dir).manifest.infernos, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
