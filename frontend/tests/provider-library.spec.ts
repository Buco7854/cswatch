import { expect, test, type Page, type Route } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { installMemberWorkspace, memberDemos, memberUser } from './fixtures/member-workspace';

test.beforeEach(() => {
  test.skip(Boolean(process.env.E2E_PRIVATE) || Boolean(process.env.E2E_SETUP));
});

const faceitMatch = {
  match_id: 'room-fixture-1',
  competition: 'Fixture League',
  played_at: 1794930000,
  teams: [
    { name: 'North District', score: 13 },
    { name: 'Southside', score: 8 },
  ],
  result: 'win',
  map: 'de_mirage',
  demos: [],
};
const code = 'CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2xK';
const steamMatches = [
  { match_id: '3230642215713767580', share_code: code, demos: [] },
  {
    match_id: '2811123475613000001',
    share_code: code,
    demos: [{ id: 'member-design-0', status: 'ready', map: 'de_ancient', score: [13, 11] }],
  },
  {
    match_id: '2811123475613000002',
    share_code: code,
    demos: [{ id: 'member-design-1', status: 'processing' }],
  },
  {
    match_id: '2811123475613000003',
    share_code: code,
    demos: [{ id: 'member-design-3', status: 'failed' }],
  },
];

async function installSources(page: Page, steam = true, faceit = true, canDownload = () => faceit) {
  await installMemberWorkspace(page);
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      json: {
        user: {
          ...memberUser,
          is_admin: false,
          match_sources: {
            steam,
            faceit,
            faceit_download: canDownload(),
            faceit_verification: faceit ? 'ready' : 'unavailable',
          },
          identities: [...memberUser.identities, { provider: 'faceit', subject: 'fixture' }],
        },
      },
    }),
  );
}

function capture(page: Page, name: string) {
  const path = resolve(process.env.CSWATCH_LIBRARY_CAPTURES ?? '../.design/library-proof');
  mkdirSync(path, { recursive: true });
  return page.screenshot({ path: resolve(path, name + '.png'), animations: 'disabled' });
}

for (const width of [1440, 768, 390]) {
  test.describe(`match list at ${width}px`, () => {
    test.use({ viewport: { width, height: width === 390 ? 844 : 900 }, hasTouch: width < 1024 });
    for (const lang of ['en', 'fr']) {
      for (const theme of ['light', 'dark']) {
        test(`source tabs render at ${width} in ${lang} and ${theme}`, async ({ page }) => {
          await page.addInitScript(
            ({ lang, theme }) => {
              localStorage.setItem('cswatch.language', lang);
              localStorage.setItem('theme', theme);
            },
            { lang, theme },
          );
          await installSources(page);
          await page.route('**/api/connections/faceit/matches?*', (route) =>
            route.fulfill({
              json: {
                next: '1794930000.25',
                items: [
                  faceitMatch,
                  {
                    ...faceitMatch,
                    match_id: 'room-fixture-2',
                    teams: [
                      { name: 'Tidewater', score: 9 },
                      { name: 'Amber City', score: 13 },
                    ],
                    result: 'loss',
                    map: null,
                    demos: [{ id: 'member-design-0', status: 'ready', map: 'de_ancient' }],
                  },
                  {
                    ...faceitMatch,
                    match_id: 'room-fixture-3',
                    teams: [
                      { name: 'North Hill', score: null },
                      { name: 'New Harbor', score: null },
                    ],
                    result: null,
                    map: null,
                    demos: [{ id: 'member-design-1', status: 'processing' }],
                  },
                ],
              },
            }),
          );
          await page.route('**/api/connections/steam/matches?*', (route) =>
            route.fulfill({
              json: { next: '25', items: steamMatches },
            }),
          );
          const failures: string[] = [];
          page.on('pageerror', (error) => failures.push(error.message));
          await page.goto('/library?source=faceit&lang=' + lang);
          const faceitTab = page.getByRole('tab', { name: 'FACEIT' });
          const steamTab = page.getByRole('tab', { name: 'Steam' });
          await expect(faceitTab).toHaveAttribute('aria-selected', 'true');
          await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
          await expect(page.locator('html')).toHaveAttribute('lang', lang);
          await expect(page.getByText('North District', { exact: false })).toBeVisible();
          await expect(page.getByRole('tabpanel').locator('li')).toHaveCount(3);
          await capture(page, `faceit-${width}-${lang}-${theme}`);
          await faceitTab.focus();
          await page.keyboard.press('ArrowRight');
          await expect(steamTab).toBeFocused();
          await expect(steamTab).toHaveAttribute('aria-selected', 'true');
          await expect(page).toHaveURL(/source=steam/);
          await expect(page.getByText('13–11')).toBeVisible();
          await expect(page.getByRole('tabpanel').locator('li')).toHaveCount(4);
          await capture(page, `steam-${width}-${lang}-${theme}`);
          expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
          await page.goBack();
          await expect(faceitTab).toHaveAttribute('aria-selected', 'true');
          await page.reload();
          await expect(faceitTab).toHaveAttribute('aria-selected', 'true');
          if (width < 1024) {
            await steamTab.tap();
            await expect(steamTab).toHaveAttribute('aria-selected', 'true');
          }
          expect(failures).toEqual([]);
        });
      }
    }
  });
}

