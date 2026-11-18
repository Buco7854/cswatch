import test from 'node:test';
import assert from 'node:assert/strict';
import { PlaybackClock } from '../../frontend/src/playback-clock.js';
test('visible playback advances at the same rate with60Hz,2Hz and irregular delivered frames', () => {
  for (const times of [
    [16, 32, 1000],
    [500, 1000],
    [849, 1000],
  ]) {
    const clock = new PlaybackClock();
    clock.reset(128, 0);
    for (const now of times) clock.at(now, 64, 10000);
    assert.equal(clock.tick, 192);
  }
  const clock = new PlaybackClock();
  clock.reset(10, 1000);
  assert.equal(clock.at(3000, 128, 10000), 266);
});
test('buffering caps at actual decoded horizon and resume/seek/speed/visibility reset cannot catch up missing time', () => {
  const clock = new PlaybackClock();
  clock.reset(100, 0);
  assert.equal(clock.at(1000, 64, 120), 120);
  assert.equal(clock.at(10000, 64, 120), 120);
  clock.reset(120, 10000);
  assert.equal(clock.at(11000, 64, 10000), 184);
  clock.reset(400, 11000);
  assert.equal(clock.at(11500, 128, 10000), 464);
  clock.reset(464, 50000);
  assert.equal(clock.at(50100, 128, 10000), 476.8);
});
