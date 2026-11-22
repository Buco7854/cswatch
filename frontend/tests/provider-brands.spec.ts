import { expect, test, type Locator } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { installMemberWorkspace, memberConfig, memberUser } from './fixtures/member-workspace';

const profiles = [1440, 768, 390].flatMap((width) =>
  ['en', 'fr'].flatMap((language) =>
    ['dark', 'light'].map((theme) => ({
      language,
      theme,
      width,
      height: width === 390 ? 844 : 900,
    })),
  ),
);

test('a FACEIT import resolving after leaving connections keeps the current page', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE) || Boolean(process.env.E2E_SETUP));
  await installMemberWorkspace(page);
  await page.route('**/api/config', (route) =>
    route.fulfill({ json: { ...memberConfig, faceit_configured: true, faceit_downloads: true } }),
  );
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      json: {
        user: {
          ...memberUser,
          identities: [
            ...memberUser.identities,
            { provider: 'faceit', subject: 'd999aa66-f0df-41ba-857f-50de9f9b7af6' },
          ],
        },
      },
    }),
  );
  await page.route('**/api/connections/faceit/match-demos?*', (route) =>
    route.fulfill({
      json: {
        files: [
          { id: 'a'.repeat(64), file: 1, demo_id: null },
          { id: 'b'.repeat(64), file: 2, demo_id: null },
        ],
      },
    }),
  );
  const wait = Promise.withResolvers<void>();
  await page.route('**/api/connections/faceit/import', async (route) => {
    expect(route.request().postDataJSON().resource_id).toBe('b'.repeat(64));
    await wait.promise;
    await route.fulfill({ status: 202, json: { id: 'late-faceit-import' } });
  });
  const unexpected: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/demos/late-faceit-import')) unexpected.push(request.url());
  });
  await page.goto('/account/connections');
  await page
    .getByLabel('FACEIT match ID or match room URL')
    .fill('1-d999aa66-f0df-41ba-857f-50de9f9b7af8');
  await page.getByRole('button', { name: 'Find demo files', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Import demo file 1' })).toBeEnabled();
  await page.getByRole('button', { name: 'Import demo file 2' }).click();
  await expect(page.getByRole('button', { name: 'Working…', exact: true }).last()).toBeDisabled();
  await page.getByRole('link', { name: 'cswatch home', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Demo library', exact: true })).toBeVisible();
  const response = page.waitForResponse('**/api/connections/faceit/import');
  wait.resolve();
  expect((await response).status()).toBe(202);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await expect(page).toHaveURL(/\/library$/);
  expect(unexpected).toEqual([]);
});

async function compactIcon(icon: Locator, container: Locator) {
  await expect(icon).toBeVisible();
  await expect(icon).toHaveAttribute('viewBox', '0 0 24 24');
  await expect(icon).toHaveAttribute('aria-hidden', 'true');
  const bounds = (await icon.boundingBox())!;
  expect(bounds.width).toBe(20);
  expect(bounds.height).toBe(20);
  const parent = (await container.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(parent.x);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(parent.x + parent.width);
  expect(bounds.y).toBeGreaterThanOrEqual(parent.y);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(parent.y + parent.height);
  expect(await icon.evaluate((element) => getComputedStyle(element).fill)).toBe(
    await container.evaluate((element) => getComputedStyle(element).color),
  );
}

for (const profile of profiles) {
  test(`provider actions use compact icons and localized text in ${profile.language} ${profile.theme} ${profile.width}`, async ({
    page,
  }) => {
    test.skip(Boolean(process.env.E2E_PRIVATE) || Boolean(process.env.E2E_SETUP));
    await page.setViewportSize({ width: profile.width, height: profile.height });
    await installMemberWorkspace(page);
    await page.route('**/api/auth/me', (route) => route.fulfill({ json: { user: null } }));
    await page.addInitScript(({ language, theme }) => {
      localStorage.setItem('cswatch.language', language);
      localStorage.setItem('theme', theme);
      (window as any).__brandCSP = [];
      document.addEventListener('securitypolicyviolation', (event) =>
        (window as any).__brandCSP.push(event.violatedDirective),
      );
    }, profile);
    const images: string[] = [],
      errors: string[] = [];
    page.on('request', (request) => {
      if (request.resourceType() === 'image') images.push(request.url());
    });
    page.on('pageerror', (error) => errors.push(error.message));
    const capture = async (screen: string) => {
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      if (process.env.CSWATCH_PROVIDER_SCREENSHOTS) {
        mkdirSync(process.env.CSWATCH_PROVIDER_SCREENSHOTS, { recursive: true });
        await page.screenshot({
          path: resolve(
            process.env.CSWATCH_PROVIDER_SCREENSHOTS,
            `${profile.language}-${profile.theme}-${profile.width}-${screen}.png`,
          ),
          fullPage: true,
        });
      }
    };
    await page.goto('/login?returnTo=%2Fwatch%2Fprovider-fixture');
    const label = profile.language === 'fr' ? 'Continuer avec Steam' : 'Continue with Steam';
    const signIn = page.getByRole('link', { name: label, exact: true });
    await expect(signIn).toHaveAttribute(
      'href',
      '/api/auth/steam?returnTo=%2Fwatch%2Fprovider-fixture',
    );
    await expect(signIn).toHaveText(label);
    await expect(signIn.locator('img')).toHaveCount(0);
    await compactIcon(signIn.locator('svg'), signIn);
    const height = (await signIn.boundingBox())!.height;
    expect(height).toBeGreaterThanOrEqual(44);
    expect(height).toBeLessThanOrEqual(48);
    expect(height).toBe((await page.locator('.auth-submit').boundingBox())!.height);
    await signIn.focus();
    await expect(signIn).toBeFocused();
    await page.getByRole('heading', { level: 1 }).click();
    await expect(signIn).not.toBeFocused();
    await capture('login');

    const connected = profile.width !== 768;
    await page.route('**/api/auth/me', (route) =>
      route.fulfill({ json: { user: connected ? memberUser : { ...memberUser, identities: [] } } }),
    );
    await page.goto('/account/connections');
    for (const provider of ['Steam', 'FACEIT']) {
      const heading = page.getByRole('heading', { name: provider, exact: true });
      await compactIcon(heading.locator('svg'), heading);
    }
    const steamLink = page.locator('button.provider-steam-link');
    await expect(steamLink).toBeEnabled();
    await expect(steamLink).toHaveText(
      connected
        ? profile.language === 'fr'
          ? 'Revérifier Steam'
          : 'Verify Steam again'
        : profile.language === 'fr'
          ? 'Associer Steam'
          : 'Connect Steam',
    );
    await compactIcon(steamLink.locator('svg'), steamLink);
    const faceit = page.getByRole('button', {
      name: profile.language === 'fr' ? 'Vérifier FACEIT' : 'Verify FACEIT',
      exact: true,
    });
    await expect(faceit).toBeDisabled();
    await compactIcon(faceit.locator('svg'), faceit);
    for (const action of [steamLink, faceit])
      expect((await action.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    const notice = await (await page.request.get('/licenses/provider-brands.txt')).text();
    expect(notice).toContain('CC0-1.0');
    expect(notice).toContain('©2026 Valve Corporation.');
    if (connected) {
      await page.route('**/api/connections/steam/matches?*', (route) =>
        route.fulfill({
          json: { configured: false, retry_at: 0, next_offset: null, items: [] },
        }),
      );
      await page
        .locator('summary')
        .filter({
          hasText:
            profile.language === 'fr' ? 'Synchronisation des matchs Steam' : 'Steam match sync',
        })
        .click();
      await expect(
        page.getByText(
          profile.language === 'fr'
            ? 'L’administration doit configurer la synchronisation des matchs Steam.'
            : 'The administrator must configure Steam match sync.',
          { exact: true },
        ),
      ).toBeVisible();
    }
    const skip = page.locator('.skip-link');
    await expect(skip).toHaveCSS('clip-path', 'inset(50%)');
    await skip.focus();
    await expect(skip).toBeFocused();
    await expect(skip).toHaveCSS('clip-path', 'none');
    await skip.blur();
    if (connected) {
      await expect(
        page.getByText(
          profile.language === 'fr'
            ? 'Vérifiez le compte FACEIT associé à votre compte Steam.'
            : 'Verify the FACEIT account linked to your Steam account.',
          { exact: true },
        ),
      ).toBeVisible();
    }
    await capture('connections');
    expect(images.every((url) => new URL(url).origin === new URL(page.url()).origin)).toBe(true);
    expect(images.some((url) => /steam-openid|faceit-on-(light|dark)/.test(url))).toBe(false);
    expect(await page.evaluate(() => (window as any).__brandCSP)).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test('sign-in and connections expose only configured actions and link Steam with a same-origin POST', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE) || Boolean(process.env.E2E_SETUP));
  await installMemberWorkspace(page);
  await page.route('**/api/config', (route) =>
    route.fulfill({ json: { ...memberConfig, steam_enabled: false } }),
  );
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: { user: null } }));
  await page.goto('/login?steam=cancelled&returnTo=%2Faccount%2Fconnections');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByText('Steam sign-in was cancelled. Start again.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Continue with Steam' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /FACEIT/ })).toHaveCount(0);
  await page.route('**/api/config', (route) => route.fulfill({ json: memberConfig }));
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ json: { user: { ...memberUser, identities: [] } } }),
  );
  await page.route('**/api/auth/steam/link', (route) => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().headers()['x-csrf-token']).toBe(memberUser.csrf);
    return route.fulfill({ status: 403, json: { detail: 'Steam sign-in is disabled.' } });
  });
  await page.goto('/account/connections');
  await page.getByRole('button', { name: 'Connect Steam', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert')).toHaveText('Steam sign-in is disabled.');
  await expect(page.getByRole('button', { name: 'Verify FACEIT' })).toBeDisabled();
});

