import type { Playback } from './types';
// An original, deterministic training scene. Never presented as an uploaded match.
export const sample: Playback = {
  version: 1,
  map: 'Training courtyard',
  tickRate: 64,
  sample: true,
  communications: {
    voice: 'absent',
    chat: 'absent',
    captions: 'ready',
    unsupportedPackets: 0,
  },
  // Authored, synthetic UI examples. These are not recorded speech or ASR output.
  captions: [
    {
      id: 'sample-caption-smoke',
      startTick: 448,
      endTick: 704,
      speaker: '0',
      text: 'Smoke is down. Cross now.',
      source: 'imported',
      language: 'en',
    },
    {
      id: 'sample-caption-flash',
      startTick: 720,
      endTick: 928,
      speaker: '1',
      text: 'One close right. Flashing over.',
      source: 'imported',
      language: 'en',
    },
    {
      id: 'sample-caption-plant',
      startTick: 960,
      endTick: 1216,
      speaker: '0',
      text: 'Bomb planted. Hold the crossfire.',
      source: 'imported',
      language: 'en',
    },
  ],
  players: [
    'marlow',
    'echo',
    'sable',
    'north',
    'rook',
    'vex',
    'atlas',
    'ghost',
    'finn',
    'koda',
  ].map((name, i) => ({ id: String(i), name, team: i < 5 ? 3 : 2 })),
  rounds: [
    { number: 1, tick: 0, liveTick: 128 },
    { number: 2, tick: 1280, liveTick: 1408 },
    { number: 3, tick: 2560, liveTick: 2688 },
  ],
  deadTimes: [
    { start: 0, end: 128, kind: 'freeze' },
    { start: 1280, end: 1408, kind: 'freeze' },
    { start: 1600, end: 1792, kind: 'timeout' },
    { start: 2560, end: 2688, kind: 'freeze' },
  ],
  grenades: [
    {
      id: 'sample-smoke',
      kind: 'CSmokeGrenadeProjectile',
      points: Array.from({ length: 49 }, (_, i) => ({
        tick: 256 + i * 4,
        x: -200 + i * 12,
        y: 200 + i * 4,
        z: Math.sin((i / 48) * Math.PI) * 200,
      })),
    },
  ],
  events: [
    { type: 'smokegrenade_detonate', tick: 448, x: 376, y: 392, z: 0 },
    { type: 'round_start', tick: 0 },
    {
      type: 'player_death',
      tick: 620,
      attacker_name: 'marlow',
      user_name: 'atlas',
      weapon: 'ak47',
    },
    { type: 'bomb_planted', tick: 960 },
    { type: 'round_end', tick: 1240, winner: 2 },
    { type: 'round_start', tick: 1280 },
    { type: 'player_death', tick: 2000, attacker_name: 'echo', user_name: 'ghost', weapon: 'm4a1' },
    { type: 'bomb_defused', tick: 2440 },
    { type: 'round_end', tick: 2500, winner: 3 },
    { type: 'round_start', tick: 2560 },
  ],
  frames: Array.from({ length: 961 }, (_, f) => ({
    tick: f * 4,
    players: Array.from({ length: 10 }, (_, i) => {
      const t = f / 16,
        a = i < 5 ? 1 : -1,
        phase = t % 20;
      return {
        id: String(i),
        x: (-13 + (i % 5) * 5.2 + Math.sin(t * 0.19 + i) * 2) * 39.37,
        y: (a * (11 - Math.min(phase, 12) * 0.68) + Math.cos(t * 0.25 + i) * 2) * 39.37,
        z: 0,
        yaw: (i < 5 ? 90 : -90) + Math.sin(t * 0.3 + i) * 30,
        pitch: 0,
        health: (i === 6 && phase > 9.7 && t < 20) || (i === 7 && t > 31.25 && t < 40) ? 0 : 100,
        team: i < 5 ? 3 : 2,
        alive: !((i === 6 && phase > 9.7 && t < 20) || (i === 7 && t > 31.25 && t < 40)),
        weapon: i < 5 ? 'm4a1' : 'ak47',
      };
    }),
  })),
};
