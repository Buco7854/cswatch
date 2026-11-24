import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { constants } from 'node:fs';
import { mkdir, open, rm, writeFile, realpath, statfs } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { once } from 'node:events';
import { chromium } from '../frontend/node_modules/playwright/index.mjs';
import { build } from '../frontend/node_modules/esbuild/lib/main.js';
import { graphicsLimits, readBoundVisualAudit } from '../tools/assets/map-graphics-contract.mjs';
import { verifyPreparedGlb } from '../tools/assets/prepared-glb.mjs';
import { validateTexturePlan } from '../tools/assets/texture-plan-validation.mjs';
import {
  boundedFile,
  captureKind,
  compareView,
  coordinateSystem,
  digest,
  evaluateLimits,
} from './graphics/capture-report.mjs';

const { values: o } = parseArgs({
  options: {
    audit: { type: 'string' },
    out: { type: 'string' },
    reference: { type: 'string' },
    software: { type: 'boolean' },
    width: { type: 'string' },
    height: { type: 'string' },
    fov: { type: 'string' },
    samples: { type: 'string' },
    'device-id': { type: 'string' },
    'max-mae': { type: 'string' },
    'max-p95-ratio': { type: 'string' },
    help: { type: 'boolean' },
  },
});
if (o.help) {
  console.log(
    'node scripts/capture-graphics.mjs --audit /tier/visual-audit.json --out NEW_DIR [--reference FILE] [--software] [--width W --height H --fov VFOV --samples N] [--device-id LABEL --max-p95-ratio R --max-mae E]',
  );
  process.exit(0);
}
assert(o.audit && o.out, 'Required: --audit FILE --out NEW_DIR');
function numeric(key, defaultValue, min, max, integer = false) {
  if (o[key] === undefined) return defaultValue;
  const n = Number(o[key]);
  assert(
    o[key].trim() &&
      Number.isFinite(n) &&
      n >= min &&
      n <= max &&
      (!integer || Number.isInteger(n)),
    'Invalid --' + key,
  );
  return n;
}
const projection = {
  type: 'perspective',
  width: numeric('width', 720, 64, 1920, true),
  height: numeric('height', 480, 64, 1080, true),
  verticalFovDegrees: numeric('fov', 60, 10, 150),
  near: 0.05,
  far: 3000,
  upRule: 'gltf-positive-y-or-positive-z-at-poles',
  dpr: 1,
};
const settings = {
  profile: 'isolated-map-v1',
  exposure: 1,
  toneMapping: 'ACESFilmic',
  clearColor: '#38424d',
  hemisphere: { sky: '#ffffff', ground: '#777777', intensity: 1 },
  key: { color: '#ffffff', intensity: 2, position: [4, 8, 3] },
  antialias: false,
  shadows: false,
  environment: false,
  sky: false,
  gradingLut: false,
};
const limits = {
  maxMae: numeric('max-mae', undefined, 0, 255),
  maxP95Ratio: numeric('max-p95-ratio', undefined, 0, 100),
};
const samples = numeric('samples', 20, 5, 60, true),
  warmup = 4;
assert(!o['device-id'] || /^[a-zA-Z0-9_.-]{1,64}$/.test(o['device-id']), 'Invalid --device-id');
assert(limits.maxP95Ratio === undefined || o['device-id'], 'Timing gates require --device-id');
assert(
  Object.values(limits).every((x) => x === undefined) || o.reference,
  'Thresholds require --reference',
);
const root = fileURLToPath(new URL('../', import.meta.url));
const tierDir = dirname(resolve(o.audit)),
  out = resolve(o.out);
const outParent = await realpath(dirname(out)),
  inputDir = await realpath(tierDir);
