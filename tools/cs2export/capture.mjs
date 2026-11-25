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
const server = await serve(map, 0, true);
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
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.error(m.text());
  });
  page.on('pageerror', console.error);
  await page.goto(
    server.url + (process.env.CS2_LAB_VIEW === 'material-id' ? '&view=material-id' : ''),
  );
  await page.waitForFunction(
    () => window.worldLab || document.querySelector('canvas').dataset.error,
    null,
    { timeout: 180000 },
  );
  const error = await page.locator('canvas').getAttribute('data-error');
  if (error) throw Error(error);
  const results = [];
  console.log(
    'Map payload bytes ' +
      (await page.evaluate(() =>
        performance
          .getEntriesByType('resource')
          .filter((r) => new URL(r.name).pathname.startsWith('/world-data/'))
          .reduce((n, r) => n + r.decodedBodySize, 0),
      )),
  );
  console.log('Chromium ' + browser.version());
  for (const [width, height] of sizes) {
    await page.setViewportSize({ width, height });
    for (const p of poses) {
      const previous = await page.evaluate((p) => {
        const tick = window.worldLab.tick;
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
