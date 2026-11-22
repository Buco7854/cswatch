import { fulfillReplayFixture } from './fixtures/streamed-replay';
import { installDemoMapDescriptor } from './fixtures/map-assets';
import { test, expect, type Page } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';
import { selectOptionsCategory } from './fixtures/viewer-options';

const french = JSON.parse(
  readFileSync(new URL('../src/locales/fr.json', import.meta.url), 'utf8'),
) as Record<string, string>;
type Language = 'en' | 'fr';
const message = (language: Language, key: string) => (language === 'fr' ? french[key] || key : key);
const a = '76561198000000001',
  b = '76561198000000002',
  c = '76561198000000003';
// Explicit synthetic QA data with recorded-shaped snapshots. Never real match history.
const players = [
  a,
  b,
  c,
  ...Array.from({ length: 7 }, (_, i) => `765611980000000${i + 4 < 10 ? '0' : ''}${i + 4}`),
].map((id, i) => ({
  id,
  name: [
    'Alpha reviewer',
    'Bravo rival',
    'Charlie support',
    'Delta anchor',
    'Echo entry',
    'Foxtrot lurk',
    'Golf rotate',
    'Hotel hold',
    'India trade',
    'Juliet scout',
  ][i],
  team: i === 1 || i >= 6 ? 2 : 3,
}));
const replay = {
  sample: false,
  map: 'de_scoreboard_fixture',
  tickRate: 64,
  players,
  frames: [0, 320, 640, 960, 1280].map((tick) => ({
    tick,
    players: players.map((player, i) => ({
      id: player.id,
      x: i * 30,
      y: 0,
      z: 0,
      yaw: 0,
      pitch: 0,
      team: tick >= 640 ? (player.team === 3 ? 2 : 3) : player.team,
      health: 100,
      alive: true,
      weapon: 'ak47',
      stats:
        player.id === a
          ? {
              kills: tick >= 320 ? 9 : 8,
              deaths: tick >= 960 ? 4 : 3,
              assists: 2,
              headshotKills: tick >= 320 ? 5 : 4,
              damage: tick >= 320 ? 935 : 900,
            }
          : player.id === b
            ? {
                kills: tick >= 960 ? 5 : 4,
                deaths: tick >= 320 ? 9 : 8,
                assists: 1,
                headshotKills: 0,
                damage: tick >= 1280 ? 525 : 500,
              }
            : {
                kills: 0,
                deaths: 0,
                assists: player.id === c && tick >= 320 ? 1 : 0,
                headshotKills: 0,
                damage: 0,
              },
      ...(player.id === a ? { money: tick >= 640 ? 4000 : 0 } : {}),
    })),
  })),
  rounds: [
    { number: 13, tick: 0, liveTick: 128, endTick: 639 },
    { number: 14, tick: 640, liveTick: 768, endTick: 1270 },
  ],
  events: [
    {
      type: 'player_hurt',
      tick: 192,
      attacker_steamid: a,
      user_steamid: b,
      dmg_health: 35,
      attacker_team_num: 3,
      user_team_num: 2,
    },
    {
      type: 'player_death',
      tick: 256,
      attacker_steamid: a,
      user_steamid: b,
      assister_steamid: c,
      headshot: true,
      attacker_team_num: 3,
      user_team_num: 2,
      weapon: 'ak47',
    },
    {
      type: 'player_death',
      tick: 896,
      attacker_steamid: b,
      user_steamid: a,
      assister_steamid: null,
      headshot: false,
      attacker_team_num: 3,
      user_team_num: 2,
      weapon: 'ak47',
    },
    {
      type: 'player_hurt',
      tick: 1024,
      attacker_steamid: b,
      user_steamid: a,
      dmg_health: 25,
      attacker_team_num: 3,
      user_team_num: 2,
    },
  ],
  eventAvailability: { player_death: true, player_hurt: true },
  matchState: {
    complete: true,
    samples: [
      {
        tick: 0,
        ctScore: 7,
        tScore: 5,
        roundNumber: 13,
        phase: 'freeze',
        clock: { kind: 'freeze', endTick: 128 },
      },
      {
        tick: 128,
        ctScore: 7,
        tScore: 5,
        roundNumber: 13,
        phase: 'live',
        clock: { kind: 'round', endTick: 640 },
      },
      {
        tick: 640,
        ctScore: 5,
        tScore: 8,
        roundNumber: 14,
        phase: 'freeze',
        clock: { kind: 'freeze', endTick: 768 },
      },
      {
        tick: 768,
        ctScore: 5,
        tScore: 8,
        roundNumber: 14,
        phase: 'live',
        clock: { kind: 'round', endTick: 1280 },
      },
      { tick: 1100, ctScore: 5, tScore: 9, roundNumber: 14, phase: 'round-end' },
    ],
  },
};
async function fixture(
  page: Page,
  language: Language = 'en',
  theme: 'dark' | 'light' = 'dark',
  policy: {
    legacy?: boolean;
    eventOnly?: boolean;
    incomplete?: boolean;
    wideScores?: boolean;
    scorePairs?: { ct: number; t: number; round: number }[];
  } = {},
) {
  await page.addInitScript(
    ({ language, theme }) => {
      localStorage.setItem('cswatch.language', language);
      localStorage.setItem('theme', theme);
      ['viewer-settings', 'viewer-settings-mobile'].forEach((key) =>
        localStorage.setItem(
          key,
          JSON.stringify({
            quality: 'low',
            autoHideControls: false,
            radar: false,
            killfeed: false,
            matchScore: true,
          }),
        ),
      );
    },
    { language, theme },
  );
  await page.route('**/api/demos/scoreboard-fixture', (route) =>
    route.fulfill({
      json: {
        id: 'scoreboard-fixture',
        name: 'Explicit scoreboard test fixture',
        source: 'synthetic-qa',
        status: 'ready',
        size: 1024,
        created_at: 1700000000,
        public: true,
        owned: false,
        map: replay.map,
        duration: 20,
        rounds: 2,
        error: null,
      },
    }),
  );
  await page.route('**/api/demos/scoreboard-fixture/playback', (route) =>
    fulfillReplayFixture(route, {
      ...replay,
      ...(policy.legacy || policy.eventOnly
        ? {
            frames: replay.frames.map((frame) => ({
              ...frame,
              players: frame.players.map((player) => ({ ...player, stats: undefined })),
            })),
          }
        : {}),
      ...(policy.legacy
        ? { matchState: undefined, eventAvailability: undefined }
        : policy.incomplete || policy.wideScores || policy.scorePairs
          ? {
              matchState: {
                ...replay.matchState,
                complete: !policy.incomplete,
                samples: (policy.incomplete
                  ? replay.matchState.samples.slice(0, 2)
                  : replay.matchState.samples
                ).map((sample, index) => {
                  const pair = policy.scorePairs?.[index];
                  return pair
                    ? { ...sample, ctScore: pair.ct, tScore: pair.t, roundNumber: pair.round }
                    : policy.wideScores
                      ? { ...sample, ctScore: 13, tScore: 15, roundNumber: 29 }
                      : sample;
                }),
              },
            }
          : {}),
    }),
  );
  await installDemoMapDescriptor(page, 'scoreboard-fixture');
  await page.goto('/watch/scoreboard-fixture');
  await expect(
    page.getByRole('heading', { name: 'scoreboard_fixture', exact: true }),
  ).toBeVisible();
  await page.getByRole('combobox', { name: message(language, 'Camera mode'), exact: true }).click();
  await page
    .getByRole('option', { name: message(language, '2D tactical · low power'), exact: true })
    .click();
}
const openScore = (page: Page, language: Language = 'en') =>
  page.getByRole('button', { name: message(language, 'Open scoreboard'), exact: true }).click();
