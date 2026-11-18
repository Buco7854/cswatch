import { installDemoMapDescriptor } from './fixtures/map-assets';
import { test, expect } from '@playwright/test';
import { sample } from '../src/sample';
import { activateViewerAction } from './fixtures/viewer-actions';

test('a late private note response cannot reopen review after leaving and revisiting a demo', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  await page.addInitScript(() =>
    ['viewer-settings', 'viewer-settings-mobile'].forEach((key) =>
      localStorage.setItem(key, JSON.stringify({ quality: 'low' })),
    ),
  );
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      json: {
        user: {
          id: 'note-fixture-user',
          username: 'note_fixture',
          is_admin: false,
          csrf: 'synthetic-note-csrf',
          identities: [],
        },
      },
    }),
  );
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let posts = 0;
  await page.route('**/api/demos/note-**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/bookmarks')) {
      if (route.request().method() !== 'POST') return route.fulfill({ json: [] });
      const number = ++posts;
      const body = route.request().postDataJSON();
      if (number === 1) await pending;
      return route.fulfill({ json: { id: `note-${number}`, ...body } });
    }
    if (path.endsWith('/playback'))
      return route.fulfill({ json: { ...sample, sample: false, map: path.split('/')[3] } });
    const id = path.split('/').at(-1)!;
    return route.fulfill({
      json: {
        id,
        name: id,
        source: 'upload',
        status: 'ready',
        owned: true,
        public: false,
        size: 100,
        created_at: 0,
        map: 'Explicit note lifecycle fixture',
        duration: 60,
        rounds: 3,
        error: null,
      },
    });
  });
  await installDemoMapDescriptor(page, 'note-a');
  await installDemoMapDescriptor(page, 'note-b');
  await page.goto('/watch/note-a');
  await activateViewerAction(page, 'Add note');
  await page.getByPlaceholder('What happened here?').fill('Private pending note from old visit');
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect.poll(() => posts).toBe(1);
  for (const id of ['note-b', 'note-a']) {
    await page.evaluate((id) => {
      history.pushState({}, '', `/watch/${id}`);
      dispatchEvent(new PopStateEvent('popstate'));
    }, id);
    await expect(page.getByRole('heading', { name: id, exact: true })).toBeVisible();
  }
  const completed = page.waitForResponse(
    (response) =>
      response.url().endsWith('/note-a/bookmarks') && response.request().method() === 'POST',
  );
  release();
  await completed;
  await expect(page.locator('.viewer-drawer')).toHaveCount(0);
  await expect(page.getByText('Private pending note from old visit', { exact: true })).toHaveCount(
    0,
  );
  await activateViewerAction(page, 'Add note');
  await expect(page.getByPlaceholder('What happened here?')).toBeEmpty();
  await page.getByPlaceholder('What happened here?').fill('Note from current visit');
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect(page.getByText('Note from current visit', { exact: true })).toBeVisible();
  await expect(page.getByText('Private pending note from old visit', { exact: true })).toHaveCount(
    0,
  );
});
