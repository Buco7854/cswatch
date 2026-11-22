import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sample } from '../../frontend/src/sample.js';
import { readSettings, shotTracersEnabled } from '../../frontend/src/playback.js';
import { damageFeedbackAt, indexSpectatorEvents } from '../../frontend/src/spectator-state.js';
import { flashFeedbackAt } from '../../frontend/src/flash-feedback.js';
import { createShotRayCache, shotTracerSpan } from '../../frontend/src/shot-tracer.js';
import {
  grenadePathEvents,
  grenadePathOpacity,
  indexGrenadePaths,
  revealedPoints,
  visibleGrenadePaths,
} from '../../frontend/src/grenade-paths.js';
import { tacticalPalette } from '../../frontend/src/tactical-palette.js';
import type { GameEvent, Grenade, Playback } from '../../shared/playback.js';

test('hurt feedback has a small-hit floor, capped stacking and a linear demo-time release', () => {
  const player = sample.players.find(({ id }) => id !== '0')!.id;
  const hit: GameEvent = {
    type: 'player_hurt',
    tick: 100,
    user_steamid: player,
    dmg_health: 1,
  };
  const data: Playback = { ...sample, events: [hit] };
  const timeline = indexSpectatorEvents(data);
  const at = (tick: number) => damageFeedbackAt(data, timeline, player, tick)?.opacity;
  const peak = at(100)!;
  assert.ok(peak >= 0.64);
  assert.equal(at(99), undefined);
  assert.ok(Math.abs(at(120.8)! - peak / 2) < 1e-10);
  assert.equal(at(142), undefined);
  assert.equal(at(100), peak);

  const repeated: Playback = {
    ...data,
    frames: data.frames.map((frame) => ({
      ...frame,
      players: frame.players.map((pawn) =>
        pawn.id === player && frame.tick >= 100 ? { ...pawn, alive: false } : pawn,
      ),
    })),
    events: [
      ...Array.from({ length: 8 }, () => ({ ...hit, dmg_health: 100 })),
      { type: 'player_death', tick: 100, user_steamid: player },
    ],
  };
  const burst = indexSpectatorEvents(repeated);
  assert.equal(damageFeedbackAt(repeated, burst, player, 100)?.opacity, 0.96);
  assert.ok(damageFeedbackAt(repeated, burst, player, 103)!.opacity > 0.85);
  data.events.push({ ...hit, tick: 110, dmg_health: 0 });
  const burstWithZero = indexSpectatorEvents(data);
  assert.equal(damageFeedbackAt(data, burstWithZero, player, 109)?.opacity, peak);
  assert.equal(damageFeedbackAt(data, burstWithZero, player, 110)?.opacity, 0.96);
});

test('grenade paths reveal only samples, mark sharp turns, and fade after the recorded detonation', () => {
  const owner = sample.players[0];
  const path: Grenade = {
    id: '72-100',
    kind: 'CSmokeGrenadeProjectile',
    points: [
      { tick: 100, x: 0, y: 0, z: 0 },
      { tick: 104, x: 15, y: 0, z: 0 },
      { tick: 108, x: 15, y: 10, z: 0 },
      { tick: 112, x: 30, y: 10, z: 0 },
      { tick: 116, x: 40, y: 10, z: 0 },
    ],
  };
  const events = grenadePathEvents([
    { type: 'smokegrenade_detonate', tick: 113, entityid: 72, user_steamid: owner.id },
  ]);
  const paths = indexGrenadePaths([path, { ...path, id: 'unknown' }], events, [owner], 64);
  const [owned, unknown] = paths;
  assert.deepEqual(owned.points, path.points.slice(0, -1));
  assert.equal(owned.owner, owner.id);
  assert.equal(owned.color, owner.team === 3 ? tacticalPalette.ct : tacticalPalette.t);
  assert.equal(unknown.owner, undefined);
  assert.notEqual(unknown.color, owned.color);
  assert.ok(owned.bounces.includes(1));
  assert.equal(revealedPoints(owned.points, 103), 1);
  assert.equal(revealedPoints(owned.points, 104), 2);
  assert.equal(revealedPoints(owned.points, 99), 0);
  assert.equal(revealedPoints(owned.points, 248), 4);
  assert.equal(revealedPoints(owned.points, 104), 2);
  assert.equal(grenadePathOpacity(owned, 113 + 128, 64), 0.6);
  assert.equal(grenadePathOpacity(owned, 113 + 128, 64, true), 1);
  assert.equal(grenadePathOpacity(owned, 113 + 320, 64), 0);
  assert.deepEqual(visibleGrenadePaths(paths, 240, 64, 'selected', owner.id), [owned]);
  assert.deepEqual(visibleGrenadePaths(paths, 240, 64, 'all', owner.id), paths);
  assert.deepEqual(visibleGrenadePaths(paths, 240, 64, 'off', owner.id), []);
});

