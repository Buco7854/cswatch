import { fulfillReplayFixture } from './fixtures/streamed-replay';
import { installMapFixture } from './fixtures/map-assets';
import { test, expect, type Page } from '@playwright/test';
import { sample } from '../src/sample';
import { selectOptionsCategory } from './fixtures/viewer-options';
import type { Playback } from '../src/types';
import { originalMapReplay } from './fixtures/original-map';
import { installOriginalCameraProbe, originalCameraView } from './fixtures/original-camera';

const ids = sample.players.map((_, index) => String(76561198000000100n + BigInt(index)));
const replay = {
  ...sample,
  sample: false,
  map: 'de_controls_fixture',
  events: [],
  crosshairs: {
    complete: true,
    samples: [{ tick: 0, actor: ids[0], code: 'CSGO-ZEw8O-KGXNu-4TTUU-VyXbD-SBCtG' }],
  },
  players: sample.players.map((player, index) => ({ ...player, id: ids[index] })),
  frames: sample.frames.map((frame) => ({
    ...frame,
    players: frame.players.map((player, index) => ({
      ...player,
      id: ids[index],
    })),
  })),
};
async function fixture(
  page: Page,
  settings: Record<string, unknown> = {},
  data: Playback = replay,
) {
  await page.addInitScript(
    (settings) =>
      localStorage.setItem(
        'viewer-settings',
        JSON.stringify({ quality: 'low', autoHideControls: false, ...settings }),
      ),
    settings,
  );
  await page.route('**/api/demos/controls-fixture', (route) =>
    route.fulfill({
      json: {
        id: 'controls-fixture',
        name: 'Explicit controls fixture',
        status: 'ready',
        owned: false,
        public: true,
        source: 'synthetic-qa',
        created_at: 1700000000,
        map: data.map,
        duration: 60,
        rounds: 3,
        size: 1024,
      },
    }),
  );
  await page.route('**/api/demos/controls-fixture/playback', (route) =>
    fulfillReplayFixture(route, data),
  );
  await installMapFixture(page, data.map, 'controls-fixture');
  await page.goto('/watch/controls-fixture');
  await expect(page.locator('.timeline-slider')).toBeVisible();
}
async function players(page: Page) {
  const direct = page.getByRole('button', { name: 'Players', exact: true });
  if (await direct.isVisible()) await direct.click();
  else {
    await page.getByRole('button', { name: 'Replay tools', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Players', exact: true }).click();
  }
}

test('plain Tab opens the scoreboard from playback controls and player clicks select POV with feedback', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await fixture(page, { economy: true });
  const play = page.getByRole('button', { name: 'Play', exact: true });
  await play.focus();
  await page.keyboard.down('Tab');
  await expect(page.getByRole('dialog', { name: 'Scoreboard', exact: true })).toBeVisible();
  await page.keyboard.up('Tab');
  await expect(page.getByRole('dialog', { name: 'Scoreboard', exact: true })).toHaveCount(0);
  await expect(play).toBeFocused();
  await page.locator('.review-economy-frame .broadcast-player-select').nth(1).click();
  await expect(page.getByRole('combobox', { name: 'Camera mode' })).toHaveText(
    'Player perspective',
  );
  await expect(page.locator('.viewer-camera-tools')).toHaveAttribute('data-camera-changed', 'true');
  await expect(
    page.locator('.review-economy-frame .broadcast-player-select').nth(1),
  ).toHaveAttribute('aria-pressed', 'true');
  await players(page);
  await expect(page.locator('.viewer-drawer .broadcast-player-select')).toHaveCount(10);
  await page.locator('.viewer-drawer .broadcast-player-select').nth(2).click();
  await expect(page.locator('.viewer-drawer')).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Camera mode' })).toHaveText(
    'Player perspective',
  );
});

test('processing and failed demo pages keep ordinary Tab navigation before a viewer exists', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  let status = 'processing';
  await page.route('**/api/demos/unavailable-controls-fixture', (route) =>
    route.fulfill({
      json: {
        id: 'unavailable-controls-fixture',
        name: 'Explicit unavailable keyboard fixture',
        status,
        owned: false,
        public: true,
        source: 'synthetic-qa',
        error: status === 'failed' ? 'Explicit safe failure' : null,
      },
    }),
  );
  for (status of ['processing', 'failed']) {
    await page.goto('/watch/unavailable-controls-fixture');
    await expect(page.locator('.processing')).toBeVisible();
    const back = page.locator('.back-link');
    const returnLink = page.locator('.processing a.button');
    await back.focus();
    await page.keyboard.press('Tab');
    await expect(returnLink).toBeFocused();
    await expect(page.getByRole('dialog', { name: 'Scoreboard', exact: true })).toHaveCount(0);
  }
});

