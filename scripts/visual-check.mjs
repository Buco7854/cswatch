/** Production browser layout matrix. Does not certify real-device GPU performance. */
import { chromium } from '../frontend/node_modules/playwright/index.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'],
});
const base = process.env.VISUAL_BASE_URL || 'http://localhost:8000',
  report = [];
mkdirSync('.design/qa', { recursive: true });
for (const lang of ['en', 'fr'])
  for (const theme of ['dark', 'light']) {
    const context = await browser.newContext({ locale: lang === 'fr' ? 'fr-FR' : 'en-GB' });
    await context.addInitScript(
      ({ lang, theme }) => {
        localStorage.setItem('cswatch.language', lang);
        localStorage.setItem('theme', theme);
      },
      { lang, theme },
    );
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    for (const [kind, path] of [
      ['landing', '/'],
      ['viewer-feature', '/features/viewer'],
      ['imports', '/features/imports'],
      ['hosting', '/self-host'],
      ['viewer', '/watch/sample'],
      ['explore', '/explore'],
    ])
      for (const width of [1440, 768, 390, 320]) {
        await page.setViewportSize({
          width,
          height: width === 390 ? 844 : width === 768 ? 1024 : 900,
        });
        await page.goto(base + path, { waitUntil: 'domcontentloaded' });
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(900);
        const metrics = await page.evaluate(() => ({
          overflow: document.documentElement.scrollWidth > innerWidth,
          lang: document.documentElement.lang,
          h1: document.querySelector('h1')?.textContent,
          headingProblems: [...document.querySelectorAll('h1,h2,h3')]
            .filter((h) => {
              const s = getComputedStyle(h);
              return h.getBoundingClientRect().height / parseFloat(s.lineHeight) > 2.1;
            })
            .map((h) => h.textContent),
        }));
        report.push({ lang, theme, kind, width, ...metrics, errors: [...errors] });
        if ((kind === 'landing' || kind === 'viewer') && (width === 1440 || width === 390))
          await page.screenshot({
            path: `.design/qa/${kind}-${lang}-${theme}-${width}.png`,
            fullPage: false,
          });
      }
    console.log('Checked', lang, theme);
    await context.close();
  }
await browser.close();
writeFileSync('.design/qa/report.json', JSON.stringify(report, null, 2));
const failures = report.filter((r) => r.overflow || r.headingProblems.length || r.errors.length);
console.log('Checked', report.length, 'combinations. Findings:', JSON.stringify(failures));
if (failures.length) process.exitCode = 1;