const closeScore = (page: Page, language: Language = 'en') =>
  page.getByRole('button', { name: message(language, 'Close scoreboard'), exact: true }).click();
const row = (page: Page, id: string) =>
  page.locator(`.scoreboard-team tbody tr[data-player-id="${id}"]`);

async function expectCenteredMatchScore(page: Page) {
  const ribbon = page.locator('.viewer-match-score');
  await expect(ribbon).not.toHaveAttribute('aria-live', /.+/);
  await expect(ribbon.getByRole('timer')).toHaveAttribute('aria-live', 'off');
  for (const [team, key] of [
    ['3', 'teamct'],
    ['2', 'teamt'],
  ]) {
    const side = ribbon.locator(`.match-score-side[data-team="${team}"]`);
    await expect(side.locator(`.review-event-glyph[data-asset-key="${key}"]`)).toBeVisible();
    await expect(side.locator('.match-score-side-label')).toHaveClass(/visually-hidden/);
    await expect(side.locator('.match-score-side-label')).not.toHaveText(/^(CT|T)$/);
  }
  const offset = await ribbon.evaluate((element) => {
    const ribbonBox = element.getBoundingClientRect();
    const clock = element.querySelector('.match-score-clock > strong')!;
    const range = document.createRange();
    range.selectNodeContents(clock);
    const text = range.getBoundingClientRect();
    return Math.abs((text.left + text.right) / 2 - (ribbonBox.left + ribbonBox.right) / 2);
  });
  expect(offset, 'the actual clock text stays centered in the score strip').toBeLessThanOrEqual(
    0.6,
  );
}