const combatReplay: Playback = {
  ...replay,
  eventAvailability: { player_death: true, player_hurt: true },
  events: [
    { type: 'round_start', tick: 0 },
    {
      type: 'player_hurt',
      tick: 300,
      attacker_steamid: ids[0],
      user_steamid: ids[1],
      dmg_health: 37,
      user_team_num: 3,
      attacker_team_num: 3,
    },
    {
      type: 'player_hurt',
      tick: 600,
      attacker_steamid: ids[1],
      user_steamid: ids[0],
      dmg_health: 70,
      user_team_num: 3,
      attacker_team_num: 3,
    },
    {
      type: 'player_hurt',
      tick: 610,
      attacker_steamid: ids[2],
      user_steamid: ids[0],
      dmg_health: 83,
      user_team_num: 3,
      attacker_team_num: 3,
    },
    {
      type: 'player_hurt',
      tick: 640,
      attacker_steamid: ids[1],
      user_steamid: ids[0],
      dmg_health: 34,
      user_team_num: 3,
      attacker_team_num: 3,
    },
    {
      type: 'player_death',
      tick: 640,
      attacker_steamid: ids[1],
      user_steamid: ids[0],
      attacker_name: 'echo',
      user_name: 'marlow',
      weapon: 'fiveseven',
      headshot: true,
      user_team_num: 3,
      attacker_team_num: 3,
    },
    {
      type: 'player_hurt',
      tick: 650,
      attacker_steamid: ids[0],
      user_steamid: ids[2],
      dmg_health: 999,
      user_team_num: 3,
      attacker_team_num: 3,
    },
  ],
};

test('mobile personal recap stays enabled while the round list stays off and replays either perspective', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page, { reviewFeed: true }, combatReplay);
  const seek = page.getByRole('slider', { name: 'Playback position', exact: true });
  await seek.fill('640');
  const recap = page.locator('.combat-recap');
  await expect(page.locator('.review-feed')).toHaveCount(0);
  await expect(recap.locator('.combat-recap-title')).toHaveText('Killed byecho');
  await expect(recap).toHaveAttribute('data-coverage', 'complete');
  await expect(recap.locator('.combat-recap-weapon')).toContainText('Five-SeveN');
  await expect(recap.locator('.combat-recap-weapon')).toContainText('Headshot');
  const taken = recap.getByRole('region', { name: 'Damage taken' });
  await expect(taken.locator('li').nth(0)).toHaveText('104echo');
  await expect(taken.locator('li').nth(1)).toHaveText('83sable');
  await expect(recap.getByRole('region', { name: 'Damage dealt' }).locator('li')).toHaveText(
    '37echo',
  );
  const replayDeath = page.getByRole('button', { name: 'Replay death', exact: true });
  const replayKill = page.getByRole('button', { name: 'Replay kill', exact: true });
  await expect(replayDeath).toHaveText('Replay');
  await expect(replayKill).toHaveText('See kill');
  await replayKill.click();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  expect(Number(await seek.inputValue())).toBeLessThan(640);
  await expect(page.getByRole('combobox', { name: 'Camera mode' })).toHaveText(
    'Player perspective',
  );
  await players(page);
  await expect(
    page.locator(`.viewer-drawer .broadcast-player[data-player-id="${ids[1]}"] button`),
  ).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Close panel', exact: true }).click();
  await seek.fill('640');
  await expect(recap.locator('.combat-recap-title')).toHaveText('You killedmarlow');
  await expect(page.getByRole('button', { name: 'Replay death', exact: true })).toHaveText(
    'See death',
  );
  await page.getByRole('button', { name: 'Replay death', exact: true }).click();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await players(page);
  await expect(
    page.locator(`.viewer-drawer .broadcast-player[data-player-id="${ids[0]}"] button`),
  ).toHaveAttribute('aria-pressed', 'true');
});

