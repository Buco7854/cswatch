// Run on Node 24 after building the checkout's production application.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, open, realpath, rm, statfs, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { gunzipSync } from 'node:zlib';
import { parseArgs } from 'node:util';
import { chromium } from '../frontend/node_modules/playwright/index.mjs';
import { Store } from '../backend/dist/db.js';
import { createApp } from '../backend/dist/server.js';
import { loadConfig } from '../backend/dist/config.js';
import { reserve } from '../backend/dist/ingestion.js';
import { processOne } from '../backend/dist/worker.js';
import { tsImport } from '../backend/node_modules/tsx/dist/esm/api/index.mjs';
import { boundedFile, decodeOpaqueFrame, digest } from './graphics/capture-report.mjs';
import { compareReplayFrame } from './graphics/replay-reference.mjs';

const options = Object.fromEntries(
  [
    'demo',
    'assets',
    'out',
    'player',
    'tick',
    'width',
    'height',
    'fov',
    'quality',
    'port',
    'reference',
    'max-mae',
  ].map((k) => [k, { type: 'string' }]),
);
const { values: o } = parseArgs({
  options: { ...options, software: { type: 'boolean' }, help: { type: 'boolean' } },
});
if (o.help) {
  console.log(
    'node scripts/capture-viewer.mjs --demo FILE.dem --assets MAP_ASSETS_DIR --player STEAM_ID --tick N --out NEW_DIR [--quality low|high --width W --height H --fov V --port PORT --software --reference FILE --max-mae N]',
  );
  process.exit(0);
}
assert(
  o.demo && o.assets && o.out && /^\d{1,20}$/.test(o.player ?? '') && o.player !== '0',
  'Required demo, asset directory, output, player ID',
);
function numeric(key, def, min, max, integer = true) {
  const n = Number(o[key] ?? def);
  assert(
    o[key] !== '' &&
      Number.isFinite(n) &&
      n >= min &&
      n <= max &&
      (!integer || Number.isInteger(n)),
    'Invalid --' + key,
  );
  return n;
}
const tick = numeric('tick', NaN, 0, 2 ** 31 - 1),
  player = o.player;
const viewport = {
  width: numeric('width', 960, 390, 1920),
  height: numeric('height', 640, 360, 1080),
};
const port = numeric('port', 4672, 1024, 65535),
  origin = 'http://127.0.0.1:' + port;
const quality = o.quality ?? 'high';
assert(['high', 'low'].includes(quality), 'Unsupported quality');
const maxMae = o['max-mae'] === undefined ? undefined : numeric('max-mae', 0, 0, 255, false);
assert(maxMae === undefined || o.reference, '--max-mae requires --reference');
const { frameAt, defaultSettings } = await tsImport('../frontend/src/playback.ts', import.meta.url);
const { attachAim, playerPose } = await tsImport('../frontend/src/player-pose.ts', import.meta.url);
const { firstPersonView, scopedVerticalFov } = await tsImport(
  '../frontend/src/pov-camera.ts',
  import.meta.url,
);
const settings = {
  ...defaultSettings,
  quality,
  cameraFov: numeric('fov', 73.74, 40, 110, false),
  renderResolution: 100,
  xray: false,
  playerLabels: false,
  shotTracers: false,
  trajectories: 'off',
  trails: false,
  flashFeedback: 'off',
  crosshair: false,
  autoFollowDeath: false,
  radar: false,
  voice: false,
  gameSounds: false,
};
const root = fileURLToPath(new URL('../', import.meta.url)),
  assets = await realpath(o.assets),
  out = resolve(o.out);
const parent = await realpath(dirname(out));
assert(
  parent !== assets && !parent.startsWith(assets + '/'),
  'Use a private output directory outside map assets',
);
const scratch = await mkdtemp(join(tmpdir(), 'cswatch-viewer-frame-'));
let app,
  db,
  browser,
  created = false,
  timeout;
