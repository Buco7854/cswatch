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

test('declared native wire precision joins the Nuke window through its exact code; no nearest-neighbour search', () => {
  const wire = {
    ...a,
    poseCodec: 'cell32-angle20',
    origin: [406.28125, -464.5, 117],
    angles: [11.25, 0, 0],
  };
  const native = {
    ...tag(wire, 'window', false),
    origin: [406.279175, -464.5, 117.000008],
    angles: [11.249993, 0, 0],
  };
  const at = (rows, nodes) => frameBreakables(rows, 100, 5, { nodes });
  assert.equal(at([wire], [native]).status, 'matched');
  const { poseCodec: _, ...unknown } = wire;
  assert.equal(at([unknown], [native]).missing, 1);
  assert.equal(at([wire], [{ ...native, origin: [406.26, -464.5, 117] }]).missing, 1);
  const shared = { ...native, origin: [406.282, -464.5, 117] };
  assert.equal(at([wire], [native, shared]).ambiguous, 1);
  // An exact candidate does not override a second authored or recorded identity in the same code.
  assert.equal(
    at([wire], [native, { ...native, origin: wire.origin, angles: wire.angles }]).ambiguous,
    1,
  );
  assert.equal(at([wire, { ...wire, origin: [406.28, -464.5, 117] }], [native]).ambiguous, 2);
  assert.equal(at([wire, { ...unknown, origin: [406.28, -464.5, 117] }], [native]).ambiguous, 2);
  assert.equal(at([wire], [native, { ...native, origin: [406.265625, -464.5, 117] }]).ambiguous, 1);
  assert.equal(
    at([wire], [native, { ...native, angles: [11.25 + 180 / 2 ** 20, 0, 0] }]).ambiguous,
    1,
  );
  assert.equal(at([{ ...wire, poseCodec: 'other-codec' }], [native]).status, 'unavailable');
});

test('brushes and props at the same pose retain distinct visibility in both join modes', () => {
  for (const codec of [{}, { poseCodec: 'cell32-angle20' }]) {
    const prop = { ...a, ...codec };
    const brush = { ...prop, className: 'func_breakable', hidden: [[7, 9]] };
    const nodes = [
      tag(prop, '11', false),
      { ...tag(brush, '12', true), className: 'func_breakable' },
    ];
    const report = frameBreakables([prop, brush], 100, 5, { nodes });
    assert.equal(report.status, 'matched');
    assert.deepEqual(
      report.tracks.map((t) => [t.className, t.hammerId]),
      [
        ['prop_dynamic', '11'],
        ['func_breakable', '12'],
      ],
    );
    assert.equal(frameBreakables([brush], 100, 5, { nodes: [nodes[0]] }).missing, 1);
    assert.equal(
      frameBreakables([{ ...brush, className: 'func_rotating' }], 100, 5, { nodes }).status,
      'unavailable',
    );
  }
});