assert(
  outParent !== inputDir && !outParent.startsWith(inputDir + '/'),
  'Capture outside the immutable tier',
);
const auditBytes = await boundedFile(o.audit, graphicsLimits.bytes);
const manifest = JSON.parse(await boundedFile(join(tierDir, 'manifest.json'), 16384));
const audit = readBoundVisualAudit(auditBytes, manifest);
const auditSha256 = manifest.visualAuditSha256;
const views = audit.views.map((view, index) => ({ ...view, index }));
validateTexturePlan(
  manifest,
  await boundedFile(join(tierDir, 'texture-plan.json'), 4 * 1024 ** 2),
  audit.tier,
);
const modelPath = join(tierDir, 'scene.glb');
const proof = await verifyPreparedGlb(modelPath);
assert(
  proof.sha256 === audit.modelSha256 && proof.bytes === manifest.bytes,
  'Prepared GLB mismatch',
);
const referenceBytes = o.reference ? await boundedFile(o.reference, 4 * 1024 ** 2) : null;
const reference = referenceBytes ? JSON.parse(referenceBytes) : null;
const bundle = await build({
  entryPoints: [join(root, 'scripts/graphics/capture-browser.js')],
  nodePaths: [join(root, 'frontend/node_modules')],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  write: false,
  minify: true,
});
const js = bundle.outputFiles[0].contents;
const lock = await open(
  '/tmp/cswatch-native-viewer-bench.lock',
  constants.O_CREAT | constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  0o600,
);
let browser,
  server,
  created = false,
  timer;
