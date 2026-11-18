import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordedRoundWinner } from '../src/rounds.js';

test('recorded numeric CT/T winners survive without coercion', () => {
  assert.equal(recordedRoundWinner(2), 2);
  assert.equal(recordedRoundWinner(3), 3);
});

test('nullable, unrecognized and out-of-bounds native winners remain unknown', () => {
  for (const value of [
    undefined,
    null,
    0,
    1,
    4,
    -2,
    2.5,
    Number.MIN_VALUE,
    Number.MAX_SAFE_INTEGER,
    NaN,
    Infinity,
    -Infinity,
    '2',
    '3',
    'CT',
    'TERRORIST',
    2n,
    true,
    false,
    { winner: 2 },
    [3],
  ])
    assert.equal(recordedRoundWinner(value), undefined);
});

test('unknown recorded winners are omitted from serialized round metadata', () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify({ number: 1, tick: 0, winner: recordedRoundWinner(null) })),
    { number: 1, tick: 0 },
  );
});
