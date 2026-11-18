import test from 'node:test';
import assert from 'node:assert/strict';
import { ReplayCache } from '../../frontend/src/replay-cache.js';
import type { PlaybackManifest, PlaybackChunk } from '../../shared/playback.js';
test('clock horizon includes only decoded contiguous slices and synchronous lookup selects full canonical state', async () => {
  const actor = '76561198000000001',
    p = {
      id: actor,
      x: 0,
      y: 0,
      z: 0,
      yaw: 0,
      pitch: 0,
      health: 100,
      alive: true,
      team: 3,
      weapon: 'ak47',
    };
  const manifest = {
    version: 2,
    map: 'de_qa',
    sample: false,
    tickRate: 64,
    firstTick: 0,
    lastTick: 8,
    players: [{ id: actor, name: 'Original QA', team: 3 }],
    rounds: [],
    events: [],
    chunks: [
      { index: 0, startTick: 0, endTick: 4, firstFrameTick: 0, frames: 2, bytes: 100 },
      { index: 1, startTick: 4, endTick: 8, firstFrameTick: 4, frames: 2, bytes: 100 },
    ],
  } as PlaybackManifest;
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const cache = new ReplayCache(manifest, async (index) => {
    if (index === 1) await gate;
    return {
      version: 2,
      index,
      frames: [index * 4, index * 4 + 4].map((tick) => ({
        tick,
        players: [{ ...p, money: index ? 0 : 800 }],
      })),
      grenades: [],
    } as PlaybackChunk;
  });
  await cache.at(0);
  assert.equal(cache.readyUntil(0), 4);
  assert.equal(cache.peek(6), undefined);
  assert.equal(cache.readyUntil(6), 6);
  release();
  await cache.at(6);
  assert.equal(cache.readyUntil(0), 8);
  const canonical = cache.peek(6)!;
  assert.equal(canonical.frames[0].tick, 4);
  assert.equal(canonical.frames[0].players[0].money, 0);
  assert.equal(cache.peek(6), canonical);
  assert.ok(cache.size <= 3);
  cache.close();
  assert.equal(cache.peek(6), undefined);
  assert.equal(cache.readyUntil(6), 6);
});
