import { accountStatus } from './fixtures/account-status';
import { expect, test, type Page, type Route } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { encodeMatch } from 'csgo-sharecode';
import { resolve } from 'node:path';
import { installMemberWorkspace, memberDemos, memberUser } from './fixtures/member-workspace';
import { chooseSelectOption } from './fixtures/select-control';

test.use({ reducedMotion: 'reduce' });

test.beforeEach(() => {
  test.skip(Boolean(process.env.E2E_PRIVATE) || Boolean(process.env.E2E_SETUP));
});

const faceitMatch = {
  match_id: 'room-fixture-1',
  competition: 'Fixture League',
  faceit_level: 8,
  played_at: 1794930000,
  teams: [
    { name: 'North District', score: 13 },
    { name: 'Southside', score: 8 },
  ],
  result: 'win',
  map: 'de_mirage',
  demos: [],
};
function syntheticShareCode(id: string) {
  return encodeMatch({ matchId: BigInt(id), reservationId: 3100000000000000000n, tvPort: 27020 });
}
const code = syntheticShareCode('3100000000000000001');
const steamMatches = [
  { match_id: '3100000000000000001', share_code: code, demos: [] },
  {
    match_id: '2811123475613000001',
    share_code: syntheticShareCode('2811123475613000001'),
    demos: [
      {
        id: 'member-design-0',
        status: 'ready',
        map: 'de_ancient',
        score: [13, 11],
        performance: {
          kills: 19,
          deaths: 17,
          assists: 4,
          headshotKills: 9,
          rank: { mode: 'Premier', value: 15280, change: 280 },
        },
      },
    ],
  },
  {
    match_id: '2811123475613000002',
    share_code: syntheticShareCode('2811123475613000002'),
    demos: [{ id: 'member-design-1', status: 'processing' }],
  },
  {
    match_id: '2811123475613000003',
    share_code: syntheticShareCode('2811123475613000003'),
    demos: [{ id: 'member-design-3', status: 'failed' }],
  },
];

async function installSources(page: Page, steam = true, faceit = true, canDownload = () => faceit) {
  await installMemberWorkspace(page);
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      json: accountStatus({
        ...memberUser,
        role: 'member',
        match_sources: {
          steam,
          faceit,
          faceit_download: canDownload(),
          faceit_verification: faceit ? 'ready' : 'unavailable',
        },
        identities: [...memberUser.identities, { provider: 'faceit', subject: 'fixture' }],
      }),
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
              json: {
                next: '25',
                items: steamMatches,
                server_import_available: true,
                auto_import: false,
              },
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
          if (process.env.CSWATCH_VERIFY_MIRAGE_BADGE)
            await expect(
              page.locator('.match-thumbnail img[data-badge="true"]').first(),
            ).toHaveJSProperty('complete', true);
          await capture(page, `faceit-${width}-${lang}-${theme}`);
          const dialog = page.getByRole('dialog');
          await page
            .locator('.provider-match-row')
            .first()
            .getByRole('link', {
              name: lang === 'en' ? 'Upload demo' : 'Importer la démo',
            })
            .click();
          await expect(dialog.getByRole('link')).toHaveCount(1);
          await expect(dialog.getByRole('link')).toHaveAttribute(
            'href',
            'https://www.faceit.com/' + lang + '/cs2/room/room-fixture-1',
          );
          await capture(page, `faceit-upload-${width}-${lang}-${theme}`);
          await page.goBack();
          await expect(dialog).toHaveCount(0);
          await faceitTab.focus();
          await page.keyboard.press('ArrowRight');
          await expect(steamTab).toBeFocused();
          await expect(steamTab).toHaveAttribute('aria-selected', 'true');
          await expect(page).toHaveURL(/source=steam/);
          await expect(page.getByText('13–11')).toBeVisible();
          await expect(page.getByText(/19\/17\/4/)).toBeVisible();
          await expect(page.getByText('+280', { exact: true })).toBeVisible();
          await expect(page.getByRole('tabpanel').locator('li')).toHaveCount(4);
          await expect(page.getByRole('switch')).not.toBeChecked();
          await capture(page, `steam-${width}-${lang}-${theme}`);
          await page
            .locator('.provider-match-row')
            .first()
            .getByRole('link', {
              name: lang === 'en' ? 'Upload this demo' : 'Ajouter cette démo',
            })
            .click();
          await expect(dialog.getByRole('link')).toHaveCount(1);
          await expect(dialog.getByRole('link')).toHaveAttribute(
            'href',
            'steam://rungame/730/76561202255233023/+csgo_download_match%20' + code,
          );
          expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
          await capture(page, `steam-upload-${width}-${lang}-${theme}`);
          await page.goBack();
          await expect(dialog).toHaveCount(0);
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
  await chooseSelectOption(page, 'Show matches', 'Not downloaded');
  await expect(page.getByRole('tabpanel').getByRole('alert')).toHaveText(
    /FACEIT returned an invalid response/,
  );
  await capture(page, 'faceit-provider-error');
  reply = { json: { items: [], next: null, had_matches: true } };
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('All matches have been downloaded.')).toBeVisible();
  await capture(page, 'faceit-all-downloaded');
  await chooseSelectOption(page, 'Show matches', 'Downloaded');
  await expect(page.getByText('No demos have been added from this source.')).toBeVisible();
  await chooseSelectOption(page, 'Show matches', 'All');
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
  // With automatic downloads available, a failed or missing download still offers the
  // member's own file for that match, while a downloaded match does not.
  const failed = page.getByRole('listitem').filter({ hasText: 'Fixture 2' });
  for (const row of [failed, third])
    await expect(row.getByRole('link', { name: 'Upload demo', exact: true })).toBeVisible();
  await expect(
    page
      .getByRole('listitem')
      .filter({ hasText: 'Fixture 1' })
      .getByRole('link', { name: 'Upload demo', exact: true }),
  ).toHaveCount(0);
  await third.getByRole('link', { name: 'Upload demo', exact: true }).click();
  await expect(page.getByRole('dialog').getByText('FACEIT match match-3')).toBeVisible();
  await page.keyboard.press('Escape');

  available = false;
  await page.reload();
  await page.getByRole('link', { name: 'Upload demo', exact: true }).first().click();
  await expect(page.getByRole('dialog').getByText('FACEIT match match-1')).toBeVisible();
});

