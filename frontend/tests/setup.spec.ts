import { createHmac } from 'node:crypto';
import { accountStatus } from './fixtures/account-status';
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('first administrator enrollment requires the private setup code and closes permanently after success', async ({
  page,
  request,
  baseURL,
}) => {
  test.skip(!process.env.E2E_SETUP, 'Dedicated empty-instance setup journey.');
  const token = readFileSync(join(process.env.E2E_DATA_DIR!, 'setup-token'), 'utf8').trim();
  await page.goto('/library');
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole('heading', { name: 'Set up cswatch', exact: true })).toBeVisible();
  await page.getByLabel('Setup code', { exact: true }).fill('0'.repeat(64));
  await page.getByLabel('Username', { exact: true }).fill('fixture_admin');
  await page.getByLabel('Password', { exact: true }).fill('Disposable-admin-password-2026');
  await page.getByRole('button', { name: 'Create administrator', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Setup code is invalid.');
  await page.getByLabel('Setup code', { exact: true }).fill(token);
  await page.getByRole('button', { name: 'Create administrator', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Secure your account' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Demo library' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Set up authenticator', exact: true }).click();
  const base32 = await page.getByLabel('Setup key', { exact: true }).inputValue();
  const bits = [...base32]
    .map((c) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c).toString(2).padStart(5, '0'))
    .join('');
  const bytes = Buffer.from(bits.match(/.{8}/g)!.map((x) => parseInt(x, 2)));
  const step = Buffer.alloc(8);
  step.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const mac = createHmac('sha1', bytes).update(step).digest();
  const code = String((mac.readUInt32BE(mac[mac.length - 1] & 15) & 0x7fffffff) % 1000000).padStart(
    6,
    '0',
  );
  await page.getByLabel('Authenticator code', { exact: true }).fill(code);
  await page.getByRole('button', { name: 'Activate authenticator' }).click();
  await expect(page.getByRole('heading', { name: 'Save your recovery codes' })).toBeVisible();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page).toHaveURL(/\/library$/);
  await expect(page.getByRole('heading', { name: 'Demo library', exact: true })).toBeVisible();
  await page.goto('/setup');
  await expect(page).toHaveURL(/\/library$/);
  const anonymous = await (await request.get('/api/auth/me')).json();
  const repeated = await request.post('/api/setup', {
    headers: { origin: baseURL!, 'x-csrf-token': anonymous.session.csrf },
    data: {
      username: 'another_admin',
      password: 'Disposable-admin-password-2026',
      setupToken: token,
    },
  });
  expect(repeated.status()).toBe(409);
});

test('operator environment credentials initialize an administrator before the public page is served', async ({
  page,
  request,
}) => {
  test.skip(Boolean(process.env.E2E_SETUP) || Boolean(process.env.E2E_PRIVATE));
  const response = await request.get('/api/config');
  expect((await response.json()).setup_required).toBe(false);
  await page.goto('/setup');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'Set up cswatch', exact: true })).toHaveCount(0);
});

test('setup retries configuration refresh without creating the administrator twice', async ({
  page,
  request,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  const config = await (await request.get('/api/config')).json();
  let created = false,
    refreshFailed = false,
    attempts = 0;
  await page.route('**/api/config', (route) => {
    if (created && !refreshFailed) {
      refreshFailed = true;
      return route.abort('failed');
    }
    return route.fulfill({ json: { ...config, setup_required: !created } });
  });
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      json: accountStatus(
        created
          ? {
              id: 'setup-recovery-fixture',
              username: 'fixture_admin',
              role: 'admin',
              csrf: 'synthetic-csrf',
              identities: [],
            }
          : null,
      ),
    }),
  );
  await page.route('**/api/setup', (route) => {
    attempts++;
    created = true;
    return route.fulfill({
      status: 201,
      json: accountStatus({ username: 'fixture_admin', role: 'admin' }),
    });
  });
  await page.route('**/api/demos?*', (route) => route.fulfill({ json: { demos: [], total: 0 } }));
  await page.goto('/setup');
  await page.getByLabel('Setup code', { exact: true }).fill('a'.repeat(64));
  await page.getByLabel('Username', { exact: true }).fill('fixture_admin');
  await page.getByLabel('Password', { exact: true }).fill('Disposable-admin-password-2026');
  await page.getByRole('button', { name: 'Create administrator', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Connection unavailable' })).toBeVisible();
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page).toHaveURL(/\/library$/);
  await expect(page.getByRole('button', { name: 'fixture_admin', exact: true })).toBeVisible();
  expect(attempts).toBe(1);
});

