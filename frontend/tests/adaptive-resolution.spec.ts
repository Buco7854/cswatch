import { expect, test } from '@playwright/test';
import { AdaptiveResolution, adaptiveDetailDpr } from '../src/adaptive-resolution';

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
  advance(300, 40);
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

test('Auto responds to repeated stalls that dominate playback time even among short frames', () => {
  const monitor = new AdaptiveResolution();
  let quality = { resolution: 100, shadows: true };
  let now = 0;
  function frame(duration: number) {
    now += duration;
    quality = monitor.sample(now, quality, 100);
  }
  for (let i = 0; i < 60; i++) frame(16);
  // Two isolated long frames do not trigger the emergency response.
  for (let i = 0; i < 2; i++) {
    frame(300);
    for (let smooth = 0; smooth < 3; smooth++) frame(16);
  }
  expect(quality).toEqual({ resolution: 100, shadows: true });
  frame(300);
  expect(quality).toEqual({ resolution: 100, shadows: false });
  // Continued pressure can still reach the emergency floor.
  for (let i = 0; i < 14; i++) frame(350);
  expect(quality).toEqual({ resolution: 50, shadows: false });
});

test('detailed high-density rendering respects the chosen ceiling and the emergency pixel floor', () => {
  expect(adaptiveDetailDpr(2, 100, 100)).toBe(2);
  expect(adaptiveDetailDpr(2, 85, 85)).toBe(1.7);
  expect(adaptiveDetailDpr(2, 75, 100)).toBe(1.25);
  expect(adaptiveDetailDpr(2, 50, 100)).toBe(0.5);
  expect(adaptiveDetailDpr(2, 50, 50)).toBe(1);
  expect(adaptiveDetailDpr(1, 75, 100)).toBe(0.75);
});