test('the FACEIT match upload accepts its downloaded .dem.gz directly', async ({ page }) => {
  await installSources(page, false, true);
  await page.route('**/api/connections/faceit/matches?*', (route) =>
    route.fulfill({ json: { items: [faceitMatch], next: null } }),
  );
  await page.goto('/library?source=faceit');
  await page.getByRole('link', { name: 'Upload demo', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const input = dialog.locator('input[type=file]');
  await expect(input).toHaveAttribute('accept', '.dem,.zst,.gz');
  await expect(dialog.getByText(/Drop a .*\.dem\.gz file/)).toBeVisible();
  const bytes = gzipSync(Buffer.from('PBDEMS2\0synthetic-faceit-match'));
  await input.setInputFiles({ name: 'other.gz', mimeType: 'application/gzip', buffer: bytes });
  await expect(dialog.getByRole('alert')).toHaveText('Choose a .dem, .dem.zst or .dem.gz file.');
  await page.route('**/api/demos?faceit_match=*', (route) => {
    expect(route.request().method()).toBe('POST');
    expect(new URL(route.request().url()).searchParams.get('faceit_match')).toBe(
      faceitMatch.match_id,
    );
    expect(route.request().postDataBuffer()!.includes(bytes)).toBe(true);
    return route.fulfill({ status: 202, json: { id: 'member-design-1' } });
  });
  await input.setInputFiles({ name: 'match.dem.gz', mimeType: 'application/gzip', buffer: bytes });
  await expect(page).toHaveURL(/\/watch\/member-design-1$/);
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
  await expect(page.locator('.provider-match-meta').first()).toHaveText('Unknown map');
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(page.getByText('Steam match ' + steamMatches[2].match_id)).toBeVisible();
  await expect(page).toHaveURL(/cursor=25&page=2/);
  await page.getByRole('button', { name: 'Previous page' }).click();
  await expect(page.getByText('Steam match ' + steamMatches[0].match_id)).toBeVisible();
  await chooseSelectOption(page, 'Show matches', 'Downloaded');
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

test('Steam server import uses only the selected synced match and keeps local alternatives on failure', async ({
  page,
}) => {
  await installSources(page, true, false);
  const first = steamMatches[0];
  let failed = true;
  let imported = false;
  await page.route('**/api/connections/steam/matches?*', (route) =>
    route.fulfill({
      json: {
        next: null,
        server_import_available: true,
        auto_import: false,
        items: [
          { ...first, demos: imported ? [{ id: 'steam-server-replay', status: 'queued' }] : [] },
          {
            match_id: '200',
            share_code: null,
            demos: [{ id: 'historical-demo', status: 'failed' }],
          },
        ],
      },
    }),
  );
  const pending = Promise.withResolvers<void>();
  let calls = 0;
  await page.route('**/api/connections/steam/import', async (route) => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().headers()['x-csrf-token']).toBe(memberUser.csrf);
    expect(route.request().postDataJSON()).toEqual({ match_id: first.match_id });
    calls++;
    await pending.promise;
    if (failed)
      return route.fulfill({
        status: 404,
        json: {
          detail: 'The demo download is unavailable or has expired. Try again or upload manually.',
          code: 'steam_no_demo',
        },
      });
    imported = true;
    return route.fulfill({ status: 202, json: { id: 'steam-server-replay' } });
  });
  await page.goto('/library?source=steam');
  const rows = page.locator('.provider-match-row');
  const start = rows.first().getByRole('button', { name: 'Import', exact: true });
  await expect(rows.last().getByRole('button', { name: 'Import', exact: true })).toHaveCount(0);
  await start.focus();
  await page.keyboard.press('Enter');
  await expect(start).toBeDisabled();
  await expect(rows.first().getByRole('status')).toHaveText('Downloading…');
  await expect(rows.first().getByRole('button', { name: 'Import from folder' })).toBeDisabled();
  pending.resolve();
  await expect(rows.first().getByRole('alert')).toContainText('has expired');
  await expect(rows.first().getByRole('link', { name: 'Upload this demo' })).toBeVisible();
  await expect(rows.first().getByRole('button', { name: 'Import from folder' })).toBeEnabled();
  failed = false;
  await start.click();
  await expect(rows.first().getByRole('link', { name: 'Open In queue' })).toHaveAttribute(
    'href',
    '/watch/steam-server-replay',
  );
  expect(calls).toBe(2);
});

test('a Steam Guard failure identifies the server account in French and keeps the paired upload', async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('cswatch.language', 'fr'));
  await installSources(page, true, false);
  await page.route('**/api/connections/steam/matches?*', (route) =>
    route.fulfill({
      json: { next: null, server_import_available: true, items: [steamMatches[0]] },
    }),
  );
  await page.route('**/api/connections/steam/import', (route) =>
    route.fulfill({
      status: 503,
      json: {
        code: 'steam_coordinator_setup',
        detail:
          'Steam Guard blocked the server account from signing in. Contact the administrator or upload the demo file.',
      },
    }),
  );
  await page.goto('/library?source=steam');
  const row = page.locator('.provider-match-row');
  await row.getByRole('button', { name: 'Importer', exact: true }).click();
  await expect(row.getByRole('alert')).toContainText(
    'Steam Guard bloque la connexion du compte Steam du serveur.',
  );
  await expect(row.getByRole('link', { name: 'Ajouter cette démo' })).toBeVisible();
});

