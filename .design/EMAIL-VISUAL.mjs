import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const origin = new URL(process.argv[2] || 'http://127.0.0.1:4493').origin;
assert.equal(origin, 'http://127.0.0.1:4493');
const captures = resolve(process.argv[3] || join(repo, '.design/email-verification'));
const require = createRequire(join(repo, 'frontend/package.json'));
const { chromium, expect } = require('@playwright/test');
const config = await fetch(origin + '/api/config').then((response) => response.json());
assert.equal(config.email_delivery_enabled, true);
assert.equal(config.setup_required, false);
await mkdir(captures, { recursive: true });

const sizes = [
  { width: 1440, height: 960 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
];
const now = Math.floor(Date.now() / 1000);
const member = {
  id: '7'.repeat(32),
  username: 'camille-reviewer',
  display_name: 'Camille Tremblay',
  email: 'camille@example.test',
  email_verified_at: null,
  profile_required: false,
  email_verification_required: false,
  has_password: true,
  role: 'member',
  csrf: 'synthetic-email-design-session',
  identities: [],
  created_at: now - 86400,
};
const operator = {
  ...member,
  id: '6'.repeat(32),
  username: 'email-review-operator',
  display_name: 'Review Operator',
  email: 'operator@example.test',
  email_verified_at: now - 3600,
  role: 'admin',
};
const steam = { provider: 'steam', subject: '76561190000000000' };
const longAddress = 'c'.repeat(64) + '@' + 'd'.repeat(50) + '.example.test';
const errorAddress = 'unavailable@example.test';
const fakeCode = 'e'.repeat(64);
const allFlags = {
  public_access: true,
  registrations_enabled: true,
  guest_uploads_enabled: false,
  steam_enabled: true,
  faceit_enabled: false,
  auto_official_maps_enabled: false,
  transcription_enabled: false,
  email_delivery_enabled: true,
};

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-background-networking',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
  ],
});
const manifest = {
  origin,
  browser: `Headless Chromium ${browser.version()}`,
  os: `${process.platform} ${process.arch}`,
  node: process.version,
  fixture: 'Production frontend and backend shell with synthetic, same-origin account and mail API responses.',
  preference: 'Reduced motion on, mouse and keyboard at desktop, touch emulation at tablet and phone.',
  captures: [],
};
try {
  for (const language of ['en', 'fr']) {
    const catalog = JSON.parse(await readFile(join(repo, 'frontend/src/locales', `${language}.json`), 'utf8'));
    const t = (key) => {
      assert.ok(catalog[key], `missing ${language} message ${key}`);
      return catalog[key];
    };
    for (const theme of ['dark', 'light']) {
      for (const viewport of sizes) {
        const touch = viewport.width !== 1440;
        const context = await browser.newContext({
          baseURL: origin,
          viewport,
          locale: language === 'fr' ? 'fr-FR' : 'en-GB',
          reducedMotion: 'reduce',
          serviceWorkers: 'block',
          hasTouch: touch,
          isMobile: viewport.width === 390,
        });
        try {
          await context.addInitScript(({ language, theme }) => {
            localStorage.setItem('cswatch.language', language);
            localStorage.setItem('theme', theme);
          }, { language, theme });
          const page = await context.newPage();
          const errors = [];
          const external = [];
          page.on('pageerror', (error) => errors.push(error.message));
          let user = null;
          let emailEnabled = true;
          let mailConfigured = true;
          let setupRequired = false;
          let target = { ...member, last_active: now - 120 };
          let confirmationError = false;
          let verificationWrites = 0;
          let resetWrites = 0;
          await context.route('**/*', async (route) => {
            const url = new URL(route.request().url());
            if (url.origin !== origin) {
              external.push(url.hostname);
              return route.abort('blockedbyclient');
            }
            const json = (body, status = 200) => route.fulfill({ json: body, status });
            switch (url.pathname) {
              case '/api/auth/me':
                return json({
                  user,
                  guest_session: null,
                  session: {
                    stage: user ? 'full' : 'anonymous',
                    csrf: user?.csrf || 'synthetic-email-design-anonymous-csrf',
                    anonymous_id: user ? null : 'synthetic-email-design-anonymous',
                    proof_fresh: Boolean(user),
                    proof_at: user ? now : null,
                    proof_kind: user ? 'password' : null,
                    expires_at: now + 3600,
                    factors: user ? { passkey: false, totp: false, recovery: false } : null,
                    display_name: null,
                    username: null,
                  },
                });
              case '/api/config':
                return json({
                  ...config,
                  ...allFlags,
                  setup_required: setupRequired,
                  admin_access: user?.role === 'admin',
                  email_delivery_enabled: emailEnabled,
                });
              case '/api/auth/security':
                return json({ passkeys: [], totp: null, recovery_codes_remaining: 0 });
              case '/api/auth/recover/status':
                return json({ claim_id: null });
              case '/api/auth/recover/request':
                resetWrites++;
                return json({ ok: true });
              case '/api/auth/email/verify':
                verificationWrites++;
                if (confirmationError) {
                  return json({ detail: 'This verification link has expired or was already used.' }, 400);
                }
                user = { ...user, email_verified_at: now, email_verification_required: false };
                return json({ ok: true });
              case '/api/auth/profile':
                return json({ detail: 'That email address is unavailable.' }, 409);
              case '/api/admin':
                return json({
                  flags: Object.fromEntries(Object.entries({ ...allFlags, email_delivery_enabled: emailEnabled })
                    .map(([name, value]) => [name, { value, locked: name === 'public_access' }])),
                  mfa_required_roles: { value: ['admin'], locked: false },
                  email_delivery_configured: mailConfigured,
                  mapReadiness: {
                    enabled: false,
                    inventory: { status: 'unavailable', mapCount: 0 },
                    catalog: { status: 'empty', entries: 0 },
                    worker: { available: false },
                  },
                  queue: [],
                });
              case '/api/admin/maps':
                return json({ maps: [], workerAvailable: false });
              case `/api/admin/users/${member.id}`:
                return json({
                  user: target,
                  identities: [steam],
                  factors: { passkeys: 0, totp: false, recovery_codes: 0 },
                  sessions: [],
                  storage: { demos: 0, bytes: 0 },
                });
              case '/api/demos':
                return json({ demos: [], total: 0 });
              case '/admin':
                if (route.request().isNavigationRequest()) {
                  const shell = await route.fetch({ url: new URL('/login', origin).href, maxRedirects: 0 });
                  return route.fulfill({ response: shell });
                }
                break;
              default:
                if (route.request().method() !== 'GET') {
                  return json({ detail: 'Method not available in rendered QA.' }, 405);
                }
            }
            return route.continue();
          });

          const heading = (name) => page.getByRole('heading', { name: t(name), exact: true });
          const button = (name) => page.getByRole('button', { name: t(name), exact: true });
          const email = () => page.getByRole('textbox', { name: t('Email address'), exact: true });
          async function activate(locator) {
            if (touch) await locator.tap();
            else await locator.press('Enter');
          }
          async function capture(state, label, primary) {
            await page.evaluate(() => document.fonts.ready.then(() => {}));
            await expect(page.locator('html')).toHaveAttribute('lang', language);
            await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
            const metrics = await page.evaluate(() => ({
              width: document.documentElement.clientWidth,
              scrollWidth: document.documentElement.scrollWidth,
              reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
            }));
            assert.equal(metrics.width, viewport.width);
            assert.ok(metrics.scrollWidth <= metrics.width + 1, `${state} overflows ${viewport.width}px in ${language} ${theme}`);
            assert.equal(metrics.reducedMotion, true);
            assert.deepEqual(errors, []);
            assert.deepEqual(external, []);
            let actionHeight;
            if (primary) {
              await expect(primary).toBeVisible();
              actionHeight = (await primary.boundingBox()).height;
              assert.ok(actionHeight >= 24, `${state} primary target is ${actionHeight}px`);
            }
            const file = `${language}-${theme}-${viewport.width}-${state}.png`;
            await page.screenshot({ path: join(captures, file), fullPage: true, animations: 'disabled' });
            manifest.captures.push({ file, label, state, language, theme, ...viewport, touch, actionHeight });
          }

          await page.goto('/register');
          await expect(heading('Create account')).toBeVisible();
          await expect(email()).toBeVisible();
          await capture('registration', 'Local registration', button('Create account'));

          setupRequired = true;
          await page.goto('/setup');
          await expect(heading('Set up cswatch')).toBeVisible();
          await expect(email()).toBeVisible();
          await capture('setup', 'First administrator setup', button('Create administrator'));
          setupRequired = false;

          user = { ...member, profile_required: true, has_password: false, email: null, identities: [steam] };
          await page.goto('/library');
          await expect(heading('Complete your profile')).toBeVisible();
          await expect(email()).toBeVisible();
          await capture('steam-profile', 'Steam profile completion', button('Save profile'));

          const pressure = language === 'fr' && viewport.width === 390;
          user = { ...member, email_verification_required: true, email: pressure ? longAddress : member.email };
          await page.goto('/library');
          await expect(heading('Verify your email')).toBeVisible();
          await expect(page.getByText(user.email, { exact: true })).toBeVisible();
          await capture('verification-gate', `Verification required${pressure ? ' with a long address' : ''}`, button('Send verification email'));

          await page.goto('/verify-email#' + fakeCode);
          const confirm = button('Confirm email');
          await expect(confirm).toBeVisible();
          assert.equal(new URL(page.url()).hash, '');
          assert.equal(verificationWrites, 0);
          await capture('verification-link', 'Explicit email confirmation', confirm);
          if (pressure) {
            confirmationError = true;
            await activate(confirm);
            await expect(page.getByRole('alert')).toHaveText(t('This verification link has expired or was already used.'));
            await capture('verification-expired', 'Expired email verification link with recovery action', confirm);
            confirmationError = false;
            await activate(confirm);
            await expect(heading('Email verified')).toBeVisible();
            await capture(
              'verification-confirmed',
              'Verification completion with a long address',
              page.getByRole('link', { name: t('Continue'), exact: true }),
            );
          }

          user = null;
          await page.goto('/recover');
          await expect(heading('Recover your account')).toBeVisible();
          await expect(page.getByLabel(t('Password reset code'), { exact: true })).toBeVisible();
          const emailReset = button('Email a reset link');
          await capture('recovery-enabled', 'Email and manual password recovery', emailReset);
          if (pressure) {
            await email().fill(errorAddress);
            await activate(emailReset);
            await expect(page.getByRole('status')).toHaveText(t('If this address is verified on an account here, check its inbox for a reset link.'));
            assert.equal(resetWrites, 1);
            await capture('recovery-requested', 'Generic email reset request acknowledgement', emailReset);
          }
          emailEnabled = false;
          await page.goto('/recover');
          await expect(heading('Recover your account')).toBeVisible();
          await expect(page.getByLabel(t('Password reset code'), { exact: true })).toBeVisible();
          await expect(emailReset).toHaveCount(0);
          await capture('recovery-disabled', 'Manual recovery when SMTP is off', button('Continue'));
          emailEnabled = true;

          user = { ...member, email: pressure ? longAddress : member.email, email_verified_at: now - 600 };
          await page.goto('/account');
          await expect(heading('Email address')).toBeVisible();
          await expect(page.getByText(t('Verified email address'), { exact: true })).toBeVisible();
          await capture('account-email', `Saved account email${pressure ? ' with a long address' : ''}`, button('Change email address'));
          await activate(button('Change email address'));
          await expect(email()).toBeFocused();
          await capture('account-edit', 'Email edit open with input focus', button('Save email address'));
          if (pressure) {
            await email().fill(errorAddress);
            await activate(button('Save email address'));
            await expect(page.getByRole('alert')).toHaveText(t('That email address is unavailable.'));
            await capture('account-error', 'Recoverable error changing an account email address', button('Save email address'));
          }

          user = operator;
          emailEnabled = false;
          mailConfigured = false;
          await page.goto('/admin');
          await expect(page.getByText(t('Configure SMTP on the server to enable verification and password reset emails.'))).toBeVisible();
          await capture('admin-mail-off', 'Administration settings without SMTP configured');
          mailConfigured = true;
          emailEnabled = true;
          target = { ...target, email: pressure ? longAddress : member.email };
          await page.goto(`/admin?section=users&user=${member.id}`);
          await expect(page.getByRole('heading', { name: target.username, exact: true })).toBeVisible();
          await expect(email()).toHaveValue(target.email);
          await capture('admin-email', `Administrator account email field${pressure ? ' with a long address' : ''}`, button('Change email address'));
          if (pressure) {
            await email().fill(longAddress.replace(/^c/, 'a'));
            await activate(button('Change email address'));
            const dialog = page.getByRole('dialog');
            await expect(dialog).toBeVisible();
            await capture('admin-confirmation', 'Administrator confirmation for a long replacement email', dialog.getByRole('button', { name: t('Change email address'), exact: true }));
            await page.keyboard.press('Escape');
            await expect(dialog).toHaveCount(0);
            await expect(button('Change email address')).toBeFocused();
          }
          console.log(`${language} ${theme} ${viewport.width} email screens verified`);
        } finally {
          await context.close();
        }
      }
    }
  }
} finally {
  await browser.close();
  await writeFile(join(captures, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(join(captures, 'screenshots.txt'), manifest.captures.map(({ file }) => file).join('\n') + '\n');
}
assert.equal(manifest.captures.length, 142);
console.log(`${manifest.captures.length} labeled screenshots in ${captures}`);
