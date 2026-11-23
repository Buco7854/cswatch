import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const repo = resolve(process.argv[2] || '.');
const base = new URL(process.argv[3] || process.env.E2E_BASE_URL || 'http://localhost:4480');
const captures = resolve(process.argv[4] || join(repo, '.design/captures'));
const require = createRequire(join(repo, 'frontend/package.json'));
const { chromium, expect } = require('@playwright/test');
await mkdir(captures, { recursive: true });

const sizes = [
  { width: 1440, height: 960 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
];
const flags = {
  public_access: true,
  registrations_enabled: true,
  guest_uploads_enabled: true,
  auto_official_maps_enabled: false,
  steam_enabled: true,
  faceit_enabled: false,
  transcription_enabled: false,
};
const longName = 'reviewer-at-maximum-length-00001-1e2f3a4b5c6d7e8f';
const fixtureId = '7'.repeat(32);
const actorId = '6'.repeat(32);
const time = 1795136600;
const reviewUser = {
  id: fixtureId,
  username: longName,
  display_name: 'Camille Tremblay — atelier de révision et analyse des matchs',
  role: 'member',
  created_at: time,
};
const editor = {
  id: actorId,
  username: 'qa_operator_example',
  display_name: 'QA operator',
  has_password: true,
  role: 'admin',
  csrf: 'synthetic-interface-token',
  identities: [{ provider: 'steam', subject: '76561190000000000' }],
};
const sessions = [
  {
    id: '5'.repeat(32),
    device: 'Chrome · Linux',
    address: '192.0.2.0/24',
    stage: 'full',
    current: true,
    created_at: time - 932,
    last_used_at: time,
    expires_at: time + 4183,
  },
  {
    id: '8'.repeat(32),
    device: 'Safari · iOS',
    address: '2001:db8:5d6c:1e02::/64',
    stage: 'full',
    current: false,
    created_at: time - 420932,
    last_used_at: time - 871,
    expires_at: time + 19032,
  },
];
const adminSettings = {
  flags: Object.fromEntries(
    Object.entries(flags).map(([key, value]) => [key, { value, locked: key === 'public_access' }]),
  ),
  queue: [
    { status: 'ready', count: 14 },
    { status: 'queued', count: 2 },
  ],
  mfa_required_roles: { value: ['admin'], locked: false },
  mapReadiness: {
    enabled: false,
    worker: { available: false },
    inventory: { status: 'unavailable', mapCount: 0 },
    catalog: { status: 'empty', entries: 0 },
  },
};
const events = [
  {
    id: 4,
    actor: actorId,
    target: fixtureId,
    action: 'admin.user.change_role',
    outcome: 'success',
    address: '192.0.2.184',
    created_at: time,
  },
  {
    id: 3,
    actor: actorId,
    target: 'map.pack',
    action: 'map.removal',
    outcome: 'unknown',
    address: '192.0.2.184',
    created_at: time - 22,
    intent_id: 2,
  },
  {
    id: 2,
    actor: actorId,
    target: 'map.pack',
    action: 'map.removal',
    outcome: 'authorized',
    address: '192.0.2.184',
    created_at: time - 25,
  },
  {
    id: 1,
    actor: null,
    target: null,
    action: 'password.sign_in',
    outcome: 'denied',
    address: '2001:db8:5d6c:1e02:1435:849f:0063:02fe',
    created_at: time - 62,
  },
];
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const written = [];
try {
  for (const language of ['en', 'fr']) {
    const catalog = JSON.parse(
      await readFile(join(repo, 'frontend/src/locales', language + '.json'), 'utf8'),
    );
    const t = (key) => catalog[key] || key;
    for (const theme of ['dark', 'light'])
      for (const viewport of sizes) {
        const prefix = 'auth-' + language + '-' + theme + '-' + viewport.width + '-';
        const context = await browser.newContext({
          baseURL: base.href,
          viewport,
          locale: language === 'en' ? 'en-GB' : 'fr-FR',
          reducedMotion: 'reduce',
          hasTouch: viewport.width < 1000,
          isMobile: viewport.width === 390,
        });
        try {
          await context.addInitScript(
            ({ language, theme }) => {
              localStorage.setItem('cswatch.language', language);
              localStorage.setItem('theme', theme);
            },
            { language, theme },
          );
          const page = await context.newPage();
          const errors = [];
          page.on('pageerror', (error) => errors.push(error.message));
          let stage = 'full';
          let securityState = 'ready';
          const finishSecurityReads = [];
          let adminAccess = true;
          await context.route('**/*', async (route) => {
            const url = new URL(route.request().url());
            if (url.origin !== base.origin) return route.abort();
            const json = (body, status = 200) => route.fulfill({ json: body, status });
            switch (url.pathname) {
              case '/api/auth/me':
                return json({
                  user: stage === 'full' ? editor : null,
                  guest_session: null,
                  session: {
                    stage,
                    csrf: 'synthetic-interface-token',
                    proof_fresh: false,
                    proof_at: stage === 'full' ? time : null,
                    proof_kind: 'password',
                    expires_at: time + 48000000,
                    factors:
                      stage === 'full'
                        ? { passkey: true, totp: true, recovery: true }
                        : { passkey: false, totp: false, recovery: false },
                    display_name: stage === 'enroll' ? 'QA operator' : null,
                    username: stage === 'enroll' ? longName : null,
                  },
                });
              case '/api/config':
                return json({
                  ...flags,
                  admin_access: adminAccess && stage === 'full',
                  setup_required: false,
                  guest_retention_hours: 24,
                  max_upload_mb: 500,
                  retention_days: 30,
                  steam_discovery: false,
                  faceit_configured: false,
                  faceit_downloads: false,
                  transcription_configured: false,
                });
              case '/api/auth/recover/status': return json({claim_id:null});
              case '/api/auth/security':
                if (securityState === 'hold') {
                  await new Promise((resolve) => {
                    finishSecurityReads.push(resolve);
                  });
                  if (securityState === 'error')
                    return json({ detail: 'Connection lost. Try again.' }, 503);
                }
                return json({
                  passkeys:
                    stage === 'full'
                      ? [
                          {
                            id: 'safe-display-only-key',
                            name: 'Clé du poste de travail · navigateur principal, salle de révision',
                            device_type: 'multiDevice',
                            backed_up: true,
                            created_at: time,
                            last_used_at: time + 900,
                          },
                        ]
                      : [],
                  totp: stage === 'full' ? { created_at: time } : null,
                  recovery_codes_remaining: stage === 'full' ? 8 : 0,
                });
              case '/api/auth/sessions':
                return json({ sessions });
              case '/api/admin':
                return json(adminSettings);
              case '/api/admin/maps':
                return json({ maps: [], workerAvailable: false });
              case '/api/admin/users': {
                const users = url.searchParams.get('q') === 'no-such-reviewer' ? [] : [reviewUser];
                return json({ users, total: users.length });
              }
              case '/api/admin/users/' + fixtureId:
                return json({
                  user: { ...reviewUser, last_active: time + 10000 },
                  identities: [{ provider: 'steam', subject: '76561190000000000' }],
                  factors: { passkeys: 2, totp: true, recovery_codes: 7 },
                  sessions,
                  storage: { demos: 14, bytes: 342982713 },
                });
              case '/api/admin/audit': {
                const outcome = url.searchParams.get('outcome');
                const selected = outcome
                  ? events.filter((event) => event.outcome === outcome)
                  : events;
                return json({ events: selected, total: selected.length });
              }
              case '/api/demos':
                return json({ demos: [], total: 0 });
              default:
                if (url.pathname.startsWith('/api/'))
                  throw new Error('Unexpected API path ' + url.pathname);
                return route.continue();
            }
          });

          async function capture(name) {
            await page.evaluate(() => document.fonts.ready.then(() => {}));
            assert.equal(await page.locator('html').getAttribute('lang'), language);
            assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
            assert.equal(
              await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches),
              true,
            );
            const { width, content } = await page.evaluate(() => ({
              width: document.documentElement.clientWidth,
              content: document.documentElement.scrollWidth,
            }));
            assert.ok(
              content <= width + 1,
              prefix + name + ' overflows by ' + (content - width) + ' CSS px',
            );
            assert.deepEqual(errors, []);
            const path = join(captures, prefix + name + '.png');
            await page.screenshot({ path, fullPage: true, animations: 'disabled' });
            written.push(path);
          }

          const pressure = viewport.width === 390 && language === 'fr';
          if (pressure) securityState = 'hold';
          await page.goto('/account');
          if (pressure) {
            await expect(
              page.getByRole('status').filter({ hasText: t('Loading account security…') }),
            ).toBeVisible();
            await capture('account-loading');
            securityState = 'error';
            assert.ok(finishSecurityReads.length);
            for (const finishRead of finishSecurityReads) finishRead();
            await expect(
              page.getByRole('alert').filter({ hasText: t('Connection lost. Try again.') }),
            ).toBeVisible();
            await capture('account-error');
            securityState = 'ready';
            await page.getByRole('button', { name: t('Try again'), exact: true }).click();
          }
          await expect(
            page.getByRole('heading', { name: t('Passkeys'), exact: true }),
          ).toBeVisible();
          await capture('account');
          {
            if (pressure) {
              await page.goto('/account');
              await expect(page.getByRole('heading', { name: t('Passkeys'), exact: true })).toBeVisible();
            }
            await page.keyboard.press('Tab');
            await expect(page.locator('.skip-link')).toBeFocused();
            const password = page.getByLabel(t('New password'), { exact: true });
            for (let tab = 0; tab < 80; tab++) {
              await page.keyboard.press('Tab');
              if (await password.evaluate((input) => input === document.activeElement)) break;
            }
            await expect(password).toBeFocused();
            await page.keyboard.type('Synthetic-keyboard-check-password');
            await page.keyboard.press('Enter');
            const dialog = page.getByRole('dialog', { name: t('Confirm your identity') });
            await expect(dialog).toBeVisible();
            await capture('step-up');
            await expect(dialog.getByRole('heading')).toBeFocused();
            await page.keyboard.press('Tab');
            await expect(dialog.getByRole('button', { name: t('Use a passkey') })).toBeFocused();
            await page.keyboard.press('Escape');
            await expect(dialog).toHaveCount(0);
            await expect(password).toBeFocused();
            await password.clear();
          }
          const sessionsTab=page.getByRole('link',{name:t('Sessions'),exact:true});
          if(viewport.width===390) await sessionsTab.tap(); else await sessionsTab.click();
          await expect(page.getByText(t('This session'), { exact: true })).toBeVisible();
          await capture('sessions');

          await page.locator('.workspace-bar .account-button').click();
          await page.getByRole('menuitem', { name: t('Administration'), exact: true }).click();
          await expect(
            page.getByRole('heading', { name: t('Required second factor'), exact: true }),
          ).toBeVisible();
          await capture('admin-policy');

          await page.getByRole('link', { name: t('Users'), exact: true }).click();
          await expect(page.getByRole('link', { name: new RegExp(longName) })).toBeVisible();
          const roleBox=await page.getByRole('combobox',{name:t('Role'),exact:true}).boundingBox();
          const searchBox=await page.getByRole('button',{name:t('Search'),exact:true}).boundingBox();
          if(roleBox && searchBox && searchBox.x >= roleBox.x+roleBox.width)
            assert.ok(Math.abs(roleBox.y+roleBox.height-searchBox.y-searchBox.height)<=2, 'Search aligns with its controls');
          await capture('admin-users');

          await page.getByRole('link', { name: new RegExp(longName) }).click();
          await expect(page.getByRole('heading', { name: longName, exact: true })).toBeFocused();
          const [badge, detail]=await Promise.all([page.locator('.admin-user-heading .member-role').boundingBox(),page.locator('.admin-user-detail').boundingBox()]);
          assert.ok(badge && detail && badge.x+badge.width <= detail.x+detail.width+1,'The role fits inside the account detail width');
          await capture('admin-user-detail');
          if (pressure) {
            await page.getByRole('link', { name: t('Back to users'), exact: true }).click();
            await page.getByRole('searchbox').fill('no-such-reviewer');
            await page.getByRole('button', { name: t('Search'), exact: true }).click();
            await expect(
              page.getByRole('status').filter({ hasText: t('No accounts match these filters.') }),
            ).toBeVisible();
            await capture('admin-users-empty');
          }

          await page.getByRole('link', { name: t('Security events'), exact: true }).click();
          await expect(page.getByText('password.sign_in', { exact: true })).toBeVisible();
          await capture('admin-audit');
          if (pressure) {
            await page.getByRole('combobox', {name:t('Outcome'),exact:true}).selectOption('unknown');
            await page.getByRole('button', { name: t('Apply filters'), exact: true }).click();
            await expect(page.locator('.audit-event')).toHaveCount(1);
            await expect(
              page.locator('.audit-event').getByText(t('Outcome unknown'), { exact: true }),
            ).toBeVisible();
          }

          stage = 'enroll';
          adminAccess = false;
          await page.goto('/account');
          await expect(
            page.getByRole('heading', { name: t('Secure your account'), exact: true }),
          ).toBeFocused();
          await expect(
            page.getByRole('button', { name: t('Set up authenticator'), exact: true }),
          ).toBeVisible();
          await expect(page.getByRole('link', { name: t('Sessions'), exact: true })).toHaveCount(0);
          await capture('enroll');
          stage='anonymous';
          for(const [url,heading,screen] of [['/login','Sign in','login'],['/register','Create account','register'],['/recover','Recover your account','recover']]){
            await page.goto(url);
            await expect(page.getByRole('heading',{name:t(heading),exact:true})).toBeVisible();
            if(screen==='recover') await expect(page.locator('form')).toBeVisible();
            await capture(screen);
          }
          stage='full';
          await page.goto('/library?admin=network');
          await expect(page.getByRole('alert').filter({hasText:t('Administration is unavailable from this network.')})).toBeVisible();
          await capture('admin-denied');
          console.log(prefix.slice(0, -1) + ' verified');
        } finally {
          await context.close();
        }
      }
  }
} finally {
  await browser.close();
}
assert.equal(written.length, sizes.length * 2 * 2 * 12 + 6);
await writeFile(join(captures,'screenshots.txt'),written.map(path=>path.split('/').at(-1)).join('\n')+'\n');
console.log(written.length + ' screenshots in ' + captures);
