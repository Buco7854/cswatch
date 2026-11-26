import assert from 'node:assert/strict';
import test from 'node:test';
import { indexPovEvidence, povEvidenceAt } from '../../frontend/src/pov-actions.js';

const LOOK = String(1n << 35n),
  ATTACK2 = String(1n << 11n),
  ATTACK = '1';
const rate = 64;
const player = (tick: number, weapon: string, buttons = '0', extra: object = {}) => ({
  tick,
  players: [
    {
      id: 'p',
      x: 0,
      y: 0,
      z: 0,
      yaw: 0,
      pitch: 0,
      health: 100,
      team: 3,
      alive: true,
      weapon,
      input: { source: 'network', buttons },
      ...extra,
    },
  ],
});
const history = (frames: ReturnType<typeof player>[]) => ({
  frames,
  rounds: [{ tick: 0 }],
  tickRate: rate,
});
const at = (
  frames: ReturnType<typeof player>[],
  events: object[],
  tick: number,
  objectives?: object,
) =>
  povEvidenceAt(
    indexPovEvidence({ events, objectives } as never),
    history(frames) as never,
    frames.findLast((frame) => frame.tick <= tick)!.players[0] as never,
    tick,
  );

test('the recorded inspect key starts an inspect that a recorded shot, reload or switch ends', () => {
  const frames = [
    player(0, 'AK-47'),
    player(4, 'AK-47', LOOK),
    player(8, 'AK-47', LOOK),
    player(12, 'AK-47'),
  ];
  assert.deepEqual(at(frames, [], 12), { kind: 'inspect', age: 8 / rate });
  const shot = [{ type: 'weapon_fire', tick: 10, user_steamid: 'p', weapon: 'weapon_ak47' }];
  assert.equal(at(frames, shot, 12), undefined);
  const reload = [...frames.slice(0, 3), player(12, 'AK-47', '0', { reloadStarted: 10 })];
  assert.equal(at(reload, [], 12), undefined);
  const switched = [...frames.slice(0, 3), player(12, 'Desert Eagle')];
  assert.equal(at(switched, [], 12), undefined);
  // No recorded key, no inspect.
  assert.equal(at([player(0, 'AK-47'), player(4, 'AK-47')], [], 4), undefined);
});

test('a knife attack is heavy only when the secondary attack alone was recorded', () => {
  const fire = [{ type: 'weapon_fire', tick: 8, user_steamid: 'p', weapon: 'weapon_knife' }];
  const heavy = [player(0, 'knife'), player(8, 'knife', ATTACK2), player(16, 'knife')];
  assert.deepEqual(at(heavy, fire, 16), { kind: 'heavy', age: 8 / rate });
  const light = [player(0, 'knife'), player(8, 'knife', ATTACK), player(16, 'knife')];
  assert.equal(at(light, fire, 16), undefined);
});

test('a grenade pin is pulled at the recorded press and held until the recorded throw', () => {
  const frames = [
    player(0, 'Smoke Grenade'),
    player(4, 'Smoke Grenade', ATTACK),
    player(40, 'Smoke Grenade', ATTACK),
  ];
  assert.deepEqual(at(frames, [], 40), { kind: 'pullpin', age: 36 / rate });
  const thrown = [
    { type: 'weapon_fire', tick: 30, user_steamid: 'p', weapon: 'weapon_smokegrenade' },
  ];
  assert.equal(at(frames, thrown, 40), undefined);
});

test('the C4 plant follows the recorded arming of the viewed player', () => {
  const frames = [player(0, 'C4 Explosive'), player(100, 'C4 Explosive')];
  const objectives = {
    complete: true,
    samples: [
      {
        kind: 'plant',
        tick: 50,
        entity: 'e',
        present: true,
        arming: true,
        actor: 'p',
        endTick: 250,
      },
    ],
  };
  assert.deepEqual(at(frames, [], 100, objectives), { kind: 'plant', age: 50 / rate });
  assert.equal(
    at([player(0, 'C4 Explosive'), player(300, 'C4 Explosive')], [], 300, objectives),
    undefined,
  );
});