test.describe('compact recap with captions', () => {
  test.use({ hasTouch: true });
  test('both languages and themes preserve phone caption, recap and playback lanes', async ({
    page,
  }, info) => {
    test.skip(Boolean(process.env.E2E_PRIVATE));
    await page.route('**/api/demos/controls-fixture/captions', (route) =>
      route.fulfill({
        json: {
          status: 'ready',
          cues: [
            {
              id: 'explicit-combat-caption',
              startTick: 600,
              endTick: 704,
              speaker: ids[0],
              text: 'Explicit synthetic communication fixture.',
              source: 'imported',
            },
          ],
        },
      }),
    );
    for (const language of ['en', 'fr'])
      for (const theme of ['dark', 'light']) {
        await page.addInitScript(
          ({ language, theme }) => {
            localStorage.setItem('cswatch.language', language);
            localStorage.setItem('theme', theme);
            localStorage.setItem(
              'viewer-settings-mobile',
              JSON.stringify({ subtitles: true, autoHideControls: false, quality: 'low' }),
            );
          },
          { language, theme },
        );
        for (const size of [
          { width: 390, height: 844 },
          { width: 844, height: 390 },
        ]) {
          await page.setViewportSize(size);
          await fixture(page, {}, combatReplay);
          await page.locator('.timeline-slider').fill('640');
          const recap = page.locator('.viewer-context-actions.is-combat');
          const subtitle = page.locator('.voice-caption');
          await expect(recap).toBeVisible();
          await expect(subtitle).toContainText('Explicit synthetic communication fixture.');
          await expect(page.locator('.review-feed')).toHaveCount(0);
          await expect
            .poll(async () => {
              const card = (await recap.boundingBox())!,
                caption = (await subtitle.boundingBox())!,
                deck = (await page.locator('.viewer-dock').boundingBox())!;
              return (
                card.x >= 0 &&
                card.y >= 0 &&
                card.x + card.width <= size.width &&
                card.y + card.height <= caption.y &&
                caption.y + caption.height <= deck.y &&
                card.height <= 192
              );
            })
            .toBe(true);
          await expect(page.locator('.scene canvas')).toBeVisible();
          await page.screenshot({
            path: info.outputPath(`combat-${language}-${theme}-${size.width}.png`),
          });
        }
      }
  });
});

test('phone defaults ignore desktop HUD opt-ins and playback range stays directly available', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page, {
    inputs: true,
    mouseInput: true,
    economy: true,
    subtitles: true,
    reviewFeed: true,
  });
  await expect(page.locator('.review-inputs-panel')).toHaveCount(0);
  await expect(page.locator('.review-economy-frame')).toHaveCount(0);
  await expect(page.locator('.review-feed')).toHaveCount(0);
  const range = page.getByRole('combobox', { name: 'Timeline range', exact: true });
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(range).toBeVisible();
    await expect
      .poll(() =>
        range.evaluate((button) => {
          const box = button.getBoundingClientRect();
          return button.contains(
            document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2),
          );
        }),
      )
      .toBe(true);
    const scope = (await range.boundingBox())!;
    const speed = (await page.getByRole('combobox', { name: 'Playback speed' }).boundingBox())!;
    const play = (await page.getByRole('button', { name: 'Play', exact: true }).boundingBox())!;
    expect(scope.x + scope.width).toBeLessThanOrEqual(speed.x);
    expect(speed.x + speed.width).toBeLessThanOrEqual(play.x);
    expect(play.x + play.width / 2).toBeCloseTo(width / 2, 0);
  }
  await range.click();
  await page.getByRole('option', { name: 'Current round', exact: true }).click();
  await expect(range).toHaveAttribute('data-state', 'closed');
  await expect(range).toHaveText('Current round');
  await page.getByRole('button', { name: 'Replay tools', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Players', exact: true })).toBeVisible();
  await expect(
    page.getByRole('menuitem', {
      name: /Playback speed:|Next player kill|Next player death|Kills and utility review|Hide viewer controls/,
    }),
  ).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await selectOptionsCategory(page, 'Visuals');
  await page.getByRole('switch', { name: /^Recorded inputs/ }).check();
  await page.getByRole('button', { name: 'Close viewer options' }).click();
  await expect(page.locator('.review-inputs-panel')).toBeVisible();
  await page.reload();
  await expect(page.locator('.review-inputs-panel')).toBeVisible();
  const camera = page.getByRole('combobox', { name: 'Camera mode', exact: true });
  await camera.click();
  await page.getByRole('option', { name: '2D tactical · low power', exact: true }).click();
  await players(page);
  await page.locator('.viewer-drawer .broadcast-player-select').nth(1).click();
  await expect(camera).toHaveText('2D tactical · low power');
});

