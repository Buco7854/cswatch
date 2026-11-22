import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  frameAt,
  skipDeadTime,
  readSettings,
  defaultSettings,
} from '../../frontend/src/playback.js';
import { sample } from '../../frontend/src/sample.js';
test('frame lookup clamps ends and interpolates between adjacent ticks', () => {
  assert.equal(frameAt(sample, -1).frame.tick, 0);
  const state = frameAt(sample, 6);
  assert.equal(state.frame.tick, 4);
  assert.equal(state.next.tick, 8);
  assert.equal(state.alpha, 0.5);
  assert.equal(frameAt(sample, 1e7).alpha, 0);
});
test('dead-time skip respects freeze and timeout boundaries', () => {
  assert.equal(skipDeadTime(sample, 64), 128);
  assert.equal(skipDeadTime(sample, 64, 'timeout'), 64);
  assert.equal(skipDeadTime(sample, 1664), 1792);
  assert.equal(skipDeadTime(sample, 2000), 2000);
  assert.equal(skipDeadTime(sample, 1792), 1792);
});

test('saved display settings validate current fields and default invalid preferences', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  let stored = '{}';
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => stored },
  });
  try {
    stored = JSON.stringify({ economy: true, quality: 'low', inputLayout: 'wasd' });
    const settings = readSettings();
    assert.equal(settings.economy, true);
    assert.equal(settings.inputLayout, 'wasd');
    assert.equal(settings.quality, 'low');
    assert.equal(settings.teamLayout, 'split');
    assert.equal(settings.cameraFov, 73.74);
    stored = JSON.stringify({
      teamLayout: 'right',
      cameraFov: 110,
      crosshairStyle: { color: '#00aaff', length: 500, opacity: -1, tStyle: true },
    });
    const saved = readSettings();
    assert.equal(saved.teamLayout, 'right');
    assert.equal(saved.cameraFov, 110);
    assert.equal(saved.crosshairStyle.color, '#00aaff');
    assert.equal(saved.crosshairStyle.length, 24);
    assert.equal(saved.crosshairStyle.opacity, 0);
    assert.equal(saved.crosshairStyle.tStyle, true);
    for (const value of [
      null,
      'malformed',
      {
        teamLayout: 'left',
        cameraFov: 1000,
        crosshairStyle: { color: 'url(https://invalid.example)' },
      },
    ]) {
      stored = typeof value === 'string' ? value : JSON.stringify(value);
      assert.equal(readSettings().teamLayout, 'split');
      assert.equal(readSettings().cameraFov, 73.74);
      assert.equal(readSettings().crosshairStyle.color, defaultSettings.crosshairStyle.color);
    }
    stored = 'malformed';
    const fallback = readSettings();
    fallback.economy = false;
    assert.equal(readSettings().economy, true);
    assert.equal(readSettings().reviewFeed, true);
    assert.equal(readSettings(true).economy, false);
    assert.equal(readSettings(true).reviewFeed, false);
    assert.equal(readSettings(true).cameraFov, 73.74);
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