test('a shared Steam upload route exposes a client download only for its exact match', async ({
  page,
}) => {
  await installSources(page, true, false);
  const id = '3100000000000000002';
  await page.route('**/api/connections/steam/matches?*', (route) =>
    route.fulfill({ json: { items: [{ match_id: id, share_code: code, demos: [] }], next: null } }),
  );
  await page.goto('/library?source=steam&upload=1&steamMatch=' + id);
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Steam match ' + id)).toBeVisible();
  await expect(dialog.getByText(/game\/csgo\/replays/)).toBeVisible();
  await expect(dialog.getByRole('link')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Choose demo file' })).toBeEnabled();
});

test('Steam automatic imports require member opt-in and can be turned off while server import is paused', async ({
  page,
}) => {
  await installSources(page, true, false);
  let available = true;
  let optedIn = false;
  let failNext = true;
  await page.route('**/api/connections/steam/matches?*', (route) =>
    route.fulfill({
      json: { items: [], next: null, server_import_available: available, auto_import: optedIn },
    }),
  );
  const changes: boolean[] = [];
  await page.route('**/api/connections/steam/history/auto-import', (route) => {
    expect(route.request().method()).toBe('PUT');
    expect(route.request().headers()['x-csrf-token']).toBe(memberUser.csrf);
    const enabled = route.request().postDataJSON().enabled;
    expect(route.request().postDataJSON()).toEqual({ enabled });
    changes.push(enabled);
    if (failNext) {
      failNext = false;
      return route.fulfill({
        status: 429,
        json: { detail: 'Steam is rate limiting requests. Try again later.' },
      });
    }
    optedIn = enabled;
    return route.fulfill({ json: { auto_import: enabled } });
  });
  await page.goto('/library?source=steam');
  const toggle = page.getByRole('switch', { name: /Automatically import Steam demos/ });
  await expect(toggle).not.toBeChecked();
  expect(changes).toEqual([]);
  await toggle.focus();
  await page.keyboard.press('Space');
  await expect(page.getByRole('alert')).toHaveText(
    'Steam is rate limiting requests. Try again later.',
  );
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect(page.getByRole('alert')).toHaveCount(0);
  available = false;
  await page.reload();
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).toHaveCount(0);
  expect(changes).toEqual([true, true, false]);
});

