import { expect, test } from '@playwright/test';
import { AdaptiveResolution } from '../src/adaptive-resolution';

test('adaptive resolution reacts to sustained load within its floor and user ceiling', () => {
  const monitor = new AdaptiveResolution();
  let now = 0;
  let quality = { resolution: 85, shadows: true };
  const advance = (frames: number, duration: number) => {
    for (let index = 0; index < frames; index++) {
      now += duration;
      quality = monitor.sample(now, quality, 85);
    }
  };
  advance(100, 16);
  advance(1, 300);
  advance(30, 16);
  expect(quality.resolution).toBe(85);
  advance(50, 35);
  expect(quality.resolution).toBe(75);
  advance(250, 40);
  expect(quality).toEqual({ resolution: 50, shadows: false });
  monitor.reset();
  advance(47, 16);
  advance(119, 16);
  expect(quality.resolution).toBe(50);
  advance(10, 16);
  expect(quality.resolution).toBe(60);
  advance(900, 16);
  expect(quality).toEqual({ resolution: 85, shadows: true });
});

test('idle time and samples from a previous playback interval do not trigger a downgrade', () => {
  const monitor = new AdaptiveResolution();
  const quality = { resolution: 100, shadows: true };
  for (let frame = 0; frame < 46; frame++)
    expect(monitor.sample(frame * 45, quality, 100)).toBe(quality);
  monitor.reset();
  expect(monitor.sample(32000, quality, 100)).toBe(quality);
  for (let frame = 1; frame < 40; frame++)
    expect(monitor.sample(32000 + frame * 16, quality, 100)).toBe(quality);
});
