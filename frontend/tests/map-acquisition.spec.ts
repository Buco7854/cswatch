import { test, expect, type Page } from '@playwright/test';
import {
  originalMapReplay,
  originalMapGLB,
  originalOverviewPNG,
  originalEnvironmentPNG,
  qaMap,
  qaOverview,
} from './fixtures/original-map';
test.beforeEach(() => {
  test.skip(
    Boolean(process.env.E2E_PRIVATE) || Boolean(process.env.E2E_SETUP),
    'Guest acquisition fixtures require initialized public access. Private entry is verified separately.',
  );
});
const pack = 'a'.repeat(64),
  empty = { model: null, mobile: null, overview: null, environment: null };
const eligible = {
  resolution: { status: 'approved', packId: pack },
  canAcquire: true,
  acquisition: 'unavailable',
  verification: 'unavailable',
  packId: pack,
  assets: empty,
};
const ready = {
  ...eligible,
  canAcquire: false,
  acquisition: 'ready',
  verification: 'operator-approved',
  assets: {
    model: `/api/map-packs/${pack}/models/${qaMap}/desktop/scene.glb`,
    mobile: `/api/map-packs/${pack}/models/${qaMap}/mobile/scene.glb`,
    overview: { ...qaOverview, image: `/api/map-packs/${pack}/maps/${qaMap}/overview.png` },
    environment: {
      assetVersion: 'original-qa-acquisition',
      landscape: false,
      sky: {
        faces: ['px', 'nx', 'py', 'ny', 'pz', 'nz'].map(
          (face) => `/api/map-packs/${pack}/maps/${qaMap}/environment/${face}.png`,
        ),
        brightness: 1,
      },
    },
  },
};
async function install(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('cswatch.language', 'en');
    localStorage.setItem(
      'viewer-settings',
      JSON.stringify({
        autoHideControls: false,
        killReplay: false,
        grenadeLanding: false,
        matchScore: false,
        crosshair: false,
      }),
    );
  });
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      json: {
        user: null,
        guest_session: { csrf: 'original-guest-capability', expires_at: 2000000000 },
      },
    }),
  );
  for (const id of ['acquisition-a', 'acquisition-b']) {
    await page.route(`**/api/demos/${id}`, (route) =>
      route.fulfill({
        json: {
          id,
          name: 'Original synthetic acquisition QA',
          status: 'ready',
          guest_owned: true,
          owned: false,
          public: false,
          map: qaMap,
        },
      }),
    );
    await page.route(`**/api/demos/${id}/playback`, (route) =>
      route.fulfill({ json: originalMapReplay() }),
    );
  }
  let legacy = 0;
  await page.route('**/api/maps/*', (route) => {
    legacy++;
    return route.abort();
  });
  await page.route(`**/api/map-packs/${pack}/models/${qaMap}/*/scene.glb`, (route) =>
    route.fulfill({ contentType: 'model/gltf-binary', body: originalMapGLB() }),
  );
  await page.route(`**/api/map-packs/${pack}/maps/${qaMap}/overview.png`, (route) =>
    route.fulfill({ contentType: 'image/png', body: originalOverviewPNG() }),
  );
  await page.route(`**/api/map-packs/${pack}/maps/${qaMap}/environment/*.png`, (route) =>
    route.fulfill({
      contentType: 'image/png',
      body: originalEnvironmentPNG(
        ['px', 'nx', 'py', 'ny', 'pz', 'nz'].indexOf(
          route.request().url().split('/').pop()!.replace('.png', ''),
        ),
      ),
    }),
  );
  return () => legacy;
}
async function navigate(page: Page, id: string) {
  await page.evaluate((path) => {
    history.pushState({}, '', path);
    dispatchEvent(new PopStateEvent('popstate'));
  }, '/watch/' + id);
}

