import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { installMemberWorkspace, memberUser } from './fixtures/member-workspace';

const profiles = [
  { language: 'en', theme: 'dark', width: 1440, height: 900 },
  { language: 'fr', theme: 'light', width: 390, height: 844 },
  { language: 'en', theme: 'light', width: 1440, height: 900 },
  { language: 'fr', theme: 'dark', width: 390, height: 844 },
];
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
for (const [index, profile] of profiles.entries()) {
  test(`official provider artwork remains local, unmodified and readable in ${profile.language} ${profile.theme} ${profile.width}`, async ({
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
    const signIn = page.getByRole('link', {
      name: profile.language === 'fr' ? 'Continuer avec Steam' : 'Continue with Steam',
      exact: true,
    });
    await expect(signIn).toHaveAttribute(
      'href',
      '/api/auth/steam?returnTo=%2Fwatch%2Fprovider-fixture',
    );
    const steam = signIn.locator('img');
    await expect(steam).toBeVisible();
    await expect
      .poll(() => steam.evaluate((image: HTMLImageElement) => image.naturalWidth))
      .toBe(180);
    expect(await steam.evaluate((image) => getComputedStyle(image).filter)).toBe('none');
    const steamBounds = (await steam.boundingBox())!;
    expect(steamBounds.width).toBe(180);
    expect(steamBounds.height).toBe(35);
    expect(
      sha(await (await page.request.get((await steam.getAttribute('src')) as string)).body()),
    ).toBe('bbd5d8ac0c737fccca946009a5eb7cb33605fca2bb5c259807a117f9f2cb193f');
    await expect(page.locator('.provider-logo-faceit')).toHaveCount(0);
    await expect(page.locator('a[href="/licenses/provider-brands.txt"]')).toBeVisible();
    await capture('login');

    await page.route('**/api/auth/me', (route) => route.fulfill({ json: { user: memberUser } }));
    await page.goto('/account/connections');
    await expect(page.getByRole('heading', { name: 'FACEIT', exact: true })).toBeVisible();
    const faceit = page.locator(`.provider-logo-on-${profile.theme}`);
    await expect(faceit).toBeVisible();
    await expect
      .poll(() => faceit.evaluate((image: HTMLImageElement) => image.naturalWidth))
      .toBe(833);
    const path = (await faceit.getAttribute('src'))!;
    expect(new URL(path).pathname).toMatch(
      profile.theme === 'light'
        ? /^\/assets\/faceit-on-light-[A-Za-z0-9_-]+\.png$/
        : /^\/assets\/faceit-on-dark-[A-Za-z0-9_-]+\.png$/,
    );
    expect(sha(await (await page.request.get(path)).body())).toBe(
      profile.theme === 'light'
        ? 'c7fc176a806a904a0d079ee0c113a9cf2b1d297b7a3f64798276c5a7dcb99175'
        : 'eeedf9d8bd01a1eb450f33bf5c8d307ff7e8a83b05af64271d9938571aaf9909',
    );
    await expect(page.locator('a.provider-steam-link')).toHaveAttribute(
      'href',
      '/api/auth/steam?returnTo=%2Faccount%2Fconnections',
    );
    const notice = await (await page.request.get('/licenses/provider-brands.txt')).text();
    expect(notice).toContain('©2026 Valve Corporation.');
    expect(notice).toContain('not offered under the repository');
    if (index < 2) await capture('connections');
    else
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    expect(images.every((url) => new URL(url).origin === new URL(page.url()).origin)).toBe(true);
    expect(await page.evaluate(() => (window as any).__brandCSP)).toEqual([]);
    expect(errors).toEqual([]);
  });
}