// Use a real browser file system with a disposable directory. Only the native
// picker and the external Steam protocol handoff need substituting.
// CS Demo Manager's Valve match fixture, revision 5a1a0059. The filename
// contains a reservation and full TV port, while the sidecar holds the match ID.
const replayId = '3668529891923460401';
const replayCode = 'CSGO-98ykZ-EJ952-QzetT-kWNp6-Oe2ED';
const replayName = 'match730_003668537425296097309_2104686856_273.dem';
async function installReplayPicker(page: Page) {
  await installSources(page, true, false);
  await page.route('**/api/connections/steam/matches?*', (route) =>
    route.fulfill({
      json: { next: null, items: [{ match_id: replayId, share_code: replayCode, demos: [] }] },
    }),
  );
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showDirectoryPicker', {
      configurable: true,
      value: async ({ mode }: { mode: string }) => {
        if (mode !== 'read') throw new Error('Expected read-only access');
        return (await navigator.storage.getDirectory()).getDirectoryHandle('replays', {
          create: true,
        });
      },
    });
    document.addEventListener('click', (event) => {
      if ((event.target as HTMLElement)?.closest('a[href^="steam:"]')) {
        event.preventDefault();
        document.documentElement.dataset.steamLaunched = String(event.isTrusted);
      }
    });
  });
  await page.goto('/library?source=steam');
}

async function writeReplay(page: Page, name = replayName, matchId = replayId, complete = true) {
  await page.evaluate(
    async ({ name, matchId, complete }) => {
      const dir = await (
        await navigator.storage.getDirectory()
      ).getDirectoryHandle('replays', { create: true });
      async function write(name: string, data: number[]) {
        const file = await (await dir.getFileHandle(name, { create: true })).createWritable();
        await file.write(Uint8Array.from(data));
        await file.close();
      }
      // Valve's CDataGCCStrike15_v2_MatchInfo.matchid is uint64 field 1.
      const sidecar = [8];
      let value = BigInt(matchId);
      while (value > 127n) {
        sidecar.push(Number(value & 127n) | 128);
        value >>= 7n;
      }
      sidecar.push(Number(value));
      await write(name + '.info', sidecar);
      const header = [80, 66, 68, 69, 77, 83, 50, 0, 16, 0, 0, 0, 0, 0, 0, 0];
      // DEM_FileInfo, tick 1, length 3; withhold the payload to simulate a paused write.
      await write(name, [...header, 2, 1, 3, ...(complete ? [13, 8, 1] : [])]);
    },
    { name, matchId, complete },
  );
}

test('Steam imports the selected existing replay and leaves other local files alone', async ({
  page,
}) => {
  await installReplayPicker(page);
  await writeReplay(page, 'something-else.dem');
  await writeReplay(page);
  const received: string[] = [];
  await page.route('**/api/demos?steam_match=*', (route) => {
    expect(new URL(route.request().url()).searchParams.get('steam_match')).toBe(replayId);
    expect(route.request().headers()['x-csrf-token']).toBe(memberUser.csrf);
    received.push(route.request().postDataBuffer()!.toString('latin1'));
    return route.fulfill({ json: { id: 'local-demo' } });
  });
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByRole('link', { name: /Open.*queue/i })).toHaveAttribute(
    'href',
    '/watch/local-demo',
  );
  expect(received).toHaveLength(1);
  expect(received[0]).toContain('filename="' + replayName + '"');
  expect(received[0]).not.toContain('something-else');
  await expect(page.locator('html')).not.toHaveAttribute('data-steam-launched', 'true');
});