test('legacy grenade booleans migrate without changing the flash default', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  let saved: unknown;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => JSON.stringify({ trajectories: saved }) },
  });
  try {
    for (const [input, expected] of [
      [true, 'all'],
      [false, 'off'],
      ['selected', 'selected'],
      ['bad', 'all'],
    ]) {
      saved = input;
      assert.equal(readSettings().trajectories, expected);
    }
    assert.equal(readSettings().flashFeedback, 'indicator');
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

test('blind uses a constant-duration positive run with a smooth, seek-safe release', () => {
  const pawn = sample.frames[0].players[0];
  const data = {
    tickRate: 64,
    frames: Array.from({ length: 30 }, (_, i) => ({
      tick: i * 4,
      players: [{ ...pawn, alive: true, flash: i >= 4 && i < 27 ? 1.03 : 0 }],
    })),
  };
  const at = (tick: number) => flashFeedbackAt(data, pawn.id, tick);
  assert.equal(at(15), undefined);
  assert.equal(at(16), 0.97);
  const middle = at(60)!;
  assert.ok(middle > 0.3 && middle < 0.8);
  assert.ok(at(100)! < 0.03);
  assert.equal(at(108), undefined);
  assert.equal(at(60), middle);
  assert.equal(flashFeedbackAt({ ...data, frames: data.frames.slice(2) }, pawn.id, 60), middle);
  assert.equal(flashFeedbackAt(data, 'missing', 16), undefined);
});

test('a presentation tracer advances from the muzzle, stops at geometry, and expires by demo time', () => {
  assert.deepEqual(shotTracerSpan(0, 10), { head: 0.48, tail: 0 });
  assert.deepEqual(shotTracerSpan(0.02, 7)?.head, 7);
  assert.ok(shotTracerSpan(0.02, 7)!.tail > 0);
  assert.equal(shotTracerSpan(0.04, 7), undefined);
  assert.equal(shotTracerSpan(0.09, 28), undefined);
  assert.equal(shotTracerSpan(-0.01, 28), undefined);
  assert.deepEqual(shotTracerSpan(0, 10), { head: 0.48, tail: 0 });
});

test('shot ray cache reuses clear and blocked shots, caps history and isolates a new map', () => {
  const cache = createShotRayCache<number | null>(2);
  let calls = 0;
  const clear = () => {
    calls++;
    return 4;
  };
  const blocked = () => {
    calls++;
    return null;
  };
  assert.equal(cache.resolve('a', 10, clear), 4);
  assert.equal(cache.resolve('a', 10, blocked), 4);
  assert.equal(cache.resolve('b', 10, blocked), null);
  assert.equal(cache.resolve('b', 10, clear), null);
  assert.equal(calls, 2);
  cache.resolve('a', 11, clear);
  assert.equal(cache.resolve('a', 10, blocked), null);
  assert.equal(createShotRayCache().resolve('b', 10, clear), 4);
  assert.equal(calls, 5);
});

test('shot tracers inherit desktop quality defaults and preserve explicit stored choices', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  let stored: Record<string, unknown> = {};
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => JSON.stringify(stored) },
  });
  try {
    for (const quality of ['auto', 'high', 'low', 'compact']) {
      stored = { quality };
      const settings = readSettings();
      assert.equal(shotTracersEnabled(settings, false), ['auto', 'high'].includes(quality));
      assert.equal(shotTracersEnabled(settings, true), false);
      assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(settings)), 'shotTracers'), false);
    }
    stored = { quality: 'auto', shotTracers: false };
    assert.equal(shotTracersEnabled(readSettings(), false), false);
    stored = { quality: 'compact', shotTracers: true };
    assert.equal(shotTracersEnabled(readSettings(), true), true);
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
