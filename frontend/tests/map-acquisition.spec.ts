import { accountStatus, configForSyntheticAccount } from './fixtures/account-status';
import { fulfillReplayFixture } from './fixtures/streamed-replay';
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
const latestSelection = {
  map: qaMap,
  appId: 730,
  depotId: 2347770,
  manifest: '12345678901234567890',
  sha1: 'c'.repeat(40),
  bytes: 128000,
};
const latestEligible = {
  ...eligible,
  resolution: {
    status: 'latest',
    selection: latestSelection,
    inventoryUpdatedAt: 1795000000,
    source: null,
  },
  packId: null,
};
const latestReady = {
  ...ready,
  resolution: {
    ...latestEligible.resolution,
    source: {
      appId: 730,
      depotId: 2347770,
      manifest: latestSelection.manifest,
      mapSha256: 'd'.repeat(64),
    },
  },
  verification: 'latest-official',
};
async function install(page: Page, controlsHidden = false) {
  await page.addInitScript((controlsHidden) => {
    localStorage.setItem('cswatch.language', 'en');
    localStorage.setItem(
      'viewer-settings-v2',
      JSON.stringify({
        controlsHidden,
        autoHideControls: false,
        killReplay: false,
        grenadeLanding: false,
        matchScore: false,
        crosshair: false,
      }),
    );
  }, controlsHidden);
  await configForSyntheticAccount(page);
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      json: {
        ...accountStatus(null),
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
      fulfillReplayFixture(route, originalMapReplay()),
    );
  }
  let directDiscoveryRequests = 0;
  await page.route('**/api/maps/*', (route) => {
    directDiscoveryRequests++;
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
  return () => directDiscoveryRequests;
}
async function navigate(page: Page, id: string) {
  await page.evaluate((path) => {
    history.pushState({}, '', path);
    dispatchEvent(new PopStateEvent('popstate'));
  }, '/watch/' + id);
}

test('map discovery overlaps replay loading and preparation waits for a readable replay', async ({
  page,
}) => {
  await install(page, true);
  let resumeManifest!: () => void;
  const manifest = new Promise<void>((resolve) => (resumeManifest = resolve));
  const preparing = { ...eligible, canAcquire: false, acquisition: 'processing' };
  let workerFinished = false;
  let reads = 0;
  let requests = 0;
  await page.route('**/api/demos/acquisition-a/playback', async (route) => {
    await manifest;
    await route.fallback();
  });
  await page.route('**/api/demos/acquisition-a/map-assets', (route) => {
    if (route.request().method() === 'POST') requests++;
    else reads++;
    return route.fulfill({
      json: workerFinished ? ready : requests ? preparing : eligible,
    });
  });
  await page.goto('/watch/acquisition-a');
  await expect.poll(() => reads).toBe(1);
  expect(requests).toBe(0);
  resumeManifest();
  const loading = page.locator('.viewer-map-loading');
  await expect(loading.getByRole('heading')).toHaveText('Preparing map assets');
  await expect(loading.getByRole('progressbar')).toHaveAttribute('data-indeterminate', 'true');
  await expect(page.getByRole('region', { name: 'Playback controls' })).toHaveCount(0);
  await expect(loading.getByRole('link', { name: 'Back to home' })).toBeInViewport();
  await loading.getByRole('button', { name: 'Open timeline' }).press('Enter');
  await expect(loading).toHaveCount(0);
  await expect(page.locator('.viewer-crosshair,.viewer-scope')).toHaveCount(0);
  const timeline = page.locator('.timeline-slider');
  await expect(timeline).toBeFocused();
  const start = Number(await timeline.inputValue());
  await timeline.press('ArrowRight');
  await expect.poll(async () => Number(await timeline.inputValue())).toBeGreaterThan(start);
  const modelRequested = Promise.withResolvers<void>();
  const modelResponse = Promise.withResolvers<void>();
  await page.route('**/api/map-packs/*/models/*/*/scene.glb', async (route) => {
    modelRequested.resolve();
    await modelResponse.promise;
    await route.fallback();
  });
  workerFinished = true;
  try {
    await modelRequested.promise;
    await expect(loading).toHaveCount(0);
    await expect(timeline).toBeFocused();
  } finally {
    modelResponse.resolve();
  }
  await expect(page.locator('.scene')).toHaveAttribute('data-map-model-state', 'ready');
  expect(requests).toBe(1);
  await page.route('**/api/demos/acquisition-b/map-assets', (route) =>
    route.fulfill({ json: preparing }),
  );
  await navigate(page, 'acquisition-b');
  await expect(loading.getByRole('heading')).toHaveText('Preparing map assets');
});

test('guest-owned demo acquires only its approved immutable pack once and observes queued processing ready status', async ({
  page,
}) => {
  const directDiscoveryRequests = await install(page);
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
    page
      .locator('.viewer-map-loading')
      .getByRole('heading', { name: 'Map preparation queued', exact: true }),
  ).toBeVisible();
  revealProcessing();
  await expect(
    page
      .locator('.viewer-map-loading')
      .getByRole('heading', { name: 'Preparing map assets', exact: true }),
  ).toBeVisible();
  revealReady();
  await expect(page.locator('.scene')).toHaveAttribute('data-map-model-state', 'ready');
  await expect(page.locator('.viewer-map-status')).toHaveText('3D map');
  await expect(page.locator('.position-radar')).toBeVisible();
  expect(posts).toBe(1);
  expect(directDiscoveryRequests()).toBe(0);
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await page.getByRole('tab', { name: 'Performance', exact: true }).click();
  await expect(page.locator('[data-map-verification="operator-approved"]')).toContainText(
    'not cryptographic proof',
  );
});

