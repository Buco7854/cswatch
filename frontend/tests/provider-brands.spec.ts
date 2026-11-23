import { accountStatus } from './fixtures/account-status';
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
    await page.route('**/api/auth/me', (route) => route.fulfill({ json: accountStatus(null) }));
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
    const signIn = page.getByRole('button', { name: label, exact: true });
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
    const faceitVerification =
      profile.theme === 'light' ? 'unavailable' : connected ? 'ready' : 'steam_required';
    await page.route('**/api/auth/me', (route) =>
      route.fulfill({
        json: accountStatus({
          ...memberUser,
          identities: connected ? memberUser.identities : [],
          match_sources: { ...memberUser.match_sources, faceit_verification: faceitVerification },
        }),
      }),
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
    if (faceitVerification === 'ready') {
      await expect(faceit).toBeEnabled();
      await compactIcon(faceit.locator('svg'), faceit);
      expect((await faceit.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    } else {
      await expect(faceit).toHaveCount(0);
    }
    expect((await steamLink.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    const notice = await (await page.request.get('/licenses/provider-brands.txt')).text();
    expect(notice).toContain('CC0-1.0');
    expect(notice).toContain('©2026 Valve Corporation.');
    if (connected) {
      await page.route('**/api/connections/steam/history', (route) =>
        route.fulfill({
          json: { available: false, configured: false, needs_codes: false, retry_at: 0 },
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
            ? 'Cette instance n’a pas tout ce qu’il faut pour synchroniser automatiquement vos matchs Steam. Vous pouvez toujours ajouter vos démos.'
            : 'This instance does not have everything needed for automatic Steam match sync. You can still upload your demos.',
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
    const verification = page.getByText(
      profile.language === 'fr'
        ? 'Vérifiez le compte FACEIT associé à votre compte Steam.'
        : 'Verify the FACEIT account linked to your Steam account.',
      { exact: true },
    );
    if (faceitVerification === 'ready') await expect(verification).toBeVisible();
    else await expect(verification).toHaveCount(0);
    await capture('connections');
    expect(images.every((url) => new URL(url).origin === new URL(page.url()).origin)).toBe(true);
    expect(images.some((url) => /steam-openid|faceit-on-(light|dark)/.test(url))).toBe(false);
    expect(await page.evaluate(() => (window as any).__brandCSP)).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test('sign-in and connections expose only configured actions and start Steam with same-origin POSTs', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE) || Boolean(process.env.E2E_SETUP));
  await installMemberWorkspace(page);
  await page.route('**/api/config', (route) =>
    route.fulfill({ json: { ...memberConfig, steam_enabled: false } }),
  );
  const anonymous = accountStatus(null);
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: anonymous }));
  const cancelled = '/login?steam=cancelled&returnTo=%2Faccount%2Fconnections';
  await page.goto(cancelled);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByText('Steam sign-in was cancelled. Start again.')).toBeVisible();
  const steam = page.getByRole('button', { name: 'Continue with Steam', exact: true });
  await expect(steam).toHaveCount(0);
  await expect(page.getByRole('link', { name: /FACEIT/ })).toHaveCount(0);

  await page.route('**/api/config', (route) => route.fulfill({ json: memberConfig }));
  await page.route('**/api/auth/steam', (route) => {
    const request = route.request();
    expect(request.method()).toBe('POST');
    expect(request.headers()['x-csrf-token']).toBe(anonymous.session.csrf);
    expect(request.postDataJSON()).toEqual({ return_to: '/account/connections' });
    return route.fulfill({ json: { location: cancelled } });
  });
  await page.goto('/login?returnTo=%2Faccount%2Fconnections');
  await expect(steam).toBeEnabled();
  await steam.press('Enter');
  await expect(page).toHaveURL(/\/login\?steam=cancelled&returnTo=%2Faccount%2Fconnections$/);
  await expect(page.getByText('Steam sign-in was cancelled. Start again.')).toBeVisible();

  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ json: accountStatus({ ...memberUser, identities: [] }) }),
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
  await expect(page.getByRole('button', { name: 'Verify FACEIT' })).toHaveCount(0);
});

for (const language of ['en', 'fr']) {
  test(`Steam callback messages stay by their action in ${language}`, async ({ page }) => {
    test.skip(Boolean(process.env.E2E_PRIVATE) || Boolean(process.env.E2E_SETUP));
    const french = language === 'fr';
    await page.setViewportSize(french ? { width: 390, height: 844 } : { width: 1440, height: 900 });
    await installMemberWorkspace(page);
    await page.addInitScript(
      ({ language, french }) => {
        localStorage.setItem('cswatch.language', language);
        localStorage.setItem('theme', french ? 'light' : 'dark');
      },
      { language, french },
    );
    const anonymous = accountStatus(null);
    await page.route('**/api/config', (route) =>
      route.fulfill({ json: { ...memberConfig, registrations_enabled: false } }),
    );
    await page.route('**/api/auth/me', (route) => route.fulfill({ json: anonymous }));
    const returnTo = '/watch/private-review?t=128#round-3';
    await page.goto('/login?' + new URLSearchParams({ steam: 'registration-closed', returnTo }));
    const signIn = page.getByRole('button', {
      name: french ? 'Continuer avec Steam' : 'Continue with Steam',
      exact: true,
    });
    const registrationMessage = french
      ? 'Les inscriptions sont fermées. Utilisez un compte Steam déjà associé ou connectez-vous autrement.'
      : 'Registration is closed. Use an existing linked Steam account, or sign in another way.';
    await expect(page.getByRole('alert').filter({ hasText: registrationMessage })).toBeVisible();
    await expect(signIn).toHaveAccessibleDescription(registrationMessage);
    await page.route('**/api/auth/steam', (route) =>
      route.fulfill({ status: 403, json: { detail: 'Steam sign-in is disabled.' } }),
    );
    const retry = page.waitForRequest('**/api/auth/steam');
    await signIn.press('Enter');
    expect((await retry).postDataJSON()).toEqual({ return_to: returnTo });

    await page.route('**/api/auth/me', (route) =>
      route.fulfill({ json: accountStatus({ ...memberUser, identities: [] }) }),
    );
    await page.goto('/account/connections?steam=link-conflict');
    const connect = page.getByRole('button', {
      name: french ? 'Associer Steam' : 'Connect Steam',
      exact: true,
    });
    const linkMessage = french
      ? 'Ce compte Steam n’a pas pu être associé. Vérifiez le compte Steam que vous utilisez, puis réessayez.'
      : 'This Steam account could not be linked. Check which Steam account you’re using and try again.';
    await expect(page.getByRole('alert').filter({ hasText: linkMessage })).toBeVisible();
    await expect(connect).toHaveAccessibleDescription(linkMessage);
  });
}