test('playback settings migrate the old downtime preference and keep the two switches independent', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  await page.setViewportSize({ width: 1440, height: 900 });
  await fixture(page, { autoSkip: true });
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await selectOptionsCategory(page, 'Playback');
  const freeze = page.getByRole('switch', { name: 'Skip freeze time automatically' });
  const timeouts = page.getByRole('switch', { name: 'Skip timeouts automatically' });
  await expect(freeze).toBeChecked();
  await expect(timeouts).toBeChecked();
  await freeze.click();
  await expect(freeze).not.toBeChecked();
  await expect(timeouts).toBeChecked();
  const leadIn = page.getByRole('combobox', { name: 'Kill and death replay lead-in' });
  await leadIn.focus();
  await page.keyboard.press('Space');
  const selected = page.getByRole('option', { name: '3s', exact: true });
  await expect(selected).toHaveAttribute('data-state', 'checked');
  await expect(selected).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('option', { name: '5s', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(leadIn).toHaveText('5s');
  await expect(leadIn).toBeFocused();
});

test('recorded crosshair follows exact player evidence and missing codes never use a fake fallback', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  await page.setViewportSize({ width: 1440, height: 900 });
  await fixture(page);
  await players(page);
  await page.locator('.viewer-drawer .broadcast-player-select').first().click();
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await selectOptionsCategory(page, 'Crosshair');
  await page.getByRole('combobox', { name: 'Crosshair source' }).click();
  await page.getByRole('option', { name: 'Current player', exact: true }).click();
  await expect(page.getByRole('img', { name: 'Recorded crosshair preview' })).toBeVisible();
  await page.getByRole('button', { name: 'Close viewer options' }).click();
  await expect(page.locator('.viewer-stage .viewer-recorded-crosshair')).toHaveAttribute(
    'data-recorded-format',
    'legacy-v1',
  );
  await players(page);
  await page.locator('.viewer-drawer .broadcast-player-select').nth(1).click();
  await expect(page.locator('.viewer-stage .viewer-recorded-crosshair')).toHaveCount(0);
  await expect(page.locator('.viewer-stage .viewer-crosshair')).toHaveCount(0);
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await selectOptionsCategory(page, 'Crosshair');
  await expect(
    page.getByText('No supported crosshair was recorded for this player at this moment.', {
      exact: true,
    }),
  ).toBeVisible();
});

test('free camera keyboard movement changes real rendered pixels and ignores keys inside Options', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  await page.setViewportSize({ width: 1440, height: 900 });
  // The sample's northern spawn faces out of this unrelated QA map. At ground
  // level, W and Z can both move correctly while painting the same empty sky.
  // Match the recording coordinates to the actual installed original geometry.
  const cameraReplay = originalMapReplay('de_controls_fixture');
  cameraReplay.events = [];
  cameraReplay.grenades = [];
  await installOriginalCameraProbe(page);
  await fixture(page, {}, cameraReplay);
  const canvas = page.locator('.scene canvas');
  await expect(canvas).toBeVisible();
  await expect(page.locator('.scene')).toHaveAttribute('data-map-model-state', 'ready');
  await expect.poll(async () => (await originalCameraView(page)).position.length).toBe(3);
  const initialCamera = await originalCameraView(page);
  const before = await canvas.screenshot();
  await page.locator('.viewer-stage').focus();
  await page.keyboard.down('w');
  await page.waitForTimeout(250);
  await page.keyboard.up('w');
  const after = await canvas.screenshot();
  const movedW = await originalCameraView(page);
  expect(after.equals(before), 'W must move the actual free camera').toBe(false);
  expect(
    Math.hypot(...movedW.position.map((part, index) => part - initialCamera.position[index])),
    'W must change the rendered camera position',
  ).toBeGreaterThan(0.05);
  await page.keyboard.down('z');
  await page.waitForTimeout(250);
  await page.keyboard.up('z');
  expect((await canvas.screenshot()).equals(after), 'Z also moves the actual free camera').toBe(
    false,
  );
  const movedZ = await originalCameraView(page);
  expect(
    Math.hypot(...movedZ.position.map((part, index) => part - movedW.position[index])),
    'Z must change the rendered camera position',
  ).toBeGreaterThan(0.05);
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await page.waitForTimeout(250);
  const area = { x: 900, y: 250, width: 300, height: 300 };
  const protectedBefore = await page.screenshot({ clip: area });
  const protectedCamera = await originalCameraView(page);
  await page.getByRole('button', { name: 'Close viewer options' }).focus();
  await page.keyboard.down('w');
  await page.waitForTimeout(250);
  await page.keyboard.up('w');
  expect(
    (await page.screenshot({ clip: area })).equals(protectedBefore),
    'Options must prevent free camera movement',
  ).toBe(true);
  expect(
    (await originalCameraView(page)).position,
    'Options must also preserve the actual rendered camera position',
  ).toEqual(protectedCamera.position);
  await selectOptionsCategory(page, 'Performance');
  await page.getByRole('slider', { name: '3D render resolution', exact: true }).press('Home');
  await expect
    .poll(async () => (await originalCameraView(page)).drawingBuffer)
    .toEqual(protectedCamera.drawingBuffer.map((part) => part / 2));
});