try {
  await mkdir(out, { mode: 0o700 });
  created = true;
  process.env.LOG_LEVEL = 'silent';
  const password = randomBytes(32).toString('hex');
  const c = loadConfig({
    APP_URL: origin,
    DATA_DIR: scratch,
    MAP_ASSETS_DIR: assets,
    FRONTEND_DIR: join(root, 'frontend/dist'),
    PARSER_SANDBOX: 'required',
    PUBLIC_ACCESS: 'false',
    AUTO_OFFICIAL_MAPS_ENABLED: 'false',
    ADMIN_USERNAME: 'frame_operator',
    ADMIN_PASSWORD: password,
    MFA_REQUIRED_ROLES: 'none',
    COOKIE_SECURE: 'false',
  });
  db = new Store(scratch);
  app = await createApp(c, db);
  const { folder, id } = reserve(
    db,
    c,
    db.one('SELECT id FROM users WHERE username=?', 'frame_operator').id,
    'Frame QA',
    'upload',
  );
  const input = await open(
    o.demo,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  const hasher = createHash('sha256');
  let size;
  try {
    const s = await input.stat();
    size = s.size;
    assert(s.isFile() && size > 0 && size <= c.maxUploadMb * 1024 ** 2, 'Invalid local demo size');
    const space = await statfs(scratch, { bigint: true });
    assert(
      space.bavail * space.bsize >= BigInt(size * 2 + 512 * 1024 ** 2),
      'Insufficient replay staging space',
    );
    const stream = input.createReadStream({ end: size - 1, autoClose: false });
    stream.on('data', (b) => hasher.update(b));
    await pipeline(
      stream,
      createWriteStream(join(folder, 'input.dem'), { flags: 'wx', mode: 0o600 }),
    );
    assert.equal(stream.bytesRead, size);
  } finally {
    await input.close();
  }
  const replaySha256 = hasher.digest('hex');
  db.run("UPDATE demos SET size=?,status='queued' WHERE id=?", size, id);
  await processOne(db, c);
  assert.equal(
    db.one('SELECT status FROM demos WHERE id=?', id).status,
    'ready',
    'Sandboxed demo parse failed',
  );
  const readReplay = async (path, max) =>
    gunzipSync(await boundedFile(path, max + 65536), { maxOutputLength: max });
  const manifestBytes = await readReplay(join(folder, 'manifest.json.gz'), 16 * 1024 ** 2),
    manifest = JSON.parse(manifestBytes);
  const info = manifest.chunks.findLast(
    (chunk) => chunk.startTick <= tick && chunk.endTick >= tick,
  );
  assert(
    info && manifest.players.some((p) => p.id === player),
    'Tick or player missing from recording',
  );
  const chunkBytes = await readReplay(
      join(folder, 'chunks', info.index + '.json.gz'),
      4 * 1024 ** 2,
    ),
    chunk = JSON.parse(chunkBytes);
  attachAim(chunk, info, new Set(manifest.players.map((p) => p.id)));
  const { frame, next, alpha } = frameAt(chunk, tick),
    p = frame.players.find((p) => p.id === player);
  assert(p?.alive, 'A living recorded POV is required');
  const pose = playerPose(
    p,
    next.players.find((p) => p.id === player),
    alpha,
    {
      fromTick: frame.tick,
      nextTick: next.tick,
      tickRate: manifest.tickRate,
      roundBoundary: manifest.rounds.some((r) => r.tick > frame.tick && r.tick <= next.tick),
    },
  );
  const expected = firstPersonView(pose),
    fov = scopedVerticalFov(p) ?? settings.cameraFov;
  await app.listen({ host: '127.0.0.1', port });
  browser = await chromium.launch({
    args: [
      '--disable-background-networking',
      '--disable-dev-shm-usage',
      '--force-color-profile=srgb',
      ...(o.software ? ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] : []),
    ],
  });
  timeout = setTimeout(() => void browser.close().catch(() => {}), 180000);
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    colorScheme: 'dark',
    reducedMotion: 'no-preference',
    serviceWorkers: 'block',
  });
  await context.route('**/*', (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (
      url.origin === origin &&
      (['GET', 'HEAD'].includes(request.method()) ||
        (request.method() === 'POST' && url.pathname === '/api/auth/login'))
    )
      return route.continue();
    return route.abort();
  });
  const page = await context.newPage();
  await page.addInitScript({ path: join(root, 'scripts/graphics/viewer-probe.js') });
  await page.addInitScript((s) => {
    for (const key of ['viewer-settings-v2', 'viewer-settings-v2-mobile'])
      localStorage.setItem(key, JSON.stringify(s));
  }, settings);
  await page.goto(origin + '/login');
  await page.locator('input[autocomplete=username]').fill('frame_operator');
  await page
    .locator('input[type=password]')
    .fill(password)
    .catch(() => {
      throw Error('Isolated sign-in unavailable');
    });
  await page.locator('input[type=password]').press('Enter');
  await page.waitForURL('**/library');
  const prefix = '/api/demos/' + id,
    resources = new Map(),
    scripts = new Map(),
    responses = new Map();
  let responseError;
  const pending = new Set();
  page.on('response', (r) => {
    if (r.status() !== 200) return;
    const url = new URL(r.url()),
      path = url.pathname;
    if (url.origin !== origin) return;
    const manifestPath = prefix + '/playback',
      chunkPath = manifestPath + '/chunks/' + info.index;
    const track = path === manifestPath || path === chunkPath || path === prefix + '/map-assets';
    const visual = /\.glb$|\/environment\/|\/grade\./.test(path);
    const script = path.startsWith('/assets/') && path.endsWith('.js');
    if (!track && !visual && !script) return;
    const job = (async () => {
      if (script) scripts.set(path, digest(await r.body()));
      else if (path === prefix + '/map-assets') responses.set(path, await r.json());
      else if (track) responses.set(path, digest(await r.body()));
      else {
        const etag = /^(?:W\/)?"([a-f0-9]{64})(?:-gzip)?"$/.exec(r.headers().etag ?? '')?.[1];
        if (etag) resources.set(path, etag);
        else {
          const sizes = await r.request().sizes();
          assert(
            sizes.responseBodySize <= 32 * 1024 ** 2,
            'Supplementary asset exceeds capture limit',
          );
          resources.set(path, digest(await r.body()));
        }
      }
    })().catch((e) => {
      responseError = e;
    });
    pending.add(job);
    void job.finally(() => pending.delete(job));
  });
  await page.goto(origin + '/watch/' + id + '?tick=' + tick + '&player=' + player);
  await page
    .locator('.scene[data-camera-mode=pov][data-map-model-state=ready] canvas')
    .waitFor({ timeout: 90000 });
  await page.waitForFunction(
    () => {
      const d = document.querySelector('.scene')?.dataset;
      return (
        d &&
        ![d.environmentState, d.agentModelState, d.equipmentModelState].includes('pending') &&
        Number(d.equipmentReadyCount) +
          Number(d.equipmentErrorCount) +
          Number(d.equipmentUnavailableCount) >=
          Number(d.equipmentExpectedCount)
      );
    },
    undefined,
    { timeout: 60000 },
  );
  await page.waitForLoadState('networkidle');
  await Promise.all([...pending]);
  if (responseError) throw responseError;
  assert.equal(responses.get(prefix + '/playback'), digest(manifestBytes), 'Unbound manifest');
  assert.equal(
    responses.get(prefix + '/playback/chunks/' + info.index),
    digest(chunkBytes),
    'Unbound primary chunk',
  );
  const discovery = responses.get(prefix + '/map-assets');
  assert(discovery?.assets, 'Missing production map discovery');
  const canvas = page.locator('.scene canvas');
  await canvas.evaluate((element) => element.setAttribute('data-frame-target', ''));
  // Keep the production backdrop for transparent WebGL fragments and exclude HUD paint
  // without changing layout, the R3F drawing buffer or its camera aspect.
  await page.addStyleTag({
    content: `
      *:not([data-frame-target]):not(:has([data-frame-target])),
      *::before, *::after { visibility: hidden !important; }
    `,
  });
  const screenshot = async () => {
    assert.equal(Number(await page.locator('.timeline-slider').inputValue()), tick);
    assert.equal(await page.locator('.timeline-slider').isVisible(), false, 'HUD mask unavailable');
    const shot = await page.evaluate(() => window.captureViewerCanvas());
    const clip = await canvas.boundingBox();
    assert(
      clip &&
        clip.x >= 0 &&
        clip.y >= 0 &&
        clip.x + clip.width <= viewport.width &&
        clip.y + clip.height <= viewport.height &&
        clip.width === shot.buffer[0] &&
        clip.height === shot.buffer[1],
      'Composited canvas does not match the drawing buffer',
    );
    return { ...shot, image: await page.screenshot({ clip }) };
  };
  let shot = await screenshot();
  // Optional rigs and the grade can finish decoding after transport becomes idle.
  // Require the complete output and asset state to repeat in successive paused renders.
  let stable = false;
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(250);
    const again = await screenshot();
    stable =
      shot.image.equals(again.image) &&
      JSON.stringify(shot.status) === JSON.stringify(again.status);
    shot = again;
    if (stable) break;
  }
  assert(stable, 'Paused production frame did not settle');
  assert(
    Math.hypot(...shot.camera.eye.map((v, i) => v - expected.position[i])) < 1e-5 &&
      Math.hypot(
        ...shot.camera.direction.map((v, i) => v - (expected.target[i] - expected.position[i]) / 8),
      ) < 1e-5 &&
      Math.abs(shot.camera.fov - fov) < 1e-5,
    'Rendered camera differs from recorded POV',
  );
  assert.equal(shot.committed.tick, tick);
  assert.equal(shot.committed.player, player);
  assert.equal(shot.committed.map, manifest.map);
  assert.deepEqual(
    shot.committed.settings,
    settings,
    'Committed graphics settings differ from request',
  );
  assert.deepEqual(shot.viewport, viewport, 'Unexpected actual viewport');
  assert.equal(shot.status.quality, quality);
  assert.equal(shot.status.renderResolution, '100');
  const tier = shot.status.mapTier;
  assert(['desktop', 'mobile'].includes(tier), 'Expected detailed map');
  const modelUrl = discovery.assets[tier === 'desktop' ? 'model' : 'mobile'];
  const modelSha256 = resources.get(modelUrl);
  assert(modelSha256, 'Missing delivered map fingerprint');
  const pack = discovery.packId;
  assert(!pack || /^[0-9a-f]{64}$/.test(pack));
  assert(/^[A-Za-z0-9_-]{1,80}$/.test(manifest.map));
  const tierRoot = pack ? join(assets, 'packs', pack, 'maps') : assets;
  const tierManifest = JSON.parse(
    await boundedFile(join(tierRoot, manifest.map, tier, 'manifest.json'), 64 * 1024),
  );
  assert(
    tierManifest.map === manifest.map &&
      tierManifest.tier === tier &&
      tierManifest.outputSha256 === modelSha256 &&
      /^[a-f0-9]{64}$/.test(tierManifest.sourceSha256) &&
      tierManifest.assetVersion,
    'Rendered map differs from tier manifest',
  );
  await Promise.all([...pending]);
  if (responseError) throw responseError;
  assert(scripts.size > 0, 'Missing production application fingerprint');
  const image = shot.image;
  assert(image.length > 0 && image.length <= 16 * 1024 ** 2);
  await decodeOpaqueFrame(image, ...shot.buffer);
  const { image: _, committed, ...observed } = shot;
  const report = {
    schemaVersion: 1,
    kind: 'cswatch-replay-frame',
    scope: 'production-pov-canvas',
    imageSource: 'chromium-composited-canvas',
    coordinateSystem: 'viewer-meters-y-up',
    replaySha256,
    manifestSha256: digest(manifestBytes),
    chunkSha256: digest(chunkBytes),
    tick,
    player,
    map: manifest.map,
    eyePositionSource: pose.eyeOffset
      ? 'recorded-eye-offset'
      : pose.duck === undefined
        ? 'viewer-standing-height'
        : 'viewer-height-from-duck',
    modelSha256,
    sourceSha256: tierManifest.sourceSha256,
    assetVersion: tierManifest.assetVersion,
    mapVerification: discovery.verification,
    cameraMode: 'pov',
    settings: committed.settings,
    ...observed,
    visualResourcesSha256: digest(JSON.stringify([...resources].sort())),
    viewerBuildSha256: digest(JSON.stringify([...scripts].sort())),
    browser: browser.version(),
    hudFree: true,
    png: 'frame.png',
    sha256: digest(image),
  };
  report.comparison = await compareReplayFrame(report, image, o.reference);
  report.maxMae = maxMae ?? null;
  report.verdict =
    report.comparison.status === 'unverified'
      ? 'unverified'
      : maxMae === undefined
        ? 'not-evaluated'
        : report.comparison.metrics.mae > maxMae
          ? 'fail'
          : 'pass';
  await writeFile(join(out, 'frame.png'), image, { flag: 'wx', mode: 0o600 });
  await writeFile(join(out, 'frame.json'), JSON.stringify(report, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  console.log(JSON.stringify({ file: join(out, 'frame.json'), verdict: report.verdict }));
  if (report.verdict === 'unverified') process.exitCode = 3;
  if (report.verdict === 'fail') process.exitCode = 2;
} catch (error) {
  if (created) await rm(out, { recursive: true, force: true });
  throw error;
} finally {
  clearTimeout(timeout);
  await browser?.close();
  try {
    if (app) await app.close();
    else db?.close();
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