test('setup recovers a committed enrollment when its POST response is interrupted', async ({
  page,
  request,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  const config = await (await request.get('/api/config')).json();
  let committed = false,
    attempts = 0;
  await page.route('**/api/config', (route) =>
    route.fulfill({ json: { ...config, setup_required: !committed } }),
  );
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      json: accountStatus(
        committed
          ? {
              id: 'setup-committed-fixture',
              username: 'fixture_admin',
              role: 'admin',
              csrf: 'synthetic-committed-setup-csrf',
              identities: [],
            }
          : null,
      ),
    }),
  );
  await page.route('**/api/setup', (route) => {
    attempts++;
    committed = true;
    return route.abort('failed');
  });
  await page.route('**/api/demos?*', (route) => route.fulfill({ json: { demos: [], total: 0 } }));
  await page.goto('/setup');
  await page.getByLabel('Setup code', { exact: true }).fill('a'.repeat(64));
  await page.getByLabel('Username', { exact: true }).fill('fixture_admin');
  await page.getByLabel('Password', { exact: true }).fill('Disposable-admin-password-2026');
  await page.getByRole('button', { name: 'Create administrator', exact: true }).click();
  await expect(page).toHaveURL(/\/library$/);
  await expect(page.getByRole('button', { name: 'fixture_admin', exact: true })).toBeVisible();
  expect(attempts).toBe(1);
});

test('an uncertain uncommitted setup preserves edits and prevents duplicate submissions while checking the server', async ({
  page,
  request,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  const config = await (await request.get('/api/config')).json();
  let releaseRefresh!: () => void;
  const refresh = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  let attempts = 0,
    checking = false,
    committed = false;
  await page.route('**/api/config', async (route) => {
    if (attempts === 1) {
      checking = true;
      await refresh;
    }
    return route.fulfill({ json: { ...config, setup_required: !committed } });
  });
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      json: accountStatus(
        committed
          ? {
              id: 'setup-edit-fixture',
              username: 'edited_admin',
              role: 'admin',
              csrf: 'synthetic-edited-setup-csrf',
              identities: [],
            }
          : null,
      ),
    }),
  );
  await page.route('**/api/setup', (route) => {
    if (++attempts === 1) return route.abort('failed');
    committed = true;
    return route.fulfill({ status: 201, json: accountStatus({ username: 'edited_admin' }) });
  });
  await page.route('**/api/demos?*', (route) => route.fulfill({ json: { demos: [], total: 0 } }));
  try {
    await page.goto('/setup');
    await page.getByLabel('Setup code', { exact: true }).fill('a'.repeat(64));
    await page.getByLabel('Username', { exact: true }).fill('initial_admin');
    await page.getByLabel('Password', { exact: true }).fill('Disposable-admin-password-2026');
    await page.getByRole('button', { name: 'Create administrator', exact: true }).click();
    await expect.poll(() => checking).toBe(true);
    await page.getByLabel('Username', { exact: true }).fill('edited_admin');
    await page.getByLabel('Setup code', { exact: true }).fill('b'.repeat(64));
    await page
      .locator('.setup-page form')
      .evaluate((form: HTMLFormElement) => form.requestSubmit());
    expect(attempts).toBe(1);
    await expect(
      page.getByRole('button', { name: 'Creating administrator…', exact: true }),
    ).toBeDisabled();
    releaseRefresh();
    await expect(page.getByRole('alert')).toHaveText('Connection lost. Try again.');
    await expect(page.getByLabel('Username', { exact: true })).toHaveValue('edited_admin');
    await expect(page.getByLabel('Setup code', { exact: true })).toHaveValue('b'.repeat(64));
    await expect(page.getByLabel('Password', { exact: true })).toHaveValue(
      'Disposable-admin-password-2026',
    );
    await page.getByRole('button', { name: 'Create administrator', exact: true }).click();
    await expect(page).toHaveURL(/\/library$/);
    expect(attempts).toBe(2);
  } finally {
    releaseRefresh();
  }
});
