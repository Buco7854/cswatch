import { expect, test } from '@playwright/test';
import { accountStatus, configForSyntheticAccount } from './fixtures/account-status';
import { memberUser } from './fixtures/member-workspace';
import { installMapFixture } from './fixtures/map-assets';
import { fulfillReplayFixture } from './fixtures/streamed-replay';
import { actor, recordedReplay, target } from './fixtures/review-playback';
import { expectCameraControl } from './fixtures/viewer-transport';

test('a new match opens live in POV with the game FOV and the recorded match HUD', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.addInitScript(() => {
    localStorage.setItem('viewer-settings', JSON.stringify({ cameraFov: 48, economy: false }));
  });
  const replay = recordedReplay();
  replay.rounds[0].winner = 3;
  replay.rounds.push({ number: 2, tick: 1024, liveTick: 1056 });
  for (const frame of replay.frames) {
    frame.players[0].armor = 70;
    frame.players[0].money = 3450;
    frame.players[0].stats = { kills: 4, deaths: 1 };
    frame.players[1].inventory = ['c4'];
  }
  await page.route('**/api/demos/match-hud-fixture', (route) =>
    route.fulfill({
      json: {
        id: 'match-hud-fixture',
        name: 'Original HUD test',
        status: 'ready',
        public: true,
        owned: false,
        map: replay.map,
      },
    }),
  );
  await page.route('**/api/demos/match-hud-fixture/playback', (route) =>
    fulfillReplayFixture(route, replay),
  );
  await installMapFixture(page, replay.map, 'match-hud-fixture');

  await page.goto('/watch/match-hud-fixture');
  const position = page.getByRole('slider', { name: 'Playback position' });
  const scene = page.locator('.scene');
  await expect(position).toHaveValue('64');
  await expect(scene).toHaveAttribute('data-camera-fov', '73.74');
  await expectCameraControl(page, 'Player perspective');
  const hud = page.locator('.viewer-review-hud');
  const observed = hud.locator('[data-player-id="' + actor + '"] button');
  const opponent = hud.locator('[data-player-id="' + target + '"]');
  await expect(observed).toHaveAttribute('aria-pressed', 'true');
  await expect(observed).toHaveAttribute('aria-keyshortcuts', '1');
  await expect(observed).toContainText('K 4');
  await expect(observed).toContainText('D 1');
  await expect(observed).toContainText('$3,450');
  await expect(opponent.getByRole('img', { name: 'Carries C4' })).toBeVisible();
  const livingRow = (await opponent.getByRole('button').boundingBox())!;

  const firstRound = page.locator('.timeline-round-segment').first();
  await expect(firstRound).toHaveAttribute('data-winner', '3');
  await expect(firstRound).toHaveAttribute('aria-current', 'step');
  await page.getByRole('tab', { name: /^Utility/ }).click();
  await expect(page.getByRole('tab', { name: /^Utility/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.locator('.review-feed-summary').first().click();
  await expect(position).toHaveValue('256');

  await page.getByRole('button', { name: 'Forward five seconds', exact: true }).click();
  await expect(position).toHaveValue('576');
  await page.getByRole('button', { name: 'Forward fifteen seconds', exact: true }).click();
  await expect(position).toHaveValue('1536');
  await page.getByRole('button', { name: 'Rewind fifteen seconds', exact: true }).click();
  await expect(position).toHaveValue('576');
  await page.getByRole('button', { name: 'Next live round', exact: true }).click();
  await expect(position).toHaveValue('1056');
  await expect(page.locator('.timeline-round-segment').last()).toHaveAttribute(
    'aria-current',
    'step',
  );
  await page.getByRole('button', { name: 'Previous round', exact: true }).click();
  await expect(position).toHaveValue('64');

  await position.fill('800');
  await expect(opponent).toHaveClass(/is-out/);
  await expect(opponent.getByRole('img', { name: 'Carries C4' })).toHaveCount(0);
  await expect(opponent).not.toContainText('Weapon unavailable');
  expect((await opponent.getByRole('button').boundingBox())!.height).toBe(livingRow.height);
  const prompt = page.getByRole('group', { name: 'Moment shortcuts' });
  await expect(prompt.getByRole('button', { name: 'Replay kill' })).toBeVisible();
  await expect(prompt.getByRole('button', { name: 'Replay death' })).toBeVisible();
  await page.locator('.viewer-stage').focus();
  await page.keyboard.press('2');
  await expect(opponent.getByRole('button')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('ArrowLeft');
  await expect(position).toHaveValue('480');

  await page.reload();
  await expect(position).toHaveValue('480');
  await page.goto('/watch/match-hud-fixture?tick=700&player=' + target);
  await expect(position).toHaveValue('700');
  await expect(opponent.getByRole('button')).toHaveAttribute('aria-pressed', 'true');
});

test('a fresh recording opens at the first available living POV while an explicit earlier time is respected', async ({
  page,
}) => {
  if (process.env.E2E_PRIVATE) {
    await configForSyntheticAccount(page);
    await page.route('**/api/auth/me', (route) =>
      route.fulfill({ json: accountStatus({ ...memberUser, role: 'member' }) }),
    );
  }
  const id = 'delayed-pov-fixture',
    replay = recordedReplay();
  replay.frames[0].players = [];
  await page.route('**/api/demos/' + id, (route) =>
    route.fulfill({
      json: {
        id,
        name: 'Delayed spawn',
        status: 'ready',
        public: true,
        owned: false,
        map: replay.map,
      },
    }),
  );
  await page.route('**/api/demos/' + id + '/playback', (route) =>
    fulfillReplayFixture(route, replay),
  );
  await installMapFixture(page, replay.map, id);
  await page.goto('/watch/' + id);
  const position = page.getByRole('slider', { name: 'Playback position' });
  await expect(position).toHaveValue('256');
  await expectCameraControl(page, 'Player perspective');
  await page.goto('/watch/' + id + '?tick=12');
  await expect(position).toHaveValue('12');
  await position.fill('256');
  await expectCameraControl(page, 'Player perspective');
  await page.goto('/watch/sample');
  await expect(page.getByRole('slider', { name: 'Playback position' })).toBeVisible();
  await expectCameraControl(page, 'Player perspective');
});
