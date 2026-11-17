import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Playback } from '../../shared/playback.js';
import {
  buildReviewMoments,
  recentReviewMoment,
  indexThrowInputs,
  throwInputAt,
} from '../../frontend/src/review-moments.js';

const killer = '76561198000000001',
  victim = '76561198000000002';
function fixture(): Playback {
  return {
    version: 1,
    map: 'de_fixture',
    sample: false,
    tickRate: 64,
    players: [
      { id: killer, name: 'Duplicate', team: 3 },
      { id: victim, name: 'Duplicate', team: 2 },
    ],
    rounds: [
      { number: 1, tick: 0 },
      { number: 2, tick: 1000 },
    ],
    frames: [],
    events: [
      {
        type: 'player_death',
        tick: 500,
        attacker_steamid: killer,
        user_steamid: victim,
        attacker_team_num: 3,
        user_team_num: 2,
        weapon: 'ak47',
        headshot: true,
      },
    ],
  };
}
test('one immutable elimination supports killer and victim review, including backwards seeks', () => {
  const data = fixture(),
    index = buildReviewMoments(data, 0, 2000);
  assert.equal(index.kills.length, 1);
  const moment = index.kills[0];
  assert.equal(moment.attackerId, killer);
  assert.equal(moment.victimId, victim);
  assert.equal(moment.startTick, 308);
  assert.equal(moment.headshot, true);
  for (const selected of [killer, victim]) {
    assert.equal(
      recentReviewMoment(index, 500, selected, { kills: true, utilities: true })?.id,
      moment.id,
    );
    assert.equal(recentReviewMoment(index, 499, selected, { kills: true, utilities: true }), null);
    assert.equal(recentReviewMoment(index, 884, selected, { kills: true, utilities: true }), null);
  }
  data.events.push({
    type: 'player_death',
    tick: 1010,
    attacker_steamid: victim,
    user_steamid: killer,
  });
  const later = buildReviewMoments(data, 0, 2000).kills[1];
  assert.equal(later.startTick, 1000, 'rewind never crosses the recorded round boundary');
});
test('world deaths cannot invent an attacker POV and unrecorded names cannot acquire identities', () => {
  const data = fixture();
  data.events = [
    { type: 'player_death', tick: 500, user_steamid: victim, attacker_name: 'Duplicate' },
    { type: 'player_death', tick: 600, user_name: 'Duplicate', attacker_name: 'Duplicate' },
  ];
  const index = buildReviewMoments(data, 0, 2000);
  assert.equal(index.kills.length, 1);
  assert.equal(index.kills[0].attackerId, undefined);
  assert.equal(index.kills[0].victimId, victim);
});
test('all recorded throws remain reviewable, while landing requires unambiguous recorded coordinates', () => {
  const data = fixture();
  data.events.push(
    { type: 'weapon_fire', tick: 600, user_steamid: killer, weapon: 'flashbang', entityid: 42 },
    { type: 'grenade_thrown', tick: 600, user_steamid: killer, weapon: 'flashbang', entityid: 42 },
  );
  let index = buildReviewMoments(data, 0, 2000);
  assert.equal(index.utilities.length, 1);
  assert.equal(index.utilities[0].eventIndex, 2);
  assert.equal(index.utilities[0].landing, undefined);
  assert.equal(
    recentReviewMoment(index, 600, killer, { kills: true, utilities: true })?.kind,
    'throw',
  );
  assert.equal(
    recentReviewMoment(index, 600, killer, { kills: true, utilities: false })?.kind,
    'combat',
  );
  data.events.push({
    type: 'flashbang_detonate',
    tick: 700,
    user_steamid: killer,
    entityid: 42,
    x: 0,
    y: 0,
    z: 0,
  });
  index = buildReviewMoments(data, 0, 2000);
  assert.deepEqual(index.utilities[0].landing?.target, { x: 0, y: 0, z: 0 });
  assert.equal(
    recentReviewMoment(index, 600, victim, { kills: true, utilities: true })?.kind,
    'combat',
  );
  assert.deepEqual(buildReviewMoments({ ...data, frames: [], grenades: [] }, 0, 2000), index);
});
test('throw evidence binds exact event, actor and tick instead of nickname or nearby loaded frame', () => {
  const data = fixture();
  data.events.push({
    type: 'grenade_thrown',
    tick: 600,
    user_steamid: killer,
    weapon: 'flashbang',
  });
  const moment = buildReviewMoments(data, 0, 2000).utilities[0];
  data.throwInputs = [
    {
      eventIndex: 1,
      tick: 600,
      actorId: killer,
      sampleTick: 600,
      provenance: 'event-network',
      input: { source: 'network', attack: true, attack2: true, jump: true },
    },
  ];
  assert.equal(throwInputAt(indexThrowInputs(data), moment)?.provenance, 'event-network');
  data.throwInputs[0].actorId = victim;
  assert.equal(throwInputAt(indexThrowInputs(data), moment), undefined);
  data.throwInputs[0].actorId = killer;
  data.throwInputs[0].tick = 601;
  assert.equal(throwInputAt(indexThrowInputs(data), moment), undefined);
});
