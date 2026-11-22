import { fulfillReplayFixture } from './fixtures/streamed-replay';
import { expect, test, type Page, type Route } from '@playwright/test';
import { originalMapReplay } from './fixtures/original-map';
import { installMapFixture } from './fixtures/map-assets';
import { originalAnimatedAgentGLB } from './fixtures/original-agent';

async function viewer(page: Page, catalog: (route: Route) => Promise<unknown>) {
  const data = originalMapReplay();
  await page.addInitScript(() => {
    localStorage.setItem('cswatch.language', 'en');
    localStorage.setItem(
      'viewer-settings',
      JSON.stringify({ autoHideControls: false, quality: 'low', gameSounds: false }),
    );
  });
  await page.clock.install();
  await page.route('**/api/demos/discovery-fixture', (route) =>
    route.fulfill({
      json: {
        id: 'discovery-fixture',
        name: 'Original asset discovery QA',
        status: 'ready',
        public: true,
        owned: false,
        map: data.map,
      },
    }),
  );
  await page.route('**/api/demos/discovery-fixture/playback', (route) =>
    fulfillReplayFixture(route, data),
  );
  await installMapFixture(page, data.map, 'discovery-fixture');
  await page.route('**/api/assets/agents', catalog);
  await page.route('**/map-assets/agents/*.glb', (route) =>
    route.fulfill({ contentType: 'model/gltf-binary', body: originalAnimatedAgentGLB() }),
  );
  await page.goto('/watch/discovery-fixture');
  await expect(page.locator('.scene')).toHaveAttribute('data-map-model-state', 'ready');
  await page.clock.pauseAt(new Date((await page.evaluate(() => Date.now())) + 100));
}
test('newly prepared agents are discovered progressively, preserve a valid partial catalog on transient failure and stop polling when complete', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  let reads = 0;
  await viewer(page, async (route) => {
    reads++;
    if (reads === 3) return route.fulfill({ status: 503, json: {} });
    return route.fulfill({
      json: {
        ct: reads >= 2 ? '/map-assets/agents/ct.glb' : null,
        t: reads >= 4 ? '/map-assets/agents/t.glb' : null,
      },
    });
  });
  const scene = page.locator('.scene');
  await expect.poll(() => reads).toBe(1);
  await expect(scene).toHaveAttribute('data-agent-model-state', 'missing');
  await page.clock.runFor(2100);
  await expect.poll(() => reads).toBe(2);
  await expect(scene).toHaveAttribute('data-agent-model-state', 'ready');
  await page.clock.runFor(5100);
  await expect.poll(() => reads).toBe(3);
  await expect(scene).toHaveAttribute('data-agent-model-state', 'ready');
  await page.clock.runFor(15100);
  await expect.poll(() => reads).toBe(4);
  await expect(scene).toHaveAttribute('data-agent-model-state', 'ready');
  // Embedded GLB parsing settles independently of the mocked transport clock.
  // Continue actual renderer frames while waiting for both active instances.
  await expect
    .poll(async () => {
      await page.clock.runFor(50);
      return scene.getAttribute('data-agent-ready-count');
    })
    .toBe('2');
  await page.clock.fastForward(60000);
  expect(reads).toBe(4);
});
test('unauthorized discovery stops and a mounted empty catalog lease expires after45minutes', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  let reads = 0;
  await viewer(page, async (route) => {
    reads++;
    return route.fulfill({ status: 403, json: {} });
  });
  await expect(page.locator('.scene')).toHaveAttribute('data-agent-model-state', 'error');
  await page.clock.fastForward(60000);
  expect(reads).toBe(1);
  // A new mounted viewer generation starts a fresh read-only lease.
  await page.unroute('**/api/assets/agents');
  await page.route('**/api/assets/agents', async (route) => {
    reads++;
    return route.fulfill({ json: { ct: null, t: null } });
  });
  await page.clock.resume();
  await page.reload();
  await expect(page.locator('.scene')).toHaveAttribute('data-agent-model-state', 'missing');
  await page.clock.pauseAt(new Date((await page.evaluate(() => Date.now())) + 100));
  const before = reads;
  await page.clock.fastForward(45 * 60 * 1000 + 1000);
  expect(reads).toBe(before);
});
test('timed-out discovery cannot publish its late response and leaving the viewer cancels future reads', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  let reads = 0,
    release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await viewer(page, async (route) => {
    reads++;
    if (reads === 1) {
      await held;
      return route.fulfill({ json: { ct: null, t: null } }).catch(() => {});
    }
    return route.fulfill({ json: { ct: '/map-assets/agents/ct.glb', t: null } });
  });
  await page.clock.runFor(10100);
  await expect(page.locator('.scene')).toHaveAttribute('data-agent-model-state', 'error');
  await page.clock.runFor(2100);
  await expect.poll(() => reads).toBe(2);
  await expect(page.locator('.scene')).toHaveAttribute('data-agent-model-state', 'ready');
  release();
  await page.clock.runFor(100);
  await expect(page.locator('.scene')).toHaveAttribute('data-agent-model-state', 'ready');
  await page.goto('/');
  await page.clock.fastForward(60000);
  expect(reads).toBe(2);
});