test('Steam sync displays discovered matches and opens a pre-identified upload', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE) || Boolean(process.env.E2E_SETUP));
  await installMemberWorkspace(page);
  await page.route('**/api/config', (route) =>
    route.fulfill({ json: { ...memberConfig, steam_discovery: true } }),
  );
  const match = '3230642215713767580';
  const code = 'CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2xK';
  let saved = false;
  await page.route('**/api/connections/steam/matches?*', (route) =>
    route.fulfill({
      json: {
        configured: saved,
        retry_at: 0,
        next_offset: null,
        items: saved
          ? [
              { match_id: match, share_code: code, demo_id: null },
              { match_id: '1234', share_code: code, demo_id: 'member-design-0' },
            ]
          : [],
      },
    }),
  );
  await page.route('**/api/connections/steam/history', (route) => {
    expect(route.request().method()).toBe('PUT');
    expect(route.request().postDataJSON()).toEqual({
      auth_code: 'ABCD-EFGHI-JKLM',
      share_code: code,
    });
    saved = true;
    return route.fulfill({ json: { up_to_date: true } });
  });
  await page.route('**/api/connections/steam/history/sync', (route) =>
    route.fulfill({
      status: 429,
      json: { detail: 'Steam is rate limiting requests. Try again later.' },
    }),
  );
  await page.goto('/account/connections');
  await page.getByText('Steam match sync', { exact: true }).click();
  const help = page.getByRole('link', { name: 'Get your codes on Steam Support', exact: true });
  await expect(help).toHaveClass(/button/);
  await expect(help.locator('svg')).toHaveCount(1);
  await expect(help).toHaveAttribute('target', '_blank');
  expect((await help.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.getByLabel('Game authentication code').fill('ABCD-EFGHI-JKLM');
  await page
    .getByLabel('Starting match sharing code')
    .fill('steam://rungame/730/76561202255233023/+csgo_download_match%20' + code);
  await page.getByRole('button', { name: 'Verify and save codes' }).click();
  await expect(page.getByText('Steam sync codes verified.')).toBeVisible();
  await expect(page.getByLabel('Game authentication code')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Download in CS2' }).first()).toHaveAttribute(
    'href',
    /steam:\/\/rungame\/730\/.*\+csgo_download_match/,
  );
  await expect(page.getByRole('link', { name: 'Open uploaded demo' })).toHaveAttribute(
    'href',
    '/watch/member-design-0',
  );
  await page.getByRole('button', { name: 'Sync Steam matches' }).click();
  await expect(page.getByRole('alert')).toHaveText(
    'Steam is rate limiting requests. Try again later.',
  );
  await page.getByRole('link', { name: 'Upload this demo' }).click();
  await expect(page.getByRole('dialog').getByText('Steam match ' + match)).toBeVisible();
});

