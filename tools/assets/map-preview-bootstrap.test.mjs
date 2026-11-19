import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareMapJobs } from '../../backend/dist/map-jobs.js';
import { buildNetworkDeny } from './build-network-deny.mjs';
import { runMapWorker, prepareIdleMapPreview } from './map-worker.mjs';
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
test('small native artwork yields to maps, runs before sounds and rechecks newly queued maps after preparing it', async (t) => {
  const options = await fixture(t),
    controller = new AbortController(),
    sequence = [];
  let maps = 0;
  await runMapWorker(
    { ...options, signal: controller.signal },
    {
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
      refreshInventory: async () => ({ manifest: '123', maps: [{}] }),
      processRequest: async () => {
        jobs.push(clock);
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
test('idle artwork receives only fixed assets/cache/source limits and a final prepared-budget check, never application secrets', async (t) => {
  const options = await fixture(t);
  let received;
  await prepareIdleMapPreview(
    { ...options, dataDir: '/private/data', steamApiKey: 'private-fixture' },
    '123',
    {
      install: async (value) => {
        received = value;
        return { status: 'installed' };
      },
    },
  );
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
  await received.beforePublish();
  await assert.rejects(() => prepareIdleMapPreview(options, '../bad'), /uint64/);
});
