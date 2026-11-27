import assert from 'node:assert/strict';
import test from 'node:test';
import { silencerCues } from '../../frontend/src/silencer-cues.js';
import { indexPovEvidence, povEvidenceAt } from '../../frontend/src/pov-actions.js';
import type { Playback, Position } from '../../frontend/src/types.js';

const player = (tick: number, extra: Partial<Position>): Position =>
  ({
    id: 'a',
    name: 'a',
    team: 3,
    x: 1,
    y: 2,
    z: 3,
    yaw: 0,
    pitch: 0,
    health: 100,
    alive: true,
    weapon: 'M4A1-S',
    ...extra,
  }) as Position;
const frames = [
  { tick: 100, players: [player(100, { silencer: true })] },
  { tick: 104, players: [player(104, { silencer: true })] },
  { tick: 108, players: [player(108, { silencer: false })] },
  { tick: 112, players: [player(112, { silencer: false })] },
  { tick: 116, players: [player(116, { weapon: 'Glock-18', burst: true })] },
  { tick: 120, players: [player(120, { silencer: true })] },
];

test('a recorded silencer change plays the official sound once, and a weapon switch does not', () => {
  const cues = silencerCues({ frames } as Pick<Playback, 'frames'>);
  assert.deepEqual(
    cues.map(({ tick, eventName, volume }) => [tick, eventName, volume]),
    [[108, 'Weapon_M4A1.Silencer_Off', 0.3]],
  );
  assert.equal(cues[0].evidence, 'recorded-state');
});

test('the first-person rig plays the detach clip from the recorded change', () => {
  const history = { frames, rounds: [{ number: 1, tick: 0 }], tickRate: 64 } as unknown as Playback;
  const evidence = indexPovEvidence({ events: [], objectives: undefined } as unknown as Playback);
  const at = povEvidenceAt(evidence, history, frames[3].players[0], 112);
  assert.deepEqual(at, { kind: 'silencerOff', age: 4 / 64 });
  // Not for a weapon without a silencer, nor beyond four seconds.
  assert.equal(povEvidenceAt(evidence, history, frames[4].players[0], 116), undefined);
  assert.equal(
    povEvidenceAt(evidence, history, frames[3].players[0], 108 + 64 * 5)?.kind,
    undefined,
  );
});
