import { chromium } from '../../frontend/node_modules/playwright/index.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serve } from './lab-server.mjs';

const [map, output, poseFile, w, h] = process.argv.slice(2);
const poses = JSON.parse(
  await readFile(poseFile ?? new URL('./poses.json', import.meta.url), 'utf8'),
);
const sizes =
  w && h
    ? [[Number(w), Number(h)]]
    : [
        [720, 480],
        [1280, 720],
      ];
await mkdir(output, { recursive: true });
const rate = Number(process.env.CS2_LAB_MBIT) || 0;
if (!Number.isFinite(rate) || rate < 0) throw Error('Invalid bandwidth');
const server = await serve(map, 0, true, rate);
let browser;
try {
  browser = await chromium.launch({
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--enable-unsafe-swiftshader',
      '--use-gl=angle',
      '--use-angle=swiftshader',
    ],
  });
  const page = await browser.newPage({
    viewport: { width: sizes[0][0], height: sizes[0][1] },
    deviceScaleFactor: 1,
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.error(m.text());
  });
  page.on('pageerror', console.error);
  await page.goto(
    server.url +
      (process.env.CS2_LAB_VIEW ? '&view=' + encodeURIComponent(process.env.CS2_LAB_VIEW) : '') +
      (process.env.CS2_LAB_TIER ? '&tier=' + encodeURIComponent(process.env.CS2_LAB_TIER) : ''),
  );
  await page.waitForFunction(
    () =>
      window.worldLab?.loadTimes.fullQualityMs || document.querySelector('canvas').dataset.error,
    null,
    { timeout: 180000 },
  );
  const error = await page.locator('canvas').getAttribute('data-error');
  if (error) throw Error(error);
  const results = [];
  const timing = await page.evaluate(() => window.worldLab.loadTimes);
  await writeFile(
    join(output, 'load.json'),
    JSON.stringify({ mbit: rate || null, ...timing, downloads: server.downloads }, null, 2),
  );
  console.log(JSON.stringify(timing));
  console.log('Chromium ' + browser.version());
  for (const [width, height] of sizes) {
    await page.setViewportSize({ width, height });
    for (const p of poses) {
      const previous = await page.evaluate((p) => {
        const tick = window.worldLab.tick;
        window.worldLab.setViewOptions({ skybox3D: p.skybox3D ?? true, fog: p.fog ?? true });
        window.worldLab.setPose(p);
        return tick;
      }, p);
      await page.waitForFunction(
        (t) => window.worldLab.tick > t && window.worldLab.completionMs > 0,
        previous,
        { timeout: 120000 },
      );
      const screenshot = join(output, `${p.name}-${width}x${height}.png`);
      await page.locator('canvas').screenshot({
        path: screenshot,
        timeout: 120000,
        style: 'section, aside {visibility:hidden}',
      });
      const data = await page.evaluate(() => {
        const { draws, triangles, textureBytes, multiDraw, submissionMs, completionMs } =
          window.worldLab;
        return { draws, triangles, textureBytes, multiDraw, submissionMs, completionMs };
      });
      results.push({ ...p, width, height, ...data, screenshot });
      console.log(JSON.stringify(results.at(-1)));
    }
  }
  await writeFile(join(output, 'poses.json'), JSON.stringify(results, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