test('FACEIT history keeps a stable time window across pages', async ({ page }) => {
  test.skip(Boolean(process.env.E2E_PRIVATE) || Boolean(process.env.E2E_SETUP));
  await installMemberWorkspace(page);
  await page.route('**/api/config', (route) =>
    route.fulfill({ json: { ...memberConfig, faceit_configured: true, faceit_downloads: true } }),
  );
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      json: {
        user: {
          ...memberUser,
          identities: [
            ...memberUser.identities,
            { provider: 'faceit', subject: 'd999aa66-f0df-41ba-857f-50de9f9b7af6' },
          ],
        },
      },
    }),
  );
  await page.route('**/api/connections/faceit/matches?*', (route) => {
    const query = new URL(route.request().url()).searchParams;
    const first = query.get('offset') === '0';
    expect(query.get('to')).toBe(first && !query.has('to') ? null : '1700000000');
    return route.fulfill({
      json: {
        items: [
          {
            match_id: first ? 'first-page' : 'second-page',
            competition_name: first ? 'First result' : 'Second result',
          },
        ],
        to: 1700000000,
        next_offset: first ? 20 : null,
      },
    });
  });
  await page.goto('/account/connections');
  await page.getByRole('button', { name: 'Recent matches', exact: true }).click();
  await expect(page.getByText('First result')).toBeVisible();
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(page.getByText('Second result')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next page' })).toBeDisabled();
  await page.getByRole('button', { name: 'Previous page' }).click();
  await expect(page.getByText('First result')).toBeVisible();
});
