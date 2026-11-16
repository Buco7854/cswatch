import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildObjectiveTimeline, objectiveAt } from '../../frontend/src/objective-state.js';
import type { Playback } from '../../shared/playback.js';
import type { ObjectiveSample } from '../../shared/objectives.js';

const planter = '76561198000000001',
  defuser = '76561198000000002';
function replay(
  events: Playback['events'],
  samples: ObjectiveSample[] = [],
  complete = true,
): Playback {
  return {
    version: 1,
    sample: false,
    map: 'de_mirage',
    tickRate: 64,
    frames: [],
    players: [
      { id: planter, name: 'same name', team: 2 },
      { id: defuser, name: 'same name', team: 3 },
    ],
    rounds: [
      { number: 1, tick: 0 },
      { number: 2, tick: 10000 },
    ],
    events,
    objectives: { samples, complete },
  };
}
test('objective deadlines use recorded custom-server times, arbitrary seek order and exact outcomes', () => {
  const data = replay(
    [
      { type: 'bomb_beginplant', tick: 100, user_steamid: planter },
      { type: 'bomb_planted', tick: 300, user_steamid: planter },
      { type: 'bomb_exploded', tick: 5100 },
    ],
    [
      {
        kind: 'plant',
        tick: 100,
        entity: 'weapon',
        present: true,
        arming: true,
        actor: planter,
        endTick: 292,
      },
      { kind: 'plant', tick: 300, entity: 'weapon', present: false },
      {
        kind: 'bomb',
        tick: 300,
        entity: 'bomb',
        present: true,
        ticking: true,
        endTick: 300 + 73 * 64,
        duration: 73,
        site: 1,
      },
    ],
  );
  const timeline = buildObjectiveTimeline(data);
  assert.equal(objectiveAt(timeline, 300 + 10 * 64)?.meter.remaining, 63);
  assert.equal(objectiveAt(timeline, 164)?.meter.remaining, 2);
  assert.equal(objectiveAt(timeline, 164)?.meter.progress, 1 / 3);
  assert.equal(
    objectiveAt(timeline, 299)?.phase,
    'planting',
    'arming deadline does not fabricate a plant',
  );
  assert.equal(
    objectiveAt(timeline, 5000)?.phase,
    'planted',
    'fuse deadline does not fabricate an explosion',
  );
  assert.equal(objectiveAt(timeline, 5000)?.meter.remaining, 0);
  assert.equal(objectiveAt(timeline, 5100)?.phase, 'exploded');
  assert.equal(objectiveAt(timeline, 300)?.site, 1);
  assert.equal(objectiveAt(timeline, 50), undefined);
  assert.equal(objectiveAt(timeline, 10000), undefined);
  assert.equal(
    objectiveAt(timeline, 164)?.actor,
    planter,
    'seeking backwards never retains future actors',
  );
});
test('defuse races show independent recorded action/fuse timers and recorded kit state', () => {
  const timeline = buildObjectiveTimeline(
    replay(
      [
        { type: 'bomb_planted', tick: 100 },
        { type: 'bomb_begindefuse', tick: 200, user_steamid: defuser, haskit: true },
        { type: 'bomb_defused', tick: 648, user_steamid: defuser },
      ],
      [
        {
          kind: 'bomb',
          tick: 100,
          entity: 'bomb',
          present: true,
          ticking: true,
          endTick: 4580,
          duration: 70,
        },
        {
          kind: 'bomb',
          tick: 200,
          entity: 'bomb',
          present: true,
          ticking: true,
          beingDefused: true,
          actor: defuser,
          defuseEndTick: 648,
          defuseDuration: 7,
        },
      ],
    ),
  );
  const view = objectiveAt(timeline, 264)!;
  assert.equal(view.phase, 'defusing');
  assert.equal(view.actor, defuser);
  assert.equal(view.kit, true);
  assert.equal(view.meter.remaining, 6);
  assert.equal(view.meter.progress, 1 / 7);
  assert.equal(view.fuse?.remaining, (4580 - 264) / 64);
  assert.equal(objectiveAt(timeline, 648)?.phase, 'defused');
});
test('recorded aborts and actor deaths interrupt actions without dropping the planted bomb or matching nicknames', () => {
  const timeline = buildObjectiveTimeline(
    replay([
      { type: 'bomb_beginplant', tick: 50, user_steamid: planter },
      { type: 'bomb_abortplant', tick: 55, user_steamid: defuser },
      { type: 'player_death', tick: 60, user_steamid: defuser, user_name: 'same name' },
      { type: 'bomb_abortplant', tick: 80, user_steamid: planter },
      { type: 'bomb_beginplant', tick: 300, user_steamid: planter },
      { type: 'player_death', tick: 320, user_steamid: planter },
      { type: 'bomb_planted', tick: 600 },
      { type: 'bomb_begindefuse', tick: 700, user_steamid: defuser, user_has_defuser: false },
      { type: 'player_death', tick: 720, user_steamid: defuser },
      { type: 'bomb_begindefuse', tick: 1000, user_steamid: defuser },
      { type: 'bomb_abortdefuse', tick: 1040, user_steamid: defuser },
    ]),
  );
  assert.equal(objectiveAt(timeline, 70)?.phase, 'planting');
  assert.equal(objectiveAt(timeline, 80)?.phase, 'plant-aborted');
  assert.equal(objectiveAt(timeline, 209), undefined);
  assert.equal(objectiveAt(timeline, 320)?.phase, 'plant-aborted');
  assert.equal(objectiveAt(timeline, 710)?.kit, false);
  assert.equal(objectiveAt(timeline, 720)?.phase, 'defuse-aborted');
  assert.equal(objectiveAt(timeline, 720)?.actor, defuser);
  assert.equal(objectiveAt(timeline, 849)?.phase, 'planted');
  assert.equal(objectiveAt(timeline, 1040)?.phase, 'defuse-aborted');
  assert.equal(objectiveAt(timeline, 1169)?.phase, 'planted');
});
test('missing/partial timers show elapsed recorded activity and never assume ordinary server defaults', () => {
  const events = [
    { type: 'bomb_planted', tick: 100 },
    { type: 'bomb_begindefuse', tick: 200, user_steamid: defuser },
  ];
  const missing = buildObjectiveTimeline(replay(events));
  assert.deepEqual(objectiveAt(missing, 264)?.meter, { elapsed: 1 });
  assert.deepEqual(objectiveAt(missing, 264)?.fuse, { elapsed: 164 / 64 });
  assert.equal(objectiveAt(missing, 264)?.kit, undefined);
  const partial = buildObjectiveTimeline(
    replay(
      events,
      [
        {
          kind: 'bomb',
          tick: 100,
          entity: 'bomb',
          present: true,
          ticking: true,
          endTick: 1000,
          duration: 900 / 64,
        },
      ],
      false,
    ),
  );
  assert.equal(objectiveAt(partial, 100)?.meter.remaining, 900 / 64);
  assert.equal(objectiveAt(partial, 264)?.fuse?.remaining, undefined);
  assert.equal(objectiveAt(partial, 264)?.fuse?.elapsed, 164 / 64);
});
test('stale same-action entity snapshots cannot reopen an interrupted action or cross-round objective', () => {
  const timeline = buildObjectiveTimeline(
    replay(
      [{ type: 'player_death', tick: 150, user_steamid: defuser }],
      [
        {
          kind: 'bomb',
          tick: 100,
          entity: 'bomb',
          present: true,
          ticking: true,
          beingDefused: true,
          actor: defuser,
          endTick: 3000,
          defuseEndTick: 740,
        },
        {
          kind: 'bomb',
          tick: 160,
          entity: 'bomb',
          present: true,
          ticking: true,
          beingDefused: true,
          actor: defuser,
          endTick: 3000,
          defuseEndTick: 740,
          site: 1,
        },
        {
          kind: 'bomb',
          tick: 10010,
          entity: 'bomb',
          present: true,
          ticking: true,
          beingDefused: true,
          actor: defuser,
          site: 0,
        },
      ],
    ),
  );
  assert.equal(objectiveAt(timeline, 160)?.phase, 'defuse-aborted');
  assert.equal(objectiveAt(timeline, 300)?.phase, 'planted');
  assert.equal(objectiveAt(timeline, 10010), undefined);
});
test('recorded entity lifecycles work without event records and disappearance never invents an outcome', () => {
  const timeline = buildObjectiveTimeline(
    replay(
      [],
      [
        {
          kind: 'plant',
          tick: 10,
          entity: 'weapon',
          present: true,
          arming: true,
          endTick: 90,
          actor: planter,
        },
        {
          kind: 'bomb',
          tick: 100,
          entity: 'first',
          present: true,
          ticking: true,
          endTick: 1000,
          duration: 900 / 64,
        },
        { kind: 'bomb', tick: 200, entity: 'first', present: false },
        {
          kind: 'bomb',
          tick: 300,
          entity: 'second',
          present: true,
          ticking: true,
          endTick: 1500,
          duration: 1200 / 64,
        },
        { kind: 'bomb', tick: 350, entity: 'second', present: true, defused: true, actor: defuser },
        { kind: 'bomb', tick: 400, entity: 'third', present: true, ticking: true },
      ],
    ),
  );
  assert.equal(objectiveAt(timeline, 150)?.meter.remaining, 850 / 64);
  assert.equal(objectiveAt(timeline, 200)?.phase, 'planted');
  assert.equal(objectiveAt(timeline, 200)?.meter.remaining, undefined);
  assert.equal(objectiveAt(timeline, 310)?.meter.remaining, 1190 / 64);
  assert.equal(objectiveAt(timeline, 350)?.phase, 'defused');
  assert.equal(
    objectiveAt(timeline, 400)?.phase,
    'planted',
    'a new recorded entity can begin a new custom-server objective',
  );
  assert.equal(
    objectiveAt(timeline, 400)?.meter.remaining,
    undefined,
    'new entities never inherit another bomb deadline',
  );
  assert.equal(objectiveAt(timeline, 400)?.actor, undefined);
});