try {
  assert((await lock.stat()).isFile(), 'Invalid benchmark lock');
  assert.equal(
    spawnSync('flock', ['-w', '90', '3'], { stdio: ['ignore', 'ignore', 'inherit', lock.fd] })
      .status,
    0,
    'Timed out waiting for benchmark lock',
  );
  const disk = await statfs(outParent, { bigint: true });
  const outputBudget = BigInt(
    views.length * (projection.width * projection.height * 4 + 65536) + 512 * 1024 ** 2,
  );
  assert(disk.bavail * disk.bsize >= outputBudget, 'Insufficient capture output space');
  await mkdir(out, { mode: 0o700 });
  created = true;
  const args = [
    '--disable-background-networking',
    '--disable-dev-shm-usage',
    '--force-color-profile=srgb',
  ];
  if (o.software) args.push('--enable-unsafe-swiftshader', '--use-angle=swiftshader');
  browser = await chromium.launch({ args, timeout: 30000 });
  // Closing the browser also interrupts a stalled evaluation or GL driver readback.
  timer = setTimeout(() => void browser.close().catch(() => {}), 240000);
  const context = await browser.newContext({
    viewport: { width: projection.width, height: projection.height },
    deviceScaleFactor: 1,
    serviceWorkers: 'block',
  });
  const page = await context.newPage();
  let renderError;
  page.on('pageerror', (err) => {
    renderError ??= err.message.slice(0, 500);
  });
  page.on('console', (m) => {
    if (m.type() === 'error') renderError ??= m.text().slice(0, 500);
  });
  // Playwright fulfils the document and JS in memory. Stream the verified GLB
  // directly to Chrome to avoid an extra base64 copy of a large detailed tier.
  const modelRoute = '/' + randomBytes(24).toString('hex') + '/scene.glb';
  let served = false;
  server = createServer(async (req, res) => {
    if (req.method !== 'GET' || req.url !== modelRoute || served) {
      res.writeHead(404).end();
      return;
    }
    served = true;
    let handle;
    try {
      handle = await open(
        modelPath,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const info = await handle.stat();
      assert(
        info.isFile() && info.nlink === 1 && info.size === proof.bytes,
        'Model changed before capture',
      );
      res.writeHead(200, { 'Content-Type': 'model/gltf-binary', 'Cache-Control': 'no-store' });
      const hash = createHash('sha256');
      for await (const chunk of handle.createReadStream({
        end: proof.bytes - 1,
        autoClose: false,
      })) {
        hash.update(chunk);
        if (!res.write(chunk)) await once(res, 'drain', { signal: AbortSignal.timeout(15000) });
      }
      assert.equal(hash.digest('hex'), proof.sha256, 'Model changed during capture');
      res.end();
    } catch {
      res.destroy();
    } finally {
      await handle?.close();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const base = origin + modelRoute.slice(0, -'scene.glb'.length);
  const html =
    '<!doctype html><meta charset="utf-8"><script defer src="runner.js"></script><body style="margin:0"></body>';
  // No browser request may leave the local capture origin.
  await context.route('**/*', async (route) => {
    const r = route.request(),
      url = r.url();
    if (r.method() === 'GET') {
      if (url === base)
        return route.fulfill({
          contentType: 'text/html',
          body: html,
          headers: {
            'Content-Security-Policy':
              "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' blob:; img-src blob: data:; style-src 'unsafe-inline'; worker-src 'none'",
          },
        });
      if (url === base + 'runner.js')
        return route.fulfill({ contentType: 'text/javascript', body: Buffer.from(js) });
      if (url === origin + modelRoute) return route.continue();
    }
    renderError ??= 'Unexpected capture resource';
    return route.abort();
  });
  await page.goto(base);
  const renderer = await page.evaluate((config) => window.prepareCapture(config), {
    tier: audit.tier,
    projection,
    settings,
  });
  renderer.browser = browser.version();
  renderer.deviceId = o['device-id'] ?? null;
  const report = {
    schemaVersion: 1,
    kind: captureKind,
    map: audit.map,
    tier: audit.tier,
    assetVersion: audit.assetVersion,
    sourceSha256: audit.sourceSha256,
    modelSha256: proof.sha256,
    auditSha256,
    auditBinding: 'tier-manifest',
    runnerBundleSha256: digest(js),
    coordinateSystem,
    scope: 'static-main-world-only',
    projection,
    settings,
    colorSpace: 'srgb',
    hudFree: true,
    renderer,
    timing: 'CPU submission through synchronous 1px framebuffer readback (ms)',
    limits,
    reference: reference
      ? {
          manifestSha256: digest(referenceBytes),
          kind: reference.kind,
          provenance:
            reference.kind === 'external-graphics-reference'
              ? (reference.provenance ?? null)
              : null,
        }
      : null,
    views: [],
  };
  for (const view of views) {
    const { image, visibility, performance } = await page.evaluate(
      (input) => window.captureView(input),
      { view, samples, warmup },
    );
    assert(!renderError, 'Browser capture error: ' + renderError);
    assert(
      image.startsWith('data:image/png;base64,') && image.length < 16 * 1024 ** 2,
      'Invalid framebuffer capture',
    );
    const bytes = Buffer.from(image.slice('data:image/png;base64,'.length), 'base64');
    const png = 'frame-' + String(view.index).padStart(3, '0') + '.png';
    await writeFile(join(out, png), bytes, { flag: 'wx', mode: 0o600 });
    const frame = { ...view, png, sha256: digest(bytes), visibility, performance };
    frame.comparison = await compareView(report, frame, bytes, reference, o.reference);
    frame.checks = evaluateLimits(report, frame, reference, limits);
    report.views.push(frame);
  }
  const checks = report.views.flatMap((v) => v.checks);
  report.verdict = 'not-evaluated';
  if (checks.length) report.verdict = 'pass';
  if (
    checks.some((check) => check.status === 'unverified') ||
    (!views.length && Object.values(limits).some((value) => value !== undefined))
  )
    report.verdict = 'unverified';
  if (checks.some((check) => check.status === 'fail')) report.verdict = 'fail';
  await writeFile(join(out, 'capture.json'), JSON.stringify(report, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      file: join(out, 'capture.json'),
      views: views.length,
      verdict: report.verdict,
    }),
  );
  if (report.verdict === 'fail') process.exitCode = 2;
  if (report.verdict === 'unverified') process.exitCode = 3;
} catch (error) {
  if (created) await rm(out, { recursive: true, force: true });
  throw error;
} finally {
  clearTimeout(timer);
  await browser?.close();
  server?.closeAllConnections();
  server?.close();
  await lock.close();
}