test('unknown ambiguous disabled and unavailable-worker states never enqueue or substitute a familiar map', async ({
  page,
}) => {
  const directDiscoveryRequests = await install(page);
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
  expect(directDiscoveryRequests()).toBe(0);
});

test('leaving a same-map demo discards its delayed approval and cannot enqueue for the next demo', async ({
  page,
}) => {
  const directDiscoveryRequests = await install(page);
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
    page
      .locator('.viewer-map-loading')
      .getByRole('heading', { name: 'Loading map assets…', exact: true }),
  ).toBeVisible();
  await navigate(page, 'acquisition-b');
  await expect(page.locator('.map-unavailable p')).toContainText('No operator-approved');
  release();
  await expect(page.locator('.map-unavailable p')).toContainText('No operator-approved');
  expect(posts).toBe(0);
  expect(directDiscoveryRequests()).toBe(0);
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
    const loading = page.locator('.viewer-map-loading');
    await expect(loading.getByRole('heading')).toHaveText('Requesting map preparation');
    await loading.getByRole('button', { name: 'Open timeline' }).click();
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
    page
      .locator('.viewer-map-loading')
      .getByRole('heading', { name: 'Map preparation queued', exact: true }),
  ).toBeVisible();
  expect(posts).toBe(1);
});

test('an unavailable exact source can select one distinct latest job without replaying its lost enqueue response', async ({
  page,
}) => {
  const directDiscoveryRequests = await install(page);
  let posts = 0,
    gets = 0;
  await page.route('**/api/demos/acquisition-a/map-assets', (route) => {
    if (route.request().method() === 'POST') {
      posts++;
      expect(route.request().postDataJSON()).toEqual({});
      if (posts === 1)
        return route.fulfill({
          status: 202,
          json: { ...eligible, canAcquire: false, acquisition: 'queued' },
        });
      return route.abort('failed');
    }
    gets++;
    // The server, never the browser, resolves the approved source's unavailable
    // result to a fixed official selection. A lost POST remains uncertain.
    return route.fulfill({ json: gets === 1 ? eligible : latestEligible });
  });
  await page.goto('/watch/acquisition-a');
  await expect(page.locator('.map-unavailable p')).toContainText(
    'The preparation request could not be confirmed',
  );
  expect(posts).toBe(2);
  expect(gets).toBe(3);
  await page.clock.install();
  await page.clock.fastForward(600000);
  expect(posts).toBe(2);
  expect(gets).toBe(3);
  expect(directDiscoveryRequests()).toBe(0);
  await expect(page).toHaveURL(/\/watch\/acquisition-a$/);
});

