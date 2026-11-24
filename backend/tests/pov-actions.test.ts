import test from 'node:test';
import assert from 'node:assert/strict';
import { agentActionAt, indexAgentEvents, povActionAt } from '../../frontend/src/agent-replay.js';
import type { GameEvent, Playback, Position } from '../../shared/playback.js';

const actor: Position = {
  id: '76561198000000021',
  x: 0,
  y: 0,
  z: 0,
  yaw: 0,
  pitch: 0,
  health: 100,
  alive: true,
  team: 2,
  weapon: 'High Explosive Grenade',
};
const event = (tick: number, type: string, weapon: string): GameEvent => ({
  tick,
  type,
  weapon,
  user_steamid: actor.id,
});
function index(events: GameEvent[]) {
  return indexAgentEvents({
    players: [{ id: actor.id, name: 'Actor', team: 2 }],
    tickRate: 64,
    events,
    frames: [],
    rounds: [],
    deadTimes: [],
    sample: false,
    map: 'de_fixture',
  } as unknown as Playback);
}
test('a recorded utility fire begins the first-person clip and only the observed release retires the model', () => {
  const events = index([
    event(100, 'weapon_fire', 'weapon_hegrenade'),
    event(106, 'grenade_thrown', 'hegrenade'),
  ]);
  const sample = (tick: number) => povActionAt(events, actor, tick, 64, 0);
  assert.deepEqual(sample(100), { kind: 'throw', age: 0, released: false });
  assert.equal(sample(105)?.released, false);
  assert.equal(sample(106)?.released, true);
  assert.equal(sample(106)?.age, 6 / 64);
  assert.equal(sample(105)?.released, false);
  assert.equal(agentActionAt(events, new Map(), actor, 105, 64, 0, true, true)?.released, false);
  assert.equal(agentActionAt(events, new Map(), actor, 106, 64, 0, true, true)?.released, true);
  assert.equal(povActionAt(events, actor, 108, 64, 107), undefined);
  assert.equal(povActionAt(events, { ...actor, alive: false }, 106, 64, 0), undefined);
  assert.equal(povActionAt(events, { ...actor, weapon: 'Flashbang' }, 106, 64, 0), undefined);
});
test('a lone throw is observable, a lone weapon-fire has no release, and a knife swipe needs its matching actor and weapon', () => {
  const firing = index([event(100, 'weapon_fire', 'weapon_hegrenade')]);
  assert.equal(povActionAt(firing, actor, 108, 64, 0)?.released, false);
  const thrown = index([event(140, 'grenade_thrown', 'hegrenade')]);
  assert.equal(povActionAt(thrown, actor, 139, 64, 0), undefined);
  assert.equal(povActionAt(thrown, actor, 140, 64, 0)?.released, true);
  const swings = index([event(200, 'weapon_fire', 'weapon_knife_skeleton')]);
  const knife = { ...actor, weapon: 'Skeleton Knife' };
  assert.deepEqual(povActionAt(swings, knife, 200, 64, 0), {
    kind: 'slash',
    age: 0,
    released: false,
  });
  assert.equal(agentActionAt(swings, new Map(), knife, 204, 64, 0, true, false)?.kind, 'fire');
  assert.equal(povActionAt(swings, { ...knife, id: 'other' }, 201, 64, 0), undefined);
  assert.equal(povActionAt(swings, knife, 201, 64, 201), undefined);
});