test('FACEIT pagination, viewer return, filter, fallback and recovery preserve the route', async ({
  page,
}) => {
  await installSources(page, false, true);
  await page.route('**/api/demos/member-design-1', (route) =>
    route.fulfill({ json: memberDemos[1] }),
  );
  const resolving = Promise.withResolvers<void>();
  let reply: Parameters<Route['fulfill']>[0] | undefined;
  await page.route('**/api/connections/faceit/matches?*', async (route) => {
    await resolving.promise;
    const query = new URL(route.request().url()).searchParams;
    if (reply) return route.fulfill(reply);
    const cursor = query.get('cursor');
    const last = cursor === '1794930000.2';
    return route.fulfill({
      json: {
        next: last ? null : cursor ? '1794930000.2' : '1794930000.1',
        items: last
          ? [
              {
                match_id: 'room-fixture-3',
                competition: 'Previous fixture league',
                demos: [{ id: 'member-design-1', status: 'processing' }],
              },
            ]
          : cursor
            ? [{ ...faceitMatch, match_id: 'room-fixture-2', competition: 'Middle fixture league' }]
            : [faceitMatch],
      },
    });
  });
  await page.goto('/library?source=steam');
  await expect(page.getByRole('tab', { name: 'My demos' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByText('This match source is unavailable for your account.')).toBeVisible();
  await expect(
    page.getByRole('status').getByRole('link', { name: 'Connected accounts' }),
  ).toBeVisible();
  await page.getByRole('tab', { name: 'FACEIT' }).click();
  await expect(page.locator('.provider-match-skeleton')).toBeVisible();
  await capture(page, 'faceit-loading');
  resolving.resolve();
  await expect(page.getByText('Fixture League', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(page.getByText('Middle fixture league')).toBeVisible();
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(page.getByText('Previous fixture league')).toBeVisible();
  await page.reload();
  await expect(page.getByText('Previous fixture league')).toBeVisible();
  await page.getByRole('link', { name: 'Open Processing…' }).click();
  await expect(page).toHaveURL('/watch/member-design-1');
  await page.getByRole('link', { name: 'Library', exact: true }).click();
  await expect(page.getByText('Previous fixture league')).toBeVisible();
  await page.getByRole('button', { name: 'Previous page' }).click();
  await expect(page.getByText('Middle fixture league')).toBeVisible();
  await page.getByRole('button', { name: 'Previous page' }).click();
  await expect(page.getByText('Fixture League', { exact: true })).toBeVisible();

  reply = {
    status: 502,
    json: { detail: 'FACEIT returned an invalid response. Try again later.' },
  };
  await page.getByLabel('Show matches').selectOption('missing');
  await expect(page.getByRole('tabpanel').getByRole('alert')).toHaveText(
    /FACEIT returned an invalid response/,
  );
  await capture(page, 'faceit-provider-error');
  reply = { json: { items: [], next: null, had_matches: true } };
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('All matches have been downloaded.')).toBeVisible();
  await capture(page, 'faceit-all-downloaded');
  await page.getByLabel('Show matches').selectOption('downloaded');
  await expect(page.getByText('No demos have been added from this source.')).toBeVisible();
  await page.getByLabel('Show matches').selectOption('all');
  await expect(page.getByText('FACEIT lists no CS2 matches for this account.')).toBeVisible();
  await capture(page, 'faceit-empty');
});

test('parallel FACEIT downloads keep row progress and return without changing the current route', async ({
  page,
}) => {
  let available = true;
  await installSources(page, true, true, () => available);
  const fixtures = [
    ...[1, 2, 3].map((number) => ({
      ...faceitMatch,
      match_id: 'match-' + number,
      competition: 'Fixture ' + number,
    })),
  ];
  const download = Promise.withResolvers<void>();
  let detailsCalls = 0;
  await page.route('**/api/connections/faceit/matches?*', (route) =>
    route.fulfill({
      json: { items: fixtures, next: null },
    }),
  );
  await page.route('**/api/connections/faceit/match-demos?*', (route) => {
    detailsCalls++;
    const id = new URL(route.request().url()).searchParams.get('match_id');
    return id === 'match-3'
      ? route.fulfill({ status: 404, json: { code: 'faceit_no_demo' } })
      : route.fulfill({
          json: {
            files: [
              { id: 'a'.repeat(64), file: 1, demo: null },
              { id: 'b'.repeat(64), file: 2, demo: null },
            ],
          },
        });
  });
  await page.route('**/api/connections/faceit/import', async (route) => {
    const post = route.request().postDataJSON();
    expect(post.resource_id).toBe('b'.repeat(64));
    await download.promise;
    return post.match_id === 'match-2'
      ? route.fulfill({
          status: 502,
          json: { detail: 'FACEIT download failed. Try again or upload manually.' },
        })
      : route.fulfill({ status: 202, json: { id: 'late-faceit-import' } });
  });
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto('/library?source=faceit');
  for (const number of [1, 2]) {
    const row = page.getByRole('listitem').filter({ hasText: 'Fixture ' + number });
    await row.getByRole('button', { name: 'Download', exact: true }).click();
    await row.getByRole('button', { name: 'Demo file 2' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Download', exact: true }).click();
    await expect(row.getByRole('status')).toHaveText('Downloading…');
  }
  const third = page.getByRole('listitem').filter({ hasText: 'Fixture 3' });
  await third.getByRole('button', { name: 'Download', exact: true }).click();
  await expect(third.getByRole('status')).toHaveText('No demo available');
  await capture(page, 'faceit-download-progress');
  await page.getByRole('tab', { name: 'My demos' }).click();
  const finished = page.waitForResponse(
    (response) => response.url().endsWith('/faceit/import') && response.status() === 202,
  );
  download.resolve();
  await finished;
  await expect(page).toHaveURL('/library');
  await page.getByRole('tab', { name: 'FACEIT' }).click();
  await expect(page.getByRole('link', { name: 'Open In queue' })).toHaveAttribute(
    'href',
    '/watch/late-faceit-import',
  );
  await expect(page.getByRole('alert')).toHaveText(
    'FACEIT download failed. Try again or upload manually.',
  );
  await expect(third.getByRole('status')).toHaveText('No demo available');
  expect(detailsCalls).toBe(3);
  await capture(page, 'faceit-row-error');

  available = false;
  await page.reload();
  await page.getByRole('link', { name: 'Upload demo', exact: true }).first().click();
  await expect(page.getByRole('dialog').getByText('FACEIT match match-1')).toBeVisible();
});

test('a FACEIT match URL can open an existing file during a history outage', async ({ page }) => {
  await installSources(page, false, true);
  await page.route('**/api/connections/faceit/matches?*', (route) =>
    route.fulfill({
      status: 503,
      json: { detail: 'FACEIT is temporarily unavailable. Try again later.' },
    }),
  );
  await page.route('**/api/connections/faceit/match-demos?*', (route) => {
    expect(new URL(route.request().url()).searchParams.get('match_id')).toBe('older-fixture');
    return route.fulfill({
      json: {
        files: [
          {
            id: 'c'.repeat(64),
            file: 1,
            demo: { id: 'member-design-0', status: 'ready', map: 'de_mirage' },
          },
        ],
      },
    });
  });
  await page.goto('/library?source=faceit');
  await page.getByText('Import by FACEIT match URL').click();
  await page
    .getByLabel('FACEIT match ID or match room URL')
    .fill('https://www.faceit.com/en/cs2/room/older-fixture');
  await page.getByRole('button', { name: 'Find demo files' }).click();
  await expect(page.getByRole('link', { name: 'Demo file 1 Ready' })).toHaveAttribute(
    'href',
    '/watch/member-design-0',
  );
  await expect(page.getByRole('link', { name: 'Open on FACEIT' })).toHaveAttribute(
    'href',
    'https://www.faceit.com/en/cs2/room/older-fixture',
  );
});

test('Steam pages and filters use local offsets and show recorded match evidence', async ({
  page,
}) => {
  await installSources(page, true, false);
  await page.route('**/api/connections/steam/matches?*', (route) => {
    const query = new URL(route.request().url()).searchParams;
    const downloaded = query.get('filter') === 'downloaded';
    const older = query.get('offset') === '25';
    return route.fulfill({
      json: {
        items: downloaded ? [steamMatches[1]] : older ? [steamMatches[2]] : [steamMatches[0]],
        next: downloaded || older ? null : '25',
      },
    });
  });
  await page.goto('/library?source=steam');
  await expect(page.getByText('Steam match ' + steamMatches[0].match_id)).toBeVisible();
  await expect(page.locator('.provider-match-meta').first()).toBeHidden();
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(page.getByText('Steam match ' + steamMatches[2].match_id)).toBeVisible();
  await expect(page).toHaveURL(/cursor=25&page=2/);
  await page.getByRole('button', { name: 'Previous page' }).click();
  await expect(page.getByText('Steam match ' + steamMatches[0].match_id)).toBeVisible();
  await page.getByLabel('Show matches').selectOption('downloaded');
  await expect(page.getByText('13–11')).toBeVisible();
  await expect(page.getByText('ancient', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open Ready' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Upload this demo' })).toHaveCount(0);
});

test('Steam states show sync progress, cooldown, replace-codes and empty results', async ({
  page,
}) => {
  await installSources(page, true, false);
  const sync = Promise.withResolvers<void>();
  const listing = Promise.withResolvers<void>();
  let listError = true;
  let retry_at = 0;
  let needs_codes = false;
  await page.route('**/api/connections/steam/matches?*', async (route) => {
    await listing.promise;
    return listError
      ? route.fulfill({
          status: 503,
          json: { detail: 'The request could not be completed. Try again later.' },
        })
      : route.fulfill({ json: { items: [], next: null, retry_at, needs_codes } });
  });
  await page.route('**/api/connections/steam/history/sync', async (route) => {
    await sync.promise;
    retry_at = Date.now() / 1000 + 120;
    return route.fulfill({
      status: 429,
      json: { detail: 'Steam is rate limiting requests. Try again later.' },
    });
  });
  await page.goto('/library?source=steam');
  await expect(page.locator('.provider-match-skeleton')).toBeVisible();
  await capture(page, 'steam-loading');
  listing.resolve();
  await expect(page.getByRole('alert')).toBeVisible();
  await capture(page, 'steam-list-error');
  listError = false;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('No synced Steam matches yet.')).toBeVisible();
  await capture(page, 'steam-empty');
  await page.getByRole('button', { name: 'Sync Steam matches' }).click();
  await expect(page.getByRole('button', { name: 'Syncing…' })).toBeDisabled();
  await capture(page, 'steam-sync-progress');
  sync.resolve();
  await expect(page.getByRole('alert')).toHaveText(
    'Steam is rate limiting requests. Try again later.',
  );
  await expect(
    page.getByText('Steam match discovery is cooling down. Try again later.'),
  ).toBeVisible();
  await capture(page, 'steam-cooldown');
  retry_at = 0;
  needs_codes = true;
  await page.reload();
  await expect(page.getByText('Replace your Steam sync codes to resume sync.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sync Steam matches' })).toBeDisabled();
  await capture(page, 'steam-needs-codes');
});
