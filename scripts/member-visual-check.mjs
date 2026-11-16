/** Disposable authenticated UI fixtures; never reads or changes preview/production accounts. */
import { chromium } from '../frontend/node_modules/playwright/index.mjs';
import { createApp } from '../backend/dist/server.js';
import { loadConfig } from '../backend/dist/config.js';
import { Store, now } from '../backend/dist/db.js';
import { digest, COOKIE } from '../backend/dist/security.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
process.env.LOG_LEVEL = 'warn';
const root = mkdtempSync(join(tmpdir(), 'cswatch-member-qa-'));
const config = loadConfig({
  APP_URL: 'http://localhost:4176',
  PORT: '4176',
  COOKIE_SECURE: 'false',
  DATA_DIR: root,
  FRONTEND_DIR: resolve('frontend/dist'),
  STEAM_ENABLED: 'true',
  FACEIT_ENABLED: 'true',
});
const db = new Store(root),
  session = 'disposable-member-visual-session';
db.run(
  'INSERT INTO users VALUES(?,?,?,?,?)',
  'visual-reviewer',
  'reviewer_with_a_long_handle',
  null,
  1,
  now(),
);
db.run(
  'INSERT INTO sessions VALUES(?,?,?,?)',
  digest(session),
  'visual-reviewer',
  'visual-csrf',
  now() + 3600,
);
for (const [i, status] of ['ready', 'queued', 'processing', 'failed'].entries())
  db.run(
    'INSERT INTO demos(id,owner_id,name,source,status,size,created_at,public,map,duration,rounds,error) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    `qa-demo-${i}`,
    'visual-reviewer',
    i === 0 ? 'mirage_team_review_with_a_very_long_file_name_2026.dem' : 'review-' + i + '.dem',
    'upload',
    status,
    1024 * 1024,
    now() - i * 86400,
    0,
    'de_mirage',
    900,
    10,
    status === 'failed'
      ? 'Demo could not be parsed within the processing limits. It may be incomplete, unsupported, or too large.'
      : null,
  );
