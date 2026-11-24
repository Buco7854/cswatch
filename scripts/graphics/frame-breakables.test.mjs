import assert from 'node:assert/strict';
import { test } from 'node:test';
import { frameBreakables } from './frame-breakables.mjs';

const a = { modelId: '123', origin: [0, 0, 0], angles: [0, -90, 0], hidden: [[3, 10]] };
const b = { ...a, origin: [0, 1, 0], hidden: [[5, 10]] };
const tag = (track, hammerId, visible) => ({
  ...track,
  angles: [0, 270, 0],
  model: 'models/vent.vmdl',
  className: 'prop_dynamic',
  hammerId,
  visible,
});

test('the paused audit joins each exact authored instance and checks actual visibility at both interval edges', () => {
  const at = (tick, av, bv) =>
    frameBreakables([a, b], 100, tick, { nodes: [tag(b, '20', bv), tag(a, '10', av)] });
  for (const [tick, av, bv] of [
    [2, true, true],
    [3, false, true],
    [5, false, false],
    [9.9, false, false],
    [10, true, true],
    [3, false, true],
  ]) {
    const r = at(tick, av, bv);
    assert.equal(r.status, 'matched');
    assert.equal(r.matched, 2);
    assert.equal(r.agreed, 2);
    assert.equal(r.unknown, 0);
    assert.equal(r.expectedHidden, Number(!av) + Number(!bv));
    assert.deepEqual(
      r.tracks.map((t) => t.hammerId),
      ['10', '20'],
    );
  }
  const wrong = at(5, true, false);
  assert.equal(wrong.status, 'mismatch');
  assert.equal(wrong.disagreed, 1);
  assert.equal(wrong.tracks[0].actual, 'shown');
  assert.equal(wrong.tracks[0].expected, 'hidden');
});

test('missing and ambiguous identities, uninspected scenes and absent recording stay distinguishable', () => {
  const duplicate = frameBreakables([a, b], 100, 5, {
    nodes: [
      tag(a, '10', false),
      tag(a, '11', false),
      { ...tag(b, '20', false), className: 'prop_static' },
    ],
  });
  assert.deepEqual(
    [duplicate.status, duplicate.unknown, duplicate.ambiguous, duplicate.missing],
    ['partial', 2, 1, 1],
  );
  assert.deepEqual(
    duplicate.tracks.map((t) => t.actual),
    [null, null],
  );
  const missing = frameBreakables([a], 100, 3, { nodes: [] });
  const capped = frameBreakables([a], 100, 3, { reason: 'node-limit' });
  const none = frameBreakables(undefined, 100, 3, { nodes: [tag(a, '10', false)] });
  assert.deepEqual([missing.status, missing.missing, missing.tagged], ['partial', 1, 0]);
  assert.deepEqual(
    [capped.status, capped.missing, capped.unknown, capped.tagged],
    ['unavailable', 0, 1, null],
  );
  assert.deepEqual(
    [none.status, none.unknown, none.recorded, none.tagged],
    ['no-recorded-evidence', 0, 0, 1],
  );
  assert.equal(frameBreakables([{}], 100, 3, { nodes: [] }).status, 'unavailable');
  assert.equal(frameBreakables([a], 100, 101, { nodes: [] }).status, 'unavailable');
  assert.equal(
    frameBreakables([a], 100, 3, { nodes: Array(513).fill(tag(a, '10', false)) }).status,
    'unavailable',
  );
});

test('all identities count while unresolved tracks have priority in bounded frame details', () => {
  const rows = Array.from({ length: 512 }, (_, i) => ({ ...a, origin: [i, 1, 2] }));
  const nodes = rows.slice(0, -1).map((t, i) => tag(t, String(i), false));
  const r = frameBreakables(rows, 100, 5, { nodes });
  assert.equal(r.matched, 511);
  assert.equal(r.missing, 1);
  assert.equal(r.tracks.length, 32);
  assert.equal(r.tracks[0].binding, 'missing');
  assert.equal(r.omittedTrackDetails, 480);
  assert.ok(Buffer.byteLength(JSON.stringify(r)) < 32 * 1024);
});