test('ordinary score clocks stay centered independently of asymmetric digit widths with native side marks', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE), 'Explicit score geometry fixture.');
  await fixture(page, 'en', 'dark', {
    scorePairs: [
      { ct: 1, t: 15, round: 17 },
      { ct: 100, t: 1, round: 102 },
      { ct: 13, t: 15, round: 29 },
      { ct: 0, t: 0, round: 1 },
    ],
  });
  const description = page.locator('.match-score-description');
  const stableContext = await description.textContent();
  await expect(description).toContainText('Counter-terrorists: 1');
  await expect(description).toContainText('Terrorists: 15');
  expect(
    await description.evaluate((node) => !node.closest('.match-score-body,[role="timer"]')),
  ).toBe(true);
  await page.getByRole('slider', { name: 'Playback position', exact: true }).fill('64');
  await expect(page.locator('.match-score-clock > strong')).toHaveText('0:01');
  await expect(description).toHaveText(stableContext!);
  for (const size of [
    { width: 320, height: 740 },
    { width: 768, height: 1024 },
    { width: 1440, height: 900 },
    { width: 844, height: 390 },
  ]) {
    await page.setViewportSize(size);
    for (const tick of [0, 128, 640, 768]) {
      await page.getByRole('slider', { name: 'Playback position', exact: true }).fill(String(tick));
      await expectCenteredMatchScore(page);
      await expect(page.locator('.match-score-phase')).toBeVisible();
      await expect(page.locator('.match-score-round')).toBeVisible();
    }
  }
});