const app = await createApp(config, db);
await app.listen({ port: 4176, host: '127.0.0.1' });
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'],
});
const output = process.env.MEMBER_QA_OUT || '.design/member-qa';
mkdirSync(output, { recursive: true });
const report = [];
try {
  for (const lang of process.env.MEMBER_QA_LANGUAGE
    ? [process.env.MEMBER_QA_LANGUAGE]
    : ['en', 'fr'])
    for (const theme of process.env.MEMBER_QA_THEME
      ? [process.env.MEMBER_QA_THEME]
      : ['dark', 'light']) {
      const context = await browser.newContext({
        locale: lang === 'fr' ? 'fr-FR' : 'en-GB',
        reducedMotion: 'reduce',
      });
      await context.addCookies([{ name: COOKIE, value: session, url: 'http://localhost:4176' }]);
      await context.addInitScript(
        ({ lang, theme }) => {
          localStorage.setItem('cswatch.language', lang);
          localStorage.setItem('theme', theme);
        },
        { lang, theme },
      );
      const page = await context.newPage();
      page.setDefaultTimeout(7000);
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const inspect = async (kind, width) => {
        const metrics = await page.evaluate(() => ({
          overflow: document.documentElement.scrollWidth > innerWidth,
          dialogOverflow: [...document.querySelectorAll('dialog[open]')].some(
            (d) => d.scrollWidth > d.clientWidth + 2,
          ),
          title: document.querySelector('h1')?.textContent,
          oversizedRows: [...document.querySelectorAll('.demo-row:not(.table-head)')].filter(
            (el) => el.getBoundingClientRect().height > 120,
          ).length,
          misSizedSwitches: [...document.querySelectorAll('input[role=switch]')].filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && (r.height < 18 || r.height > 24);
          }).length,
          viewerFit:
            !document.querySelector('.viewer-frame') ||
            Math.abs(
              document.querySelector('.viewer-frame').getBoundingClientRect().height - innerHeight,
            ) < 2,
          dockVisible:
            !document.querySelector('.viewer-dock') ||
            document.querySelector('.viewer-dock').getBoundingClientRect().bottom <= innerHeight,
          offscreenControls: [
            ...document.querySelectorAll(
              'button,input:not([hidden]),select,[role=menu],[role=listbox]',
            ),
          ]
            .filter((el) => {
              if (el.closest('details:not([open])') && !el.closest('summary')) return false;
              if (!el.checkVisibility()) return false;
              // These named rails intentionally scroll horizontally; validate their
              // containing region below, not each offscreen, keyboard-reachable item.
              if (el.closest('.round-strip')) return false;
              const r = el.getBoundingClientRect();
              return r.width > 0 && r.height > 0 && (r.right > innerWidth + 1 || r.left < -1);
            })
            .map((el) => el.getAttribute('aria-label') || el.textContent?.slice(0, 45)),
        }));
        const railOverflow = await page.locator('.round-strip').evaluateAll((rails) =>
          rails.some((rail) => {
            if (!rail.checkVisibility()) return false;
            const bounds = rail.getBoundingClientRect();
            return bounds.left < -1 || bounds.right > innerWidth + 1;
          }),
        );
        metrics.overflow ||= railOverflow;
        report.push({ lang, theme, kind, width, ...metrics, errors: [...errors] });
        if ([1440, 390].includes(width))
          await page.screenshot({
            path: `${output}/${kind}-${lang}-${theme}-${width}.png`,
            fullPage: true,
          });
      };
      for (const width of [1440, 768, 390, 320, 1920, 844]) {
        await page.setViewportSize({
          width,
          height: width === 844 ? 390 : width === 768 ? 1024 : width <= 390 ? 844 : 900,
        });
        for (const [kind, path] of [
          ['library', '/library'],
          ['connections', '/connections'],
          ['account', '/account'],
          ['admin', '/admin'],
          ['viewer', '/watch/sample'],
        ]) {
          await page.goto('http://localhost:4176' + path);
          await page.evaluate(() => document.fonts.ready);
          await page.waitForTimeout(200);
          if (kind === 'viewer') {
            await page.locator('.viewer-stage .scene-fallback').waitFor({ state: 'hidden' });
            await page.evaluate(
              () =>
                new Promise((resolve) =>
                  requestAnimationFrame(() => requestAnimationFrame(resolve)),
                ),
            );
          }
          await inspect(kind, width);
          if (kind === 'library') {
            await page
              .getByRole('button', { name: 'reviewer_with_a_long_handle', exact: true })
              .click();
            await inspect('account-menu', width);
            await page.keyboard.press('Escape');
            await page
              .getByRole('button', {
                name: lang === 'fr' ? 'Ajouter une démo' : 'Add a demo',
                exact: true,
              })
              .click();
            if (await page.locator('dialog[open]').count()) await inspect('upload', width);
          }
          if (kind === 'viewer') {
            await page
              .getByRole('combobox', {
                name: lang === 'fr' ? 'Mode de caméra' : 'Camera mode',
                exact: true,
              })
              .click();
            await inspect('camera', width);
            await page.keyboard.press('Escape');
            await page.getByRole('button', { name: 'Options', exact: true }).click();
            await inspect('options', width);
            await page
              .getByRole('combobox', {
                name: lang === 'fr' ? 'Qualité du rendu' : 'Rendering quality',
                exact: true,
              })
              .click();
            await inspect('quality', width);
            await page.keyboard.press('Escape');
            await page.keyboard.press('Escape');
            await page
              .getByRole('button', { name: lang === 'fr' ? 'Joueurs' : 'Players', exact: true })
              .click();
            await inspect('players', width);
            await page
              .getByRole('button', {
                name: lang === 'fr' ? 'Fermer le panneau' : 'Close panel',
                exact: true,
              })
              .click();
            const addNote = page.getByRole('button', {
              name: lang === 'fr' ? 'Ajouter une note' : 'Add note',
              exact: true,
            });
            if (await addNote.isVisible()) await addNote.click();
            else {
              await page
                .getByRole('button', {
                  name: lang === 'fr' ? 'Autres commandes' : 'More controls',
                  exact: true,
                })
                .click();
              await page
                .getByRole('menuitem', {
                  name: lang === 'fr' ? 'Ajouter une note' : 'Add note',
                  exact: true,
                })
                .click();
            }
            await inspect('notes', width);
            await page
              .getByRole('button', {
                name: lang === 'fr' ? 'Fermer le panneau' : 'Close panel',
                exact: true,
              })
              .click();
            const more = page.locator('.moment-menu-trigger');
            if (await more.isVisible()) await more.click();
            else
              await page
                .getByRole('button', {
                  name: lang === 'fr' ? 'Autres commandes' : 'More controls',
                  exact: true,
                })
                .click();
            await inspect('navigation', width);
          }
        }
      }
      await context.close();
      console.log('Checked member workspace:', lang, theme);
    }
} finally {
  await browser.close();
  await app.close();
  rmSync(root, { recursive: true, force: true });
}
writeFileSync(
  `${output}/report${process.env.MEMBER_QA_LANGUAGE ? '-' + process.env.MEMBER_QA_LANGUAGE + '-' + process.env.MEMBER_QA_THEME : ''}.json`,
  JSON.stringify(report, null, 2),
);
const failures = report.filter(
  (r) =>
    r.overflow ||
    r.dialogOverflow ||
    r.oversizedRows ||
    r.misSizedSwitches ||
    !r.viewerFit ||
    !r.dockVisible ||
    r.offscreenControls.length ||
    r.errors.length,
);
console.log('Workspace checks:', report.length, 'Failures:', JSON.stringify(failures));
if (failures.length) process.exitCode = 1;
