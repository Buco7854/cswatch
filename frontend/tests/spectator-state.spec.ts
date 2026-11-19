import { expect, test } from '@playwright/test';
import type { Playback, Position } from '../src/types';
import {
  damageFeedbackAt,
  DeathFollowController,
  indexSpectatorEvents,
} from '../src/spectator-state';
import { firstPersonView, overheadDistance } from '../src/pov-camera';

const ids = ['76561198000000001', '76561198000000002', '76561198000000003', '76561198000000004'];
function recording(): Playback {
  const positions: Position[] = ids.map((id, index) => ({
    id,
    x: index === 2 ? 25 : 0,
    y: index === 0 ? 0 : index === 1 ? 10 : index === 2 ? 25 : 100,
    z: 0,
    yaw: 0,
    pitch: 0,
    health: 100,
    team: index === 1 ? 2 : 3,
    alive: true,
    weapon: 'AK47',
  }));
  return {
    version: 1,
    sample: false,
    tickRate: 64,
    map: 'de_original_spectator_qa',
    players: positions.map((player, index) => ({
      id: player.id,
      name: index < 2 ? 'twin' : 'player' + index,
      team: player.team,
    })),
    frames: Array.from({ length: 11 }, (_, index) => ({
      tick: index * 64,
      players: positions.map((player, slot) => ({
        ...player,
        ...(slot === 0 && index > 0 ? { alive: false, health: 0 } : {}),
      })),
    })),
    rounds: [{ number: 1, tick: 0 }],
    events: [
      {
        type: 'player_hurt',
        tick: 32,
        user_steamid: ids[0],
        attacker_steamid: ids[1],
        dmg_health: 25,
      },
      { type: 'player_death', tick: 64, user_steamid: ids[0], attacker_steamid: ids[1] },
    ],
  };
}

test('hurt feedback uses recorded immutable identities, bounded damage and available hit-time transforms', () => {
  const data = recording(),
    timeline = indexSpectatorEvents(data);
  expect(damageFeedbackAt(data, timeline, ids[0], 31)).toBeUndefined();
  const hit = damageFeedbackAt(data, timeline, ids[0], 32)!;
  expect(hit.opacity).toBeGreaterThan(0);
  expect(hit.direction).toBe(-90);
  expect(damageFeedbackAt(data, timeline, ids[0], 48)!.opacity).toBeLessThan(hit.opacity);
  expect(damageFeedbackAt(data, timeline, ids[0], 74)).toBeUndefined();
  expect(damageFeedbackAt(data, timeline, ids[1], 32)).toBeUndefined();
  // Trail/chunk context cannot establish an attacker's authoritative hit pose.
  expect(
    damageFeedbackAt({ ...data, frames: data.frames.slice(1) }, timeline, ids[0], 64)!.direction,
  ).toBeUndefined();
  data.events = [
    { type: 'player_hurt', tick: 32, user_name: 'twin', attacker_name: 'twin', dmg_health: 25 },
    { type: 'player_hurt', tick: 32, user_steamid: ids[0], dmg_health: -5 },
    { type: 'player_hurt', tick: 32, user_steamid: ids[0], dmg_health: '25' },
  ];
  expect(damageFeedbackAt(data, indexSpectatorEvents(data), ids[0], 32)).toBeUndefined();
});

test('death follow waits three demo seconds, chooses a living teammate and never switches after a seek, pause or identity change', () => {
  const data = recording(),
    timeline = indexSpectatorEvents(data);
  const controller = new DeathFollowController();
  const observe = (tick: number, overrides = {}) =>
    controller.advance(data, timeline, {
      identity: 'original-demo:viewer',
      selected: ids[0],
      mode: 'pov',
      playing: true,
      enabled: true,
      tick,
      ...overrides,
    });
  expect(observe(0)).toBeUndefined();
  expect(observe(65)).toBeUndefined();
  expect(observe(255)).toBeUndefined();
  expect(observe(256)).toBe(ids[2]);
  observe(0);
  observe(65);
  controller.reset(); // The transport calls reset before every explicit seek.
  expect(observe(500)).toBeUndefined();
  observe(0);
  observe(65);
  observe(128, { playing: false });
  expect(observe(256)).toBeUndefined();
  expect(observe(320)).toBeUndefined();
  observe(0);
  observe(65);
  expect(observe(256, { identity: 'another-demo:viewer' })).toBeUndefined();
  observe(0);
  observe(65);
  expect(observe(256, { mode: 'orbit' })).toBeUndefined();
});

