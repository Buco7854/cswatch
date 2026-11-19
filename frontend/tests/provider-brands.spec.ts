import { expect, test, type Locator } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { installMemberWorkspace, memberUser } from './fixtures/member-workspace';

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
    const steamLink = page.locator('a.provider-steam-link');
    await expect(steamLink).toHaveAttribute(
      'href',
      '/api/auth/steam?returnTo=%2Faccount%2Fconnections',
    );
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
    await capture('connections');
    expect(images.every((url) => new URL(url).origin === new URL(page.url()).origin)).toBe(true);
    expect(images.some((url) => /steam-openid|faceit-on-(light|dark)/.test(url))).toBe(false);
    expect(await page.evaluate(() => (window as any).__brandCSP)).toEqual([]);
    expect(errors).toEqual([]);
  });
}