test('guest-owned demo acquires only its approved immutable pack once and observes queued processing ready status', async ({
  page,
}) => {
  const legacy = await install(page);
  let posts = 0,
    gets = 0,
    accepted = false,
    revealProcessing = () => {},
    revealReady = () => {};
  const processing = new Promise<void>((resolve) => (revealProcessing = resolve)),
    prepared = new Promise<void>((resolve) => (revealReady = resolve));
  await page.route('**/api/demos/acquisition-a/map-assets', async (route) => {
    if (route.request().method() === 'POST') {
      posts++;
      expect(route.request().postDataJSON()).toEqual({});
      expect(route.request().headers()['x-csrf-token']).toBe('original-guest-capability');
      accepted = true;
      return route.fulfill({
        status: 202,
        json: { ...eligible, canAcquire: false, acquisition: 'queued' },
      });
    }
    gets++;
    if (accepted) await (gets < 3 ? processing : prepared);
    return route.fulfill({
      json: !accepted
        ? eligible
        : gets < 3
          ? { ...eligible, canAcquire: false, acquisition: 'processing' }
          : ready,
    });
  });
  await page.goto('/watch/acquisition-a');
  await expect(
    page.locator('.scene').getByRole('status', { name: 'Map preparation queued', exact: true }),
  ).toBeVisible();
  revealProcessing();
  await expect(
    page.locator('.scene').getByRole('status', { name: 'Preparing map assets', exact: true }),
  ).toBeVisible();
  revealReady();
  await expect(page.locator('.scene')).toHaveAttribute('data-map-model-state', 'ready');
  await expect(page.locator('.viewer-map-status')).toHaveText('3D map');
  await expect(page.locator('.position-radar')).toBeVisible();
  expect(posts).toBe(1);
  expect(legacy()).toBe(0);
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await page.getByRole('tab', { name: 'Performance', exact: true }).click();
  await expect(page.locator('[data-map-verification="operator-approved"]')).toContainText(
    'not cryptographic proof',
  );
});

test('unknown ambiguous disabled and unavailable-worker states never enqueue or substitute a familiar map', async ({
  page,
}) => {
  const legacy = await install(page);
  let posts = 0;
  let state: unknown;
  await page.route('**/api/demos/acquisition-a/map-assets', (route) => {
    if (route.request().method() === 'POST') posts++;
    return route.fulfill({ json: state });
  });
  const cases = [
    ['unknown', 'unavailable', 'enough map identity evidence'],
    ['unmapped', 'unavailable', 'No operator-approved'],
    ['addon', 'unavailable', 'add-on map'],
    ['ambiguous', 'unavailable', 'resolve the ambiguity'],
    ['catalog_invalid', 'unavailable', 'catalog could not be validated'],
    ['approved', 'unavailable', 'No preparation worker'],
    ['unknown', 'disabled', 'Automatic map preparation is disabled'],
  ];
  for (const [status, acquisition, copy] of cases) {
    state = {
      ...eligible,
      resolution: status === 'approved' ? eligible.resolution : { status },
      canAcquire: false,
      acquisition,
      packId: status === 'approved' ? pack : null,
    };
    await page.goto('/watch/acquisition-a');
    await expect(page.locator('.map-unavailable p')).toContainText(copy);
    await expect(page.locator('.scene canvas,.tactical-plot,.position-radar')).toHaveCount(0);
  }
  expect(posts).toBe(0);
  expect(legacy()).toBe(0);
});

test('leaving a same-map demo discards its delayed approval and cannot enqueue for the next demo', async ({
  page,
}) => {
  const legacy = await install(page);
  let release = () => {},
    posts = 0;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/demos/acquisition-a/map-assets', async (route) => {
    if (route.request().method() === 'POST') {
      posts++;
      return route.fulfill({ json: eligible });
    }
    await gate;
    await route.fulfill({ json: eligible }).catch(() => {});
  });
  await page.route('**/api/demos/acquisition-b/map-assets', (route) =>
    route.fulfill({
      json: { ...eligible, resolution: { status: 'unmapped' }, canAcquire: false, packId: null },
    }),
  );
  await page.goto('/watch/acquisition-a');
  await expect(
    page.locator('.scene').getByRole('status', { name: 'Loading map assets…', exact: true }),
  ).toBeVisible();
  await navigate(page, 'acquisition-b');
  await expect(page.locator('.map-unavailable p')).toContainText('No operator-approved');
  release();
  await expect(page.locator('.map-unavailable p')).toContainText('No operator-approved');
  expect(posts).toBe(0);
  expect(legacy()).toBe(0);
});