test('automatic chunk buffering preserves an armed death until three decoded demo seconds, while manual pause during buffering cancels it', () => {
  const data = recording(),
    timeline = indexSpectatorEvents(data),
    controller = new DeathFollowController();
  const observe = (tick: number, overrides = {}) =>
    controller.advance(data, timeline, {
      identity: 'buffered-demo',
      selected: ids[0],
      mode: 'pov',
      playing: true,
      enabled: true,
      tick,
      ...overrides,
    });
  observe(0);
  observe(65);
  expect(observe(130, { buffering: true })).toBeUndefined();
  expect(observe(130, { buffering: true })).toBeUndefined();
  expect(observe(255)).toBeUndefined();
  expect(observe(256)).toBe(ids[2]);
  observe(0);
  observe(65);
  observe(130, { buffering: true, playing: false });
  expect(observe(256)).toBeUndefined();
});

test('a death between position samples is retained until the alive flag updates, and a later recorded respawn cancels it', () => {
  const data = recording();
  data.events = [
    { type: 'player_death', tick: 63, user_steamid: ids[0], attacker_steamid: ids[1] },
  ];
  const timeline = indexSpectatorEvents(data),
    controller = new DeathFollowController();
  const observe = (tick: number) =>
    controller.advance(data, timeline, {
      identity: 'sample-gap',
      selected: ids[0],
      mode: 'pov',
      tick,
      playing: true,
      enabled: true,
    });
  observe(0);
  expect(observe(63)).toBeUndefined(); // Frame0 is still alive, but the event is authoritative.
  expect(observe(64)).toBeUndefined();
  expect(observe(255)).toBe(ids[2]);
  observe(0);
  observe(63);
  observe(64);
  data.frames[2].players[0].alive = true;
  expect(observe(128)).toBeUndefined();
  expect(observe(255)).toBeUndefined();
});

test('a missing dead pawn follows from its recorded death and last observed team, but absence alone is never a death', () => {
  const data = recording();
  data.players[0].team = 2; // Initial roster sides can differ after halftime.
  for (const frame of data.frames)
    if (frame.tick >= 64) frame.players = frame.players.filter((player) => player.id !== ids[0]);
  const timeline = indexSpectatorEvents(data),
    controller = new DeathFollowController();
  const observe = (tick: number, events = timeline) =>
    controller.advance(data, events, {
      identity: 'disappearing-pawn',
      selected: ids[0],
      mode: 'pov',
      tick,
      playing: true,
      enabled: true,
    });
  observe(0);
  observe(65);
  expect(observe(256)).toBe(ids[2]);
  const noDeath = indexSpectatorEvents({ ...data, events: [] });
  observe(0, noDeath);
  observe(65, noDeath);
  expect(observe(256, noDeath)).toBeUndefined();
});

test('death follow prefers the recorded killer only when no teammate lives, and preserves the view when nobody lives', () => {
  const data = recording();
  for (const frame of data.frames)
    for (const player of frame.players)
      if (player.team === 3 && player.id !== ids[0]) player.alive = false;
  const timeline = indexSpectatorEvents(data),
    controller = new DeathFollowController();
  const observe = (tick: number) =>
    controller.advance(data, timeline, {
      identity: 'fixture',
      selected: ids[0],
      mode: 'follow',
      tick,
      playing: true,
      enabled: true,
    });
  observe(0);
  observe(65);
  expect(observe(256)).toBe(ids[1]);
  for (const frame of data.frames) for (const player of frame.players) player.alive = false;
  observe(0);
  observe(65);
  expect(observe(256)).toBeUndefined();
});

test('initial free view shares the recorded POV eye instead of moving above the map bounds', () => {
  const view = firstPersonView({ x: 100, y: 200, z: 30, yaw: 0, pitch: 0, duck: 0 });
  expect(view.position[0]).toBeCloseTo(2.54);
  expect(view.position[1]).toBeCloseTo(2.412);
  expect(view.position[2]).toBeCloseTo(-5.08);
  expect(view.target[0] - view.position[0]).toBeCloseTo(8);
  const crouch = firstPersonView({ x: 100, y: 200, z: 30, yaw: 90, pitch: 0, duck: 1 });
  expect(crouch.position[1]).toBeCloseTo(view.position[1] - 0.7);
  expect(crouch.target[2] - crouch.position[2]).toBeCloseTo(-8);
});

test('overhead camera fits the recorded extent across phone and desktop aspect ratios', () => {
  for (const aspect of [390 / 844, 768 / 900, 1440 / 900]) {
    const distance = overheadDistance(39, 48, aspect);
    const halfHeight = distance * Math.tan((48 * Math.PI) / 360);
    expect(halfHeight).toBeGreaterThan(39 / 2);
    expect(halfHeight * aspect).toBeGreaterThan(39 / 2);
  }
});
