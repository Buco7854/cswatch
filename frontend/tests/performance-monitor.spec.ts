import { expect, test } from '@playwright/test';
import { LONG_FRAME_MS, PerformanceMonitor } from '../src/performance-monitor';

test('summarises frame pacing over the recent window only', () => {
  const monitor = new PerformanceMonitor();
  let now = 0;
  // Old frames outside the window must not count.
  for (let i = 0; i < 50; i++) monitor.frame((now += 200));
  const start = now + 5000;
  now = start;
  monitor.frame(now);
  for (let i = 0; i < 119; i++) monitor.frame((now += 1000 / 60));
  monitor.frame((now += 80));
  monitor.frame((now += 1000 / 60));
  const summary = monitor.summary(now);
  expect(summary.frames).toBe(122);
  expect(summary.long).toBe(1);
  expect(summary.worst).toBeCloseTo(80, 5);
  expect(summary.p50).toBeCloseTo(1000 / 60, 5);
  expect(summary.p95).toBeCloseTo(1000 / 60, 5);
  expect(summary.fps).toBeCloseTo((121 * 1000) / (now - start), 5);
  expect(LONG_FRAME_MS).toBe(50);
});

test('reports idle without frames and adds world and three counters', () => {
  const monitor = new PerformanceMonitor();
  expect(monitor.summary(1000)).toMatchObject({ fps: 0, frames: 0, p50: 0, worst: 0, long: 0 });
  monitor.world = { draws: 90, triangles: 500_000, textureBytes: 1, bufferBytes: 2 };
  monitor.extra = { draws: 20, triangles: 40_000 };
  expect(monitor.summary(1000)).toMatchObject({ draws: 110, triangles: 540_000 });
  monitor.reset();
  expect(monitor.summary(1000)).toMatchObject({ draws: 0, triangles: 0, frames: 0 });
});

test('keeps a bounded ring of timestamps', () => {
  const monitor = new PerformanceMonitor();
  for (let i = 0; i < 5000; i++) monitor.frame(i);
  const summary = monitor.summary(4999, 100000);
  expect(summary.frames).toBe(1024);
  expect(summary.worst).toBe(1);
});
