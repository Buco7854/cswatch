import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  statfs,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareMapJobs } from '../../backend/dist/map-jobs.js';
import { buildNetworkDeny } from './build-network-deny.mjs';
import { runMapWorker, prepareIdleMapPreview, mapPreviewInstallOptions } from './map-worker.mjs';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cswatch-preview-bootstrap-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = {
    jobs: join(root, 'jobs'),
    cache: join(root, 'cache'),
    assets: join(root, 'assets'),
    catalog: join(root, 'catalog.json'),
    networkDeny: buildNetworkDeny(join(root, 'boundary')),
  };
  for (const path of [options.cache, options.assets]) await mkdir(path);
  await prepareMapJobs(options.jobs);
  return options;
}
test('actors, HUD icons, artwork and sounds precede alternating static and first-person models, which yield to queued maps', async (t) => {
  const options = await fixture(t),
    controller = new AbortController(),
    sequence = [];
  let maps = 0,
    models = 0,
    rigs = 0;
  await runMapWorker(
    { ...options, signal: controller.signal },
    {
      refreshInventory: async () => ({ manifest: '1', maps: [{}] }),
      processRequest: async () => {
        sequence.push('map');
        if (++maps === 9) controller.abort();
        return false;
      },
      preparePresentation: async (_options, manifest, kind) => {
        assert.equal(manifest, '1');
        sequence.push(
          kind === 'equipment-models'
            ? `model${++models}`
            : kind === 'viewmodels'
              ? `rig${++rigs}`
              : kind,
        );
        return {
          status: 'prepared',
          remaining:
            (kind === 'equipment-models' && models < 2) || (kind === 'viewmodels' && rigs < 2),
        };
      },
      preparePreview: async () => {
        sequence.push('preview');
      },
      prepareSounds: async () => {
        sequence.push('sounds');
      },
      delay: async () => {},
    },
  );
  assert.deepEqual(sequence, [
    'map',
    'agents',
    'map',
    'equipment',
    'map',
    'preview',
    'map',
    'sounds',
    'map',
    'model1',
    'map',
    'rig1',
    'map',
    'model2',
    'map',
    'rig2',
    'map',
  ]);
});
test('a transient native failure preserves its retry backoff while other presentation categories can publish', async (t) => {
  const options = await fixture(t),
    controller = new AbortController();
  let clock = 1000,
    maps = 0,
    agentAttempts = 0;
  const attempts = [];
  await runMapWorker(
    { ...options, signal: controller.signal },
    {
      now: () => clock,
      refreshInventory: async () => ({ manifest: '1', maps: [{}] }),
      processRequest: async () => {
        if (++maps > 170) throw Error('Native idle fixture exceeded the retry window.');
        return false;
      },
      preparePresentation: async (_options, _manifest, kind) => {
        attempts.push([kind, clock]);
        if (kind !== 'agents') return { status: 'installed' };
        if (++agentAttempts === 1) throw Error('original transient fixture failure');
        controller.abort();
        return { status: 'installed' };
      },
      preparePreview: async () => ({ status: 'installed' }),
      prepareSounds: async () => ({ status: 'installed' }),
      delay: async (milliseconds) => {
        assert.ok(milliseconds > 0 && milliseconds <= 2000);
        const state = JSON.parse(await readFile(join(options.jobs, 'worker-status.json'), 'utf8'));
        assert.equal(state.updatedAt, clock);
        clock += milliseconds / 1000;
      },
    },
  );
  assert.deepEqual(attempts, [
    ['agents', 1000],
    ['equipment', 1000],
    ['equipment-models', 1002],
    ['viewmodels', 1002],
    ['agents', 1300],
  ]);
  assert.ok(maps >= 150);
});
test('small native artwork yields to maps, runs before sounds and rechecks newly queued maps after preparing it', async (t) => {
  const options = await fixture(t),
    controller = new AbortController(),
    sequence = [];
  let maps = 0;
  await runMapWorker(
    { ...options, signal: controller.signal },
    {
      preparePresentation: async () => ({ status: 'installed' }),
      refreshInventory: async () => ({ manifest: '123', maps: [{}] }),
      processRequest: async () => {
        maps++;
        sequence.push('map');
        if (maps === 5) controller.abort();
        return [1, 3, 5].includes(maps);
      },
      preparePreview: async (_options, manifest) => {
        assert.equal(manifest, '123');
        assert.equal(maps, 2);
        sequence.push('preview');
        return { status: 'prepared' };
      },
      prepareSounds: async () => {
        sequence.push('sound');
        return { status: 'installed' };
      },
      delay: async () => {},
    },
  );
  assert.deepEqual(sequence, ['map', 'map', 'preview', 'map', 'map', 'sound', 'map']);
  assert.deepEqual(await readdir(join(options.jobs, 'results')), []);
});
test('preview Steam rate limit blocks both sound and map acquisition until the shared cooldown while heartbeat continues', async (t) => {
  const options = await fixture(t),
    controller = new AbortController(),
    jobs = [],
    beats = [];
  let clock = 1000,
    previews = 0,
    sounds = 0;
  await runMapWorker(
    { ...options, signal: controller.signal },
    {
      now: () => clock,
      preparePresentation: async () => ({ status: 'installed' }),
      refreshInventory: async () => ({ manifest: '123', maps: [{}] }),
      processRequest: async () => {
        jobs.push(clock);
        if (jobs.length > 8) {
          controller.abort();
          throw Error('Artwork cooldown fixture never reached its bounded recovery turn.');
        }
        return false;
      },
      preparePreview: async () => {
        previews++;
        throw Object.assign(Error('Steam rate limited'), { code: 'STEAM_RATE_LIMIT' });
      },
      prepareSounds: async () => {
        sounds++;
        assert.equal(clock, 1900);
        controller.abort();
        return { status: 'installed' };
      },
      delay: async (ms) => {
        if (ms === 2000) return;
        assert.ok(ms > 0 && ms <= 15000);
        assert.equal(sounds, 0);
        const state = JSON.parse(await readFile(join(options.jobs, 'worker-status.json'), 'utf8'));
        assert.equal(state.status, 'idle');
        assert.equal(state.updatedAt, clock);
        beats.push(clock);
        clock += ms / 1000;
      },
    },
  );
  assert.equal(previews, 1);
  assert.equal(sounds, 1);
  assert.deepEqual(jobs, [1000, 1900]);
  assert.ok(beats.length >= 60);
});
test('preview source-integrity failure remains terminal across inventory refresh and never mutates map result state', async (t) => {
  const options = await fixture(t),
    controller = new AbortController(),
    logs = [];
  let clock = 1000,
    maps = 0,
    previews = 0,
    refreshes = 0;
  await runMapWorker(
    { ...options, signal: controller.signal, log: (value) => logs.push(value) },
    {
      now: () => clock,
      preparePresentation: async () => ({ status: 'installed' }),
      refreshInventory: async () => {
        refreshes++;
        return { manifest: String(refreshes), maps: [{}] };
      },
      processRequest: async () => {
        if (++maps === 5) controller.abort();
        return false;
      },
      preparePreview: async () => {
        previews++;
        throw Object.assign(Error('Untrusted native diagnostics'), { code: 'SOURCE_MAP_MISMATCH' });
      },
      prepareSounds: async () => ({ status: 'installed' }),
      delay: async () => {
        clock += 3600;
      },
    },
  );
  assert.equal(previews, 1);
  assert.ok(refreshes >= 2);
  assert.deepEqual(
    logs.find((value) => value.event === 'preview.failed'),
    { event: 'preview.failed', code: 'source_mismatch' },
  );
  assert.equal(JSON.stringify(logs).includes('Untrusted native diagnostics'), false);
  assert.deepEqual(await readdir(join(options.jobs, 'results')), []);
});
test('idle artwork options exclude application secrets and real storage guards precede install/publication', async (t) => {
  const options = await fixture(t);
  let received;
  const disks = await Promise.all([options.cache, options.assets].map((path) => statfs(path)));
  const lowDisk = disks.some((disk) => disk.bavail * disk.bsize < 512 * 1024 ** 2);
  const preparation = prepareIdleMapPreview(
    { ...options, dataDir: '/private/data', steamApiKey: 'private-fixture' },
    '123',
    {
      install: async (value) => {
        received = value;
        return { status: 'installed' };
      },
    },
  );
  if (lowDisk) {
    await assert.rejects(preparation, /512 MiB reserve/);
    assert.equal(received, undefined, 'A failed admission must never invoke the installer.');
    received = mapPreviewInstallOptions(
      { ...options, dataDir: '/private/data', steamApiKey: 'private-fixture' },
      '123',
      new AbortController().signal,
    );
  } else await preparation;
  assert.deepEqual(
    Object.keys(received).sort(),
    [
      'cache',
      'output',
      'manifest',
      'networkDeny',
      'signal',
      'toolchainCache',
      'beforePublish',
    ].sort(),
  );
  assert.equal(received.manifest, '123');
  assert.ok(received.cache.startsWith(options.cache + '/sources/steam-123'));
  assert.equal(received.output, options.assets);
  assert.equal(received.toolchainCache, join(options.cache, 'tools'));
  assert.equal(typeof received.beforePublish, 'function');
  if (lowDisk) await assert.rejects(received.beforePublish(), /512 MiB reserve/);
  else await received.beforePublish();
  await assert.rejects(() => prepareIdleMapPreview(options, '../bad'), /uint64/);
});
test('default worker inventory admission rejects unsafe source storage before any tool preparation', async (t) => {
  const options = await fixture(t),
    controller = new AbortController(),
    events = [];
  const outside = join(options.assets, 'operator.txt');
  await writeFile(outside, 'operator sentinel');
  await symlink(outside, join(options.cache, 'unsafe-source'));
  let maps = 0;
  await runMapWorker(
    { ...options, signal: controller.signal, log: (event) => events.push(event) },
    {
      processRequest: async () => {
        maps++;
        controller.abort();
        return false;
      },
      delay: async () => {},
    },
  );
  assert.equal(maps, 1);
  assert.equal(
    events.some((event) => event.event === 'map.toolchain_preparing'),
    false,
  );
  assert.equal(
    events.find((event) => event.event === 'map.inventory_unavailable')?.phase,
    'storage',
  );
  assert.equal(await readFile(outside, 'utf8'), 'operator sentinel');
});