test('recorded side scores, clock and native match totals follow exact seeks and held Tab remains accessible', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE), 'Explicit synthetic UI fixture.');
  await page.setViewportSize({ width: 1440, height: 900 });
  await fixture(page);
  const ribbon = page.locator('.viewer-match-score');
  await expect(ribbon.locator('[data-score="ct"]')).toHaveText('7');
  await expect(ribbon.locator('[data-score="t"]')).toHaveText('5');
  await expect(ribbon).toHaveAttribute('data-phase', 'freeze');
  await expect(ribbon.locator('.match-score-clock > strong')).toHaveText('0:02');
  await openScore(page);
  const dialog = page.getByRole('dialog', { name: 'Scoreboard', exact: true });
  await expect(dialog).toBeVisible();
  await expect(row(page, a)).toHaveAttribute('data-stats-source', 'recorded-counters');
  await expect(row(page, a).locator('[data-stat="kills"]')).toHaveText('8');
  await expect(row(page, a).locator('[data-stat="damage"]')).toHaveText('900');
  await expect(row(page, c).locator('[data-stat="kills"]')).toHaveText('0');
  await expect(row(page, c).locator('[data-stat="damage"]')).toHaveText('0');
  await expect(row(page, a).locator('[data-stat="money"]')).toHaveText('$0');
  await expect(row(page, b).locator('[data-stat="money"]')).toHaveText('-');
  await closeScore(page);
  await expect(page.getByRole('button', { name: 'Open scoreboard', exact: true })).toBeFocused();
  const seek = page.getByRole('slider', { name: 'Playback position', exact: true });
  await seek.fill('320');
  await openScore(page);
  await expect(row(page, a).locator('[data-stat="kills"]')).toHaveText('9');
  await expect(row(page, a).locator('[data-stat="headshots"]')).toHaveText('56%');
  await expect(row(page, a).locator('[data-stat="damage"]')).toHaveText('935');
  await expect(row(page, b).locator('[data-stat="deaths"]')).toHaveText('9');
  await expect(row(page, c).locator('[data-stat="assists"]')).toHaveText('1');
  await row(page, b).getByRole('button').click();
  await expect(dialog).toHaveCount(0);
  await openScore(page);
  await expect(row(page, b).getByRole('button')).toHaveAttribute('aria-pressed', 'true');
  await closeScore(page);
  await seek.fill('960');
  await expect(ribbon.locator('[data-score="ct"]')).toHaveText('5');
  await expect(ribbon.locator('[data-score="t"]')).toHaveText('8');
  await openScore(page);
  await expect(row(page, a).locator('[data-stat="deaths"]')).toHaveText('4');
  await expect(row(page, a).locator('[data-stat="money"]')).toHaveText('$4,000');
  await expect(row(page, b).locator('[data-stat="headshots"]')).toHaveText('0%');
  await expect(
    page.locator('.scoreboard-team[data-team="2"]').locator(`tr[data-player-id="${a}"]`),
  ).toHaveCount(1);
  await closeScore(page);
  await seek.fill('0');
  await openScore(page);
  await expect(row(page, a).locator('[data-stat="kills"]')).toHaveText('8');
  await expect(row(page, a).locator('[data-stat="money"]')).toHaveText('$0');
  await closeScore(page);

  await page.locator('.viewer-stage').focus();
  await page.keyboard.down('Tab');
  await expect(dialog).toBeVisible();
  await page.keyboard.up('Tab');
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.viewer-stage')).toBeFocused();
  const options = page.getByRole('button', { name: 'Options', exact: true });
  await options.focus();
  await page.keyboard.down('Tab');
  await expect(dialog).toBeVisible();
  await page.keyboard.up('Tab');
  await expect(dialog).toHaveCount(0);
  await expect(options).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog).toHaveCount(0);
  await expect(options).not.toBeFocused();

  await page.locator('.viewer-stage').focus();
  await page.keyboard.press('h');
  await expect(ribbon).toHaveAttribute('aria-hidden', 'true');
  await page.keyboard.down('Tab');
  await expect(dialog).toBeVisible();
  await page.keyboard.up('Tab');
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.viewer-stage')).toBeFocused();
  await page.keyboard.down('Tab');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.viewer-stage')).toBeFocused();
  await page.keyboard.down('Tab'); // An OS repeat after Escape must not reopen it.
  await expect(dialog).toHaveCount(0);
  await page.keyboard.up('Tab');
});

test('legacy missing score metadata and unsupported event coverage stay unknown rather than plausible zeroes', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE), 'Explicit synthetic UI fixture.');
  await fixture(page, 'en', 'light', { legacy: true });
  await expect(page.locator('[data-score="ct"]')).toHaveText('-');
  await expect(page.locator('.match-score-clock > strong')).toHaveText('-');
  await page.getByRole('slider', { name: 'Playback position', exact: true }).fill('320');
  await openScore(page);
  for (const stat of ['kills', 'deaths', 'assists', 'headshots', 'damage'])
    await expect(row(page, a).locator(`[data-stat="${stat}"]`)).toHaveText('-');
  await expect(row(page, a).locator('[data-stat="money"]')).toHaveText('$0');
});

test('complete recorded-segment events do not fabricate match totals and incomplete score coverage expires', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE), 'Explicit partial-recording UI fixture.');
  await fixture(page, 'en', 'dark', { eventOnly: true, incomplete: true });
  await expect(page.locator('[data-score="ct"]')).toHaveText('7');
  await page.getByRole('slider', { name: 'Playback position', exact: true }).fill('320');
  await expect(page.locator('[data-score="ct"]')).toHaveText('-');
  await expect(page.locator('.match-score-clock > strong')).toHaveText('-');
  await openScore(page);
  await expect(row(page, a)).toHaveAttribute('data-stats-source', 'unavailable');
  for (const stat of ['kills', 'deaths', 'assists', 'headshots', 'damage'])
    await expect(row(page, a).locator(`[data-stat="${stat}"]`)).toHaveText('-');
  await expect(row(page, a).locator('[data-stat="money"]')).toHaveText('$0');
  await expect(
    page.getByText('Match totals use recorded player counters. A dash means unavailable data.', {
      exact: true,
    }),
  ).toBeVisible();
});