test('lost enqueue response is observed without duplicate POST and terminal preparation failure stops polling', async ({
  page,
}) => {
  await install(page);
  let posts = 0,
    gets = 0,
    accepted = false;
  await page.route('**/api/demos/acquisition-a/map-assets', (route) => {
    if (route.request().method() === 'POST') {
      posts++;
      accepted = true;
      return route.abort('failed');
    }
    gets++;
    return route.fulfill({
      json: accepted
        ? { ...eligible, canAcquire: false, acquisition: 'failed', code: 'source_mismatch' }
        : eligible,
    });
  });
  await page.goto('/watch/acquisition-a');
  await expect(
    page.locator('.scene').getByRole('status', { name: 'Map preparation failed', exact: true }),
  ).toBeVisible();
  expect(posts).toBe(1);
  expect(gets).toBe(2);
  await page.clock.install();
  await page.clock.fastForward(60000);
  expect(posts).toBe(1);
  expect(gets).toBe(2);
  await expect(page.locator('.scene canvas,.tactical-plot')).toHaveCount(0);
});

test('eligible failed jobs require an explicit retry and serialize repeated clicks without an automatic retry loop', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 360 });
  await install(page);
  let posts = 0,
    release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/demos/acquisition-a/map-assets', async (route) => {
    if (route.request().method() === 'POST') {
      posts++;
      await gate;
      return route.fulfill({
        json: { ...eligible, canAcquire: false, acquisition: 'failed', code: 'source_mismatch' },
      });
    }
    return route.fulfill({
      json: { ...eligible, acquisition: 'failed', code: 'source_unavailable' },
    });
  });
  try {
    await page.goto('/watch/acquisition-a');
    const retry = page.getByRole('button', { name: 'Retry map preparation', exact: true });
    await expect(retry).toBeVisible();
    await expect(page.getByRole('group', { name: 'Moment shortcuts', exact: true })).toHaveCount(0);
    expect(posts).toBe(0);
    await retry.scrollIntoViewIfNeeded();
    const retryBox = await retry.boundingBox(),
      deck = await page.locator('.viewer-dock').boundingBox();
    expect(retryBox!.y + retryBox!.height).toBeLessThan(deck!.y - 4);
    await retry.click();
    await expect(
      page.getByRole('button', { name: 'Requesting map preparation', exact: true }),
    ).toBeDisabled();
    await page
      .getByRole('button', { name: 'Requesting map preparation', exact: true })
      .evaluate((button) => {
        (button as HTMLButtonElement).click();
        (button as HTMLButtonElement).click();
      });
    await expect.poll(() => posts).toBe(1);
    release();
    await expect(retry).toHaveCount(0);
    await expect(page.getByRole('group', { name: 'Moment shortcuts', exact: true })).toBeVisible();
    await expect(page.locator('.map-unavailable p')).toContainText(
      'do not match the approved map version',
    );
    await page.clock.install();
    await page.clock.fastForward(600000);
    expect(posts).toBe(1);
  } finally {
    release();
  }
});

test('failed-job cooldown is checked sparsely and becoming eligible never enqueues until Retry is clicked', async ({
  page,
}) => {
  await install(page);
  await page.clock.install();
  let gets = 0,
    posts = 0;
  await page.route('**/api/demos/acquisition-a/map-assets', (route) => {
    if (route.request().method() === 'POST') {
      posts++;
      return route.fulfill({
        status: 202,
        json: { ...eligible, canAcquire: false, acquisition: 'queued' },
      });
    }
    gets++;
    return route.fulfill({
      json: { ...eligible, canAcquire: gets >= 2, acquisition: 'failed', code: 'storage_limit' },
    });
  });
  await page.goto('/watch/acquisition-a');
  await expect(page.locator('.map-unavailable p')).toContainText('configured storage limit');
  await expect(
    page.getByRole('button', { name: 'Retry map preparation', exact: true }),
  ).toHaveCount(0);
  await page.clock.fastForward(59000);
  expect(gets).toBe(1);
  expect(posts).toBe(0);
  await page.clock.fastForward(1000);
  const retry = page.getByRole('button', { name: 'Retry map preparation', exact: true });
  await expect(retry).toBeVisible();
  expect(gets).toBe(2);
  expect(posts).toBe(0);
  await retry.click();
  await expect(
    page.locator('.scene').getByRole('status', { name: 'Map preparation queued', exact: true }),
  ).toBeVisible();
  expect(posts).toBe(1);
});
