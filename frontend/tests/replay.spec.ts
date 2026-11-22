import { chooseCameraControl } from './fixtures/viewer-transport';
import { test, expect } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { writeReplay } from '../../backend/src/replay';
import { sample } from '../src/sample';

test('viewer streams only nearby time slices, pauses on a failed seek, retries and keeps whole-match navigation', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE), 'Transport UI fixture is a public synthetic match.');
  const dir = mkdtempSync(join(tmpdir(), 'cswatch-browser-replay-'));
  const calls: number[] = [];
  let failFar = true;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() =>
    ['viewer-settings-v2', 'viewer-settings-v2-mobile'].forEach((key) =>
      localStorage.setItem(key, JSON.stringify({ economy: true, quality: 'low' })),
    ),
  );
  try {
    await writeReplay(dir, {
      ...sample,
      frames: Array.from({ length: 2401 }, (_, i) => ({
        ...sample.frames[i % sample.frames.length],
        tick: i * 4,
      })),
    });
    const decode = (file: string) => gunzipSync(readFileSync(join(dir, file))).toString();
    await page.route('**/api/demos/chunk-fixture**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      const chunk = path.match(/\/chunks\/(\d+)$/);
      if (chunk) {
        const index = Number(chunk[1]);
        calls.push(index);
        if (index === 4 && failFar) {
          failFar = false;
          await route.fulfill({ status: 503, json: { detail: 'Temporary test network failure.' } });
        } else
          await route.fulfill({
            contentType: 'application/json',
            body: decode(`chunks/${index}.json.gz`),
          });
      } else if (path.endsWith('/playback'))
        await route.fulfill({ contentType: 'application/json', body: decode('manifest.json.gz') });
      else
        await route.fulfill({
          json: {
            id: 'chunk-fixture',
            name: 'Synthetic chunk transport fixture',
            owned: false,
            public: true,
            status: 'ready',
            source: 'upload',
          },
        });
    });
    await page.goto('/watch/chunk-fixture');
    await expect(
      page.getByRole('heading', { name: 'Training courtyard', exact: true }),
    ).toBeVisible();
    await chooseCameraControl(page, '2D tactical · low power');
    const slider = page.getByRole('slider', { name: 'Playback position' });
    await expect(slider).toHaveAttribute('max', '9600');
    await expect.poll(() => calls.includes(1)).toBe(true);
    expect(calls).toEqual([0, 1]);
    await slider.fill('8000');
    await expect(page.getByRole('alert')).toContainText('This moment could not be loaded.');
    await expect(page.getByRole('complementary', { name: 'Analysis HUD' })).toBeHidden();
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await page.waitForTimeout(150);
    await expect(slider).toHaveValue('8000');
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(page.locator('.replay-buffer')).toHaveCount(0);
    await expect(page.getByRole('complementary', { name: 'Analysis HUD' })).toBeVisible();
    await expect.poll(async () => Number(await slider.inputValue())).toBeGreaterThan(8000);
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await page.getByRole('button', { name: 'Replay tools', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Timeline options', exact: true }).click();
    const round = page.getByRole('combobox', { name: 'Round', exact: true });
    await round.click();
    await page.getByRole('option', { name: 'Round 2', exact: true }).click();
    await expect(page.locator('.timeline-round-segment[aria-current="step"]')).toHaveText('2');
    await expect(slider).toHaveValue('1408');
    await expect(slider).toHaveAttribute('max', '9600');
    expect(errors).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