test('an expired proof prompts for Steam verification and restores the connection notice on cancellation', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE) || Boolean(process.env.E2E_SETUP));
  await installMemberWorkspace(page);
  const account = accountStatus(memberUser);
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      json: {
        ...account,
        session: {
          ...account.session,
          proof_fresh: false,
          proof_at: Math.floor(Date.now() / 1000) - 600,
        },
      },
    }),
  );
  const cancelled = '/account/connections?steam=verification-cancelled&proofFor=steam';
  await page.route('**/api/auth/step-up/steam', (route) => {
    const request = route.request();
    expect(request.method()).toBe('POST');
    expect(request.headers()['x-csrf-token']).toBe(memberUser.csrf);
    expect(request.postDataJSON()).toEqual({ return_to: '/account/connections?proofFor=steam' });
    return route.fulfill({ json: { location: cancelled } });
  });

  await page.goto('/account/connections');
  await page.getByRole('button', { name: 'Verify Steam again', exact: true }).click();
  const proof = page.getByRole('dialog', { name: 'Confirm your identity' });
  await proof.getByRole('button', { name: 'Confirm with Steam', exact: true }).click();
  await expect(page).toHaveURL(
    /\/account\/connections\?steam=verification-cancelled&proofFor=steam$/,
  );
  await expect(page.getByRole('alert')).toHaveText(
    'Steam identity verification was cancelled. Try the action again.',
  );
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
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      json: accountStatus({
        ...memberUser,
        match_sources: { ...memberUser.match_sources, steam: saved },
      }),
    }),
  );
  await page.route('**/api/connections/steam/matches?*', (route) =>
    route.fulfill({
      json: {
        needs_codes: false,
        retry_at: 0,
        next: null,
        items: [
          { match_id: match, share_code: code, demos: [] },
          {
            match_id: '1234',
            share_code: code,
            demos: [{ id: 'member-design-0', status: 'ready' }],
          },
        ],
      },
    }),
  );
  await page.route('**/api/connections/steam/history', (route) => {
    if (route.request().method() === 'GET')
      return route.fulfill({ json: { available: true, configured: saved, needs_codes: false } });
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
  await page.getByRole('link', { name: 'View matches' }).click();
  await expect(page.getByRole('link', { name: 'Download in CS2' }).first()).toHaveAttribute(
    'href',
    /steam:\/\/rungame\/730\/.*\+csgo_download_match/,
  );
  await expect(page.getByRole('link', { name: 'Open Ready' })).toHaveAttribute(
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

test('connection setup names the exact server settings for administrators only', async ({
  page,
}) => {
  test.skip(Boolean(process.env.E2E_PRIVATE) || Boolean(process.env.E2E_SETUP));
  await installMemberWorkspace(page);
  let config = {
    ...memberConfig,
    steam_enabled: true,
    steam_discovery: false,
    faceit_enabled: false,
  };
  let admin = true;
  await page.route('**/api/config', (route) => route.fulfill({ json: config }));
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ json: accountStatus({ ...memberUser, role: admin ? 'admin' : 'member' }) }),
  );
  await page.route('**/api/connections/steam/history', (route) =>
    route.fulfill({
      json: { available: false, configured: false, needs_codes: false },
    }),
  );
  const open = async () => {
    await page.goto('/account/connections');
    await page.locator('summary').filter({ hasText: 'Steam match sync' }).click();
  };
  await open();
  await expect(page.getByText('STEAM_API_KEY')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Get a Steam Web API key' })).toBeVisible();
  await expect(page.getByText('FACEIT_ENABLED=true')).toBeVisible();
  await expect(page.getByText('game/csgo/replays')).toHaveCount(0);
  await expect(page.getByText('download FACEIT demos')).toHaveCount(0);

  admin = false;
  config = { ...config, faceit_enabled: true };
  await open();
  await expect(page.getByText('everything needed for automatic Steam match sync')).toBeVisible();
  await expect(page.getByText('everything needed for FACEIT matches')).toBeVisible();
  await expect(
    page.getByText('Verify the FACEIT account linked to your Steam account.', { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Verify FACEIT' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Verify and save codes' })).toHaveCount(0);
  await expect(page.getByText('administrator', { exact: false })).toHaveCount(0);
  await expect(page.getByText('STEAM_API_KEY')).toHaveCount(0);
  await expect(page.getByText('FACEIT_ENABLED')).toHaveCount(0);

  admin = true;
  config = { ...config, steam_enabled: false, faceit_enabled: true };
  await page.goto('/account/connections');
  await expect(page.getByText('STEAM_ENABLED=true')).toBeVisible();
  await expect(page.getByText('FACEIT_API_KEY')).toBeVisible();
});