for (const language of ['en', 'fr'] as const)
  for (const theme of ['dark', 'light'] as const)
    test(`${language}/${theme}: score and complete scoreboard remain readable on phone, tablet and short landscape`, async ({
      page,
    }) => {
      test.skip(Boolean(process.env.E2E_PRIVATE), 'Explicit synthetic UI fixture.');
      await fixture(page, language, theme, { wideScores: true });
      for (const size of [
        { width: 320, height: 740 },
        { width: 390, height: 844 },
        { width: 768, height: 1024 },
        { width: 844, height: 390 },
      ]) {
        await page.setViewportSize(size);
        const ribbon = page.locator('.viewer-match-score');
        const bounds = await ribbon.boundingBox();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(size.width);
        expect(
          await ribbon.locator('.match-score-side').evaluateAll((sides) =>
            sides.every((side) => {
              const box = side.getBoundingClientRect();
              return [...side.querySelectorAll('strong,.review-event-glyph')].every((label) => {
                const range = document.createRange();
                range.selectNodeContents(label);
                const text = label.classList.contains('review-event-glyph')
                  ? label.getBoundingClientRect()
                  : range.getBoundingClientRect();
                return text.left >= box.left - 1 && text.right <= box.right + 1;
              });
            }),
          ),
        ).toBe(true);
        await expectCenteredMatchScore(page);
        await openScore(page, language);
        const dialog = page.getByRole('dialog', {
          name: message(language, 'Scoreboard'),
          exact: true,
        });
        await expect(dialog).toBeVisible();
        expect(
          await dialog.evaluate((node) => {
            const box = node.getBoundingClientRect();
            return (
              box.left >= 0 &&
              box.top >= 0 &&
              box.right <= innerWidth + 1 &&
              box.bottom <= innerHeight + 1 &&
              node.scrollWidth <= node.clientWidth + 1
            );
          }),
        ).toBe(true);
        await expect(dialog.locator('tbody tr')).toHaveCount(10);
        const viewport = dialog.locator('.scoreboard-table-viewport').first();
        await viewport.evaluate((node) => {
          node.scrollLeft = 200;
        });
        const sticky = await viewport.locator('tbody th').first().boundingBox();
        const viewportBounds = await viewport.boundingBox();
        expect(sticky!.x).toBeGreaterThanOrEqual(viewportBounds!.x - 1);
        expect(sticky!.x).toBeLessThanOrEqual(viewportBounds!.x + 1);
        const stickyHeader = await viewport.locator('thead th').first().boundingBox();
        expect(stickyHeader!.x).toBeGreaterThanOrEqual(viewportBounds!.x - 1);
        expect(stickyHeader!.x).toBeLessThanOrEqual(viewportBounds!.x + 1);
        if (size.width <= 607)
          await expect(dialog.locator('.scoreboard-scroll-note')).toBeVisible();
        expect(
          (await viewport.locator('tbody button').first().boundingBox())!.height,
        ).toBeGreaterThanOrEqual(44);
        if (process.env.CSWATCH_VISUAL_CAPTURE) {
          mkdirSync('../.design/match-scoreboard', { recursive: true });
          await page.screenshot({
            path: `../.design/match-scoreboard/${language}-${theme}-${size.width}-board.png`,
          });
        }
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
        if (process.env.CSWATCH_VISUAL_CAPTURE)
          await page.screenshot({
            path: `../.design/match-scoreboard/${language}-${theme}-${size.width}-score.png`,
          });
      }
      await page.getByRole('button', { name: 'Options', exact: true }).click();
      await selectOptionsCategory(page, 'Visuals');
      await page
        .getByRole('switch', { name: new RegExp('^' + message(language, 'Match score and clock')) })
        .uncheck();
      await page
        .getByRole('button', { name: message(language, 'Close viewer options'), exact: true })
        .click();
      await expect(page.locator('.viewer-match-score')).toBeHidden();
    });
