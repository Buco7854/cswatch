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
import { readManagedPack, snapshotManagedPack } from './graphics/managed-pack.mjs';
import { compareReplayFrame } from './graphics/replay-reference.mjs';
import { bindViewerResponseBytes, observeViewerNetwork } from './graphics/viewer-network.mjs';
import { verifyPreparedGlb } from '../tools/assets/prepared-glb.mjs';

const options = Object.fromEntries(
  [
    'demo',
    'assets',
    'jobs',
    'catalog',
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
    'play-seconds',
    'play-camera',
    'max-p95-ms',
    'min-intervals',
  ].map((k) => [k, { type: 'string' }]),
);
const { values: o } = parseArgs({
  options: { ...options, software: { type: 'boolean' }, help: { type: 'boolean' } },
});
if (o.help) {
  console.log(
    'node scripts/capture-viewer.mjs --demo FILE.dem --assets MAP_ASSETS_DIR --player STEAM_ID --tick N --out NEW_DIR [--jobs MAP_JOBS_DIR --catalog MAP_CATALOG_FILE --quality auto|compact|low|high --width W --height H --fov V --port PORT --software --reference FILE --max-mae N --play-seconds N --play-camera pov|follow|free --max-p95-ms N --min-intervals N]',
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
const playSeconds = o['play-seconds'] === undefined ? 0 : numeric('play-seconds', 0, 3, 30);
const playCamera = o['play-camera'] ?? 'pov';
assert(['pov', 'follow', 'free'].includes(playCamera), 'Unsupported playback camera');
const maxP95 =
  o['max-p95-ms'] === undefined ? undefined : numeric('max-p95-ms', 0, 1, 60_000, false);
assert(
  playSeconds || (o['play-camera'] === undefined && maxP95 === undefined),
  'Playback options require --play-seconds',
);
const minIntervals = numeric('min-intervals', 20, 1, 50_000);
assert(
  o['min-intervals'] === undefined || maxP95 !== undefined,
  '--min-intervals requires --max-p95-ms',
);
const quality = o.quality ?? 'high';
assert(['auto', 'compact', 'high', 'low'].includes(quality), 'Unsupported quality');
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
assert(!o.catalog || o.jobs, '--catalog requires --jobs');
const jobs = o.jobs && resolve(o.jobs);
const catalogFile = o.catalog && resolve(o.catalog);
if (jobs) {
  assert.equal(await realpath(jobs), jobs, 'Expected a real operator jobs directory');
  assert(
    parent !== jobs && !parent.startsWith(jobs + '/'),
    'Output must be outside the operator queue',
  );
}
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
  const managedInput = jobs && {
    jobs,
    catalogFile,
    assets,
    map: manifest.map,
    identity: JSON.parse(db.one('SELECT metadata FROM demos WHERE id=?', id).metadata).mapIdentity,
  };
  const managed = jobs && (await readManagedPack(managedInput));
  if (managed) await snapshotManagedPack(managed, jobs, c);
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
  bindViewerResponseBytes(app);
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
  const prefix = '/api/demos/' + id;
  const { resources, scripts, responses, settle } = observeViewerNetwork(
    page,
    origin,
    prefix,
    info.index,
  );
  await page.goto(origin + '/watch/' + id + '?tick=' + tick + '&player=' + player);
  await page
    .locator('.scene[data-camera-mode=pov][data-map-model-state=ready] canvas')
    .waitFor({ timeout: 90000 });
  const waitForModels = (mode) =>
    page.waitForFunction(
      (expectedMode) => {
        const state = window.viewerPlaybackReadiness();
        return state?.cameraMode === expectedMode && state.settled;
      },
      mode,
      { timeout: 60000 },
    );
  await page.waitForLoadState('networkidle');
  await waitForModels('pov');
  await settle();
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
  const hudMask = await page.addStyleTag({
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
  // Adaptation runs only during moving playback. The paused reference is always at native resolution.
  assert.equal(shot.status.renderResolution, '100');
  const tier = shot.status.mapTier;
  assert(['desktop', 'mobile', 'compact'].includes(tier), 'Missing delivered map tier');
  if (quality === 'compact')
    assert.equal(tier, 'compact', 'Compact tier was requested but is unavailable');
  if (quality === 'high' || quality === 'low') {
    assert.equal(shot.status.quality, quality);
    assert.notEqual(tier, 'compact', 'Expected detailed map');
    const preferred = quality === 'high' ? 'desktop' : 'mobile';
    if (discovery.assets[preferred === 'desktop' ? 'model' : preferred])
      assert.equal(tier, preferred);
  }
  if (tier === 'compact') assert.equal(shot.status.quality, 'low');
  const modelUrl = discovery.assets[tier === 'desktop' ? 'model' : tier];
  const modelSha256 = resources.get(modelUrl);
  assert(modelSha256, 'Missing delivered map fingerprint');
  if (shot.status.environmentState === 'ready') {
    for (const face of discovery.assets.environment?.sky?.faces ?? [])
      assert(resources.has(face), 'Missing delivered environment face ' + face);
  }
  if (shot.nativePovModel) {
    const id = /^native-([a-z0-9]+)-viewmodel$/.exec(shot.nativePovModel)?.[1];
    assert(
      id &&
        [...resources].some(
          ([path, hash]) => path === '/api/assets/viewmodels/' + id + '/' + hash + '.glb',
        ),
      'Missing delivered native POV model',
    );
  }
  const pack = discovery.packId;
  assert(!pack || /^[0-9a-f]{64}$/.test(pack));
  const mapSource = pack
    ? (discovery.resolution?.source ?? discovery.resolution?.approval?.source ?? null)
    : null;
  if (managed) {
    assert.equal(pack, managed.marker.packId, 'Discovery selected a different pack');
    assert.equal(discovery.verification, managed.verification);
    assert.deepEqual(mapSource, managed.source, 'Discovery selected a different source');
  }
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
  let parentMobile;
  if (tier === 'compact') {
    const folder = join(tierRoot, manifest.map, 'mobile');
    const parent = JSON.parse(await boundedFile(join(folder, 'manifest.json'), 64 * 1024));
    const verified = await verifyPreparedGlb(join(folder, 'scene.glb'));
    assert(
      parent.map === manifest.map &&
        parent.tier === 'mobile' &&
        parent.assetVersion === tierManifest.assetVersion &&
        parent.outputSha256 === verified.sha256 &&
        parent.bytes === verified.bytes &&
        tierManifest.sourceSha256 === verified.sha256 &&
        tierManifest.sourceBytes === verified.bytes &&
        /^[a-f0-9]{64}$/.test(parent.sourceSha256),
      'Compact tier does not match its prepared mobile source',
    );
    parentMobile = {
      modelSha256: verified.sha256,
      bytes: verified.bytes,
      sourceSha256: parent.sourceSha256,
    };
  }
  await settle();
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
    sourceSha256: parentMobile?.sourceSha256 ?? tierManifest.sourceSha256,
    ...(parentMobile && { parentMobile }),
    assetVersion: tierManifest.assetVersion,
    mapVerification: discovery.verification,
    mapSource,
    packId: pack ?? null,
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
  if (playSeconds) {
    await hudMask.evaluate((node) => node.remove());
    const review = page.getByRole('dialog', { name: 'Round review' });
    if (await review.isVisible()) {
      await page.keyboard.press('Escape');
      await review.waitFor({ state: 'hidden' });
    }
    if (playCamera !== 'pov') {
      const name = playCamera === 'follow' ? 'Third-person follow' : 'Free camera';
      const group = page.getByRole('group', { name: 'Camera mode', exact: true });
      if (await group.isVisible()) await group.getByRole('button', { name, exact: true }).click();
      else {
        await page.getByRole('combobox', { name: 'Camera mode', exact: true }).click();
        await page.getByRole('option', { name, exact: true }).click();
      }
    }
    const expectedMode = playCamera === 'free' ? 'orbit' : playCamera;
    await waitForModels(expectedMode);
    const play = page.getByRole('button', { name: 'Play', exact: true });
    await play.waitFor({ state: 'visible' });
    report.playbackTiming = await play.evaluate(
      (button, options) => window.measureViewerPlayback(button, options),
      { seconds: playSeconds, mode: expectedMode, maxP95Ms: maxP95 ?? null, minIntervals },
    );
    assert.equal(report.playbackTiming.startTick, tick, 'Unexpected playback start');
    assert.equal(report.playbackTiming.entry.mapTier, tier, 'Model changed before timing');
    const pause = page.getByRole('button', { name: 'Pause', exact: true });
    if (await pause.isVisible()) await pause.evaluate((button) => button.click());
    await settle();
  }
  if (managed) {
    const current = await readManagedPack(managedInput);
    assert.deepEqual(current.marker, managed.marker, 'Installed pack changed during capture');
    assert.deepEqual(current.request, managed.request, 'Map request changed during capture');
    assert.deepEqual(current.result, managed.result, 'Map result changed during capture');
  }
  await writeFile(join(out, 'frame.png'), image, { flag: 'wx', mode: 0o600 });
  await writeFile(join(out, 'frame.json'), JSON.stringify(report, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  const playbackBudget = report.playbackTiming?.budgetVerdict;
  console.log(
    JSON.stringify({ file: join(out, 'frame.json'), verdict: report.verdict, playbackBudget }),
  );
  if (report.verdict === 'unverified' || playbackBudget === 'unverified') process.exitCode = 3;
  if (report.verdict === 'fail' || playbackBudget === 'fail') process.exitCode = 2;
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