test('latest ready maps disclose layout uncertainty and raw recorded identity in progressive responsive details', async ({
  page,
}) => {
  const directDiscoveryRequests = await install(page);
  const recorded = {
    map: qaMap,
    buildNum: 17000,
    patchVersion: 14100,
    demoVersionGuid: '12345678-1234-1234-1234-123456789abc',
    addonPresence: 'none',
  };
  await page.route('**/api/demos/acquisition-a/playback', (route) =>
    fulfillReplayFixture(route, { ...originalMapReplay(), mapIdentity: recorded }),
  );
  let posts = 0;
  await page.route('**/api/demos/acquisition-a/map-assets', (route) => {
    if (route.request().method() === 'POST') posts++;
    return route.fulfill({ json: latestReady });
  });
  await page.goto('/watch/acquisition-a');
  await expect(page.locator('.scene')).toHaveAttribute('data-map-model-state', 'ready');
  const badge = page.locator('.viewer-map-verification');
  await expect(badge).toContainText('Latest official map');
  await expect(badge).toHaveAttribute('title', /layout may differ/);
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await page.getByRole('tab', { name: 'Performance', exact: true }).click();
  const provenance = page.locator('section[data-map-verification="latest-official"]');
  await expect(provenance).toContainText('not a verified historical match');
  await expect(provenance.getByText(recorded.demoVersionGuid, { exact: true })).toBeHidden();
  await provenance.getByText('Version details', { exact: true }).click();
  await expect(provenance.getByText(recorded.demoVersionGuid, { exact: true })).toBeVisible();
  await expect(provenance.getByText('17000', { exact: true })).toBeVisible();
  await expect(provenance.getByText('14100', { exact: true })).toBeVisible();
  await expect(provenance.getByText(latestSelection.manifest, { exact: true })).toBeVisible();
  await expect(provenance).toContainText('do not identify a Steam manifest');
  for (const theme of ['dark', 'light']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 844 });
      const dialog = page.locator('.viewer-options-dialog');
      expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      expect(
        await provenance.evaluate((element) => element.scrollWidth <= element.clientWidth),
      ).toBe(true);
      const contentPack = provenance.getByText(pack, { exact: true });
      await contentPack.scrollIntoViewIfNeeded();
      await expect(contentPack).toBeInViewport({ ratio: 1 });
      await expect(provenance.getByText('d'.repeat(64), { exact: true })).toBeVisible();
    }
  }
  expect(posts).toBe(0);
  expect(directDiscoveryRequests()).toBe(0);
});

test('a different eligible source returned by enqueue is observed before one new request and its lost response never replays', async ({
  page,
}) => {
  const directDiscoveryRequests = await install(page);
  let posts = 0,
    gets = 0;
  await page.route('**/api/demos/acquisition-a/map-assets', (route) => {
    if (route.request().method() === 'POST') {
      posts++;
      expect(route.request().postDataJSON()).toEqual({});
      if (posts === 1) return route.fulfill({ status: 202, json: latestEligible });
      expect(gets).toBe(2);
      // A new selection is a distinct authorized intent. A lost reply must not
      // replay that intent even when the following read still reports eligible.
      return route.abort('failed');
    }
    gets++;
    return route.fulfill({ json: gets === 1 ? eligible : latestEligible });
  });
  await page.goto('/watch/acquisition-a');
  await expect(page.locator('.map-unavailable p')).toContainText(
    'The preparation request could not be confirmed',
  );
  expect(posts).toBe(2);
  expect(gets).toBe(3);
  await page.clock.install();
  await page.clock.fastForward(600000);
  expect(posts).toBe(2);
  expect(gets).toBe(3);
  expect(directDiscoveryRequests()).toBe(0);
});

test('worker bootstrap recovers from missing and stale official inventory then requests the disclosed latest source once', async ({
  page,
}) => {
  const directDiscoveryRequests = await install(page);
  await page.clock.install();
  let stage: 'worker_unavailable' | 'inventory_unavailable' | 'inventory_stale' | 'fresh' =
      'worker_unavailable',
    posts = 0,
    accepted = false;
  await page.route('**/api/demos/acquisition-a/map-assets', (route) => {
    if (route.request().method() === 'POST') {
      posts++;
      expect(stage).toBe('fresh');
      expect(route.request().postDataJSON()).toEqual({});
      expect(route.request().headers()['x-csrf-token']).toBe('original-guest-capability');
      accepted = true;
      return route.fulfill({
        status: 202,
        json: { ...latestEligible, canAcquire: false, acquisition: 'queued' },
      });
    }
    return route.fulfill({
      json:
        stage === 'fresh'
          ? accepted
            ? latestReady
            : latestEligible
          : {
              ...eligible,
              resolution: { status: 'unmapped' },
              packId: null,
              canAcquire: false,
              readinessReason: stage,
            },
    });
  });
  await page.goto('/watch/acquisition-a');
  await expect(page.locator('.map-unavailable p')).toContainText(
    'assets service is not responding',
  );
  expect(posts).toBe(0);
  stage = 'inventory_unavailable';
  await page.clock.runFor(2001);
  await expect(page.locator('.map-unavailable p')).toContainText('valid official map list');
  expect(posts).toBe(0);
  stage = 'inventory_stale';
  await page.clock.runFor(5001);
  await expect(page.locator('.map-unavailable p')).toContainText('refresh its official map list');
  expect(posts).toBe(0);
  stage = 'fresh';
  await page.clock.runFor(15001);
  await expect.poll(() => posts).toBe(1);
  await page.clock.runFor(2001);
  await expect(page.locator('.viewer-map-status')).toHaveText('3D map');
  await expect(page.locator('.viewer-map-verification')).toContainText('Latest official map');
  await expect(page.locator('.viewer-map-verification')).toHaveAttribute(
    'title',
    /layout may differ/,
  );
  expect(posts).toBe(1);
  expect(directDiscoveryRequests()).toBe(0);
});