test('Steam waits for the selected download and rejects a paused partial replay', async ({
  page,
}) => {
  await page.clock.install();
  await installReplayPicker(page);
  let uploads = 0;
  await page.route('**/api/demos?steam_match=*', (route) => {
    uploads++;
    return route.fulfill({ json: { id: 'completed-demo' } });
  });
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByRole('listitem').getByRole('status')).toContainText(
    'Replay not found here',
  );
  await capture(page, 'steam-folder-missing');
  await page.getByRole('link', { name: 'Download in CS2' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-steam-launched', 'true');
  await expect(page.getByRole('listitem').getByRole('status')).toContainText('Waiting for CS2');
  await capture(page, 'steam-folder-waiting');
  await writeReplay(page, replayName, replayId, false);
  await page.clock.runFor(4600);
  expect(uploads).toBe(0);
  await writeReplay(page);
  await page.clock.runFor(4600);
  await expect(page.getByRole('link', { name: /Open.*queue/i })).toBeVisible();
  expect(uploads).toBe(1);
});

test('Steam keeps ambiguous files and mismatched replay information out of the upload', async ({
  page,
}) => {
  await page.clock.install();
  await installReplayPicker(page);
  let uploads = 0;
  await page.route('**/api/demos?steam_match=*', (route) => {
    uploads++;
    return route.fulfill({ json: { id: 'unexpected' } });
  });
  await writeReplay(page, replayName, '1');
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('does not confirm this match');
  await writeReplay(page, replayName.replace('_273.', '_271.'));
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Several files match');
  expect(uploads).toBe(0);
  await page.getByRole('link', { name: 'Upload this demo' }).click();
  await expect(page.getByRole('dialog').locator('input[type=file]')).toHaveAttribute(
    'accept',
    /\.bz2/,
  );
});

test('Steam releases pending imports on cancellation and a change of member', async ({ page }) => {
  await page.clock.install();
  await installReplayPicker(page);
  let uploads = 0;
  await page.route('**/api/demos?steam_match=*', (route) => {
    uploads++;
    return route.fulfill({ json: { id: 'unexpected' } });
  });
  const start = page.getByRole('button', { name: 'Import', exact: true });
  await start.click();
  await page.getByRole('link', { name: 'Download in CS2' }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(start).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Forget folder' })).toBeVisible();
  await start.click();
  await expect(page.getByRole('listitem').getByRole('status')).toContainText(
    'Replay not found here',
  );
  await page.getByRole('link', { name: 'Download in CS2' }).click();
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      json: accountStatus({
        ...memberUser,
        id: 'another-member',
        csrf: 'another-csrf',
        match_sources: { ...memberUser.match_sources, steam: true },
      }),
    }),
  );
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('button', { name: 'Forget folder' })).toHaveCount(0);
  await expect(start).toBeEnabled();
  await writeReplay(page);
  await page.clock.runFor(4600);
  expect(uploads).toBe(0);
});

test('Steam stops monitoring after its deadline and leaves the file picker available', async ({
  page,
}) => {
  await page.clock.install();
  await installReplayPicker(page);
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByRole('listitem').getByRole('status')).toContainText(
    'Replay not found here',
  );
  await page.getByRole('link', { name: 'Download in CS2' }).click();
  await page.clock.fastForward(120_001);
  await expect(page.getByRole('alert')).toContainText('did not finish in time');
  await page.getByRole('button', { name: 'Forget folder' }).click();
  await expect(page.getByRole('button', { name: 'Forget folder' })).toHaveCount(0);
  await page.evaluate(() =>
    Object.defineProperty(window, 'showDirectoryPicker', {
      value: () => Promise.reject(new DOMException('dismissed', 'AbortError')),
    }),
  );
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Import', exact: true })).toBeEnabled();
});

test('Steam retains the manual upload when browser folder access is unavailable', async ({
  page,
}) => {
  await installReplayPicker(page);
  await page.evaluate(() =>
    Object.defineProperty(window, 'showDirectoryPicker', { value: undefined }),
  );
  await page.getByRole('tab', { name: 'My demos' }).click();
  await page.getByRole('tab', { name: 'Steam' }).click();
  await expect(page.getByRole('button', { name: 'Import', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: 'Import', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Steam match ' + replayId)).toBeVisible();
  let uploaded = false;
  await page.route('**/api/demos?steam_match=*', (route) => {
    expect(route.request().postDataBuffer()!.toString('latin1')).toContain(
      'filename="recording.dem.bz2"',
    );
    expect(new URL(route.request().url()).searchParams.get('steam_match')).toBe(replayId);
    uploaded = true;
    return route.fulfill({ status: 503, json: { detail: 'Upload failed.' } });
  });
  await dialog.locator('input[type=file]').setInputFiles({
    name: 'recording.dem.bz2',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from('BZh9'),
  });
  await expect(dialog.getByRole('alert')).toHaveText('Upload failed.');
  expect(uploaded).toBe(true);
});
