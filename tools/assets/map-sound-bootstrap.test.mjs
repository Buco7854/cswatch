import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareMapJobs } from '../../backend/dist/map-jobs.js';
import { buildNetworkDeny } from './build-network-deny.mjs';
import { runMapWorker, prepareIdleGameplaySounds } from './map-worker.mjs';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cswatch-sound-bootstrap-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = {
    jobs: join(root, 'jobs'),
    cache: join(root, 'cache'),
    assets: join(root, 'assets'),
    catalog: join(root, 'catalog.json'),
    networkDeny: buildNetworkDeny(join(root, 'boundary')),
  };
  for (const path of [options.assets, options.cache]) await mkdir(path);
  await prepareMapJobs(options.jobs);
  return options;
}

test('fixed sound bootstrap yields to queued maps and its integrity failure never changes a map result', async (t) => {
  const options = await fixture(t),
    controller = new AbortController(),
    sequence = [],
    logs = [];
  let calls = 0;
  await runMapWorker(
    { ...options, signal: controller.signal, log: (value) => logs.push(value) },
    {
      refreshInventory: async () => ({ manifest: '42', maps: [{}] }),
      processRequest: async () => {
        sequence.push('map');
        calls++;
        if (calls === 4) controller.abort();
        return calls === 1;
      },
      preparePresentation: async () => ({ status: 'installed' }),
      preparePreview: async () => ({ status: 'installed' }),
      prepareEffects: async () => ({ status: 'installed' }),
      prepareSounds: async (_options, manifest) => {
        assert.equal(manifest, '42');
        sequence.push('sound');
        throw Object.assign(Error('Raw converter text must remain private'), {
          code: 'SOURCE_MAP_MISMATCH',
        });
      },
      delay: async () => {},
    },
  );
  assert.deepEqual(sequence, ['map', 'map', 'map', 'sound', 'map']);
  assert.deepEqual(
    logs.find((x) => x.event === 'sound.failed'),
    { event: 'sound.failed', code: 'source_mismatch' },
  );
  assert.equal(
    logs.some((x) => JSON.stringify(x).includes('Raw converter')),
    false,
  );
});

test('audio Steam rate limits share the worker cooldown while heartbeats and queued-map admission remain correct', async (t) => {
  const options = await fixture(t),
    controller = new AbortController(),
    jobs = [],
    beats = [];
  let clock = 1000,
    sounds = 0;
  await runMapWorker(
    { ...options, signal: controller.signal },
    {
      now: () => clock,
      refreshInventory: async () => ({ manifest: '42', maps: [{}] }),
      processRequest: async () => {
        jobs.push(clock);
        if (jobs.length === 3) controller.abort();
        return false;
      },
      preparePresentation: async () => ({ status: 'installed' }),
      preparePreview: async () => ({ status: 'installed' }),
      prepareEffects: async () => ({ status: 'installed' }),
      prepareSounds: async () => {
        sounds++;
        throw Object.assign(Error('Steam rate limit'), { code: 'STEAM_RATE_LIMIT' });
      },
      delay: async (ms) => {
        if (ms === 2000) return;
        assert.ok(ms > 0 && ms <= 15000);
        const status = JSON.parse(await readFile(join(options.jobs, 'worker-status.json')));
        assert.equal(status.status, 'idle');
        beats.push(status.updatedAt);
        clock += ms / 1000;
      },
    },
  );
  assert.deepEqual(jobs, [1000, 1000, 1900]);
  assert.equal(sounds, 1);
  assert.ok(beats.length >= 60);
});

test('idle sound acquisition passes only bounded asset roots and fixed manifest, never application credentials', async (t) => {
  const options = await fixture(t);
  let received;
  await prepareIdleGameplaySounds(
    { ...options, dataDir: '/private/application', steamApiKey: 'private-provider-fixture' },
    '42',
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
      'manifest',
      'managed',
      'networkDeny',
      'output',
      'signal',
      'toolchainCache',
      'beforePublish',
    ].sort(),
  );
  assert.equal(received.manifest, '42');
  assert.equal(received.managed, true);
  assert.equal(received.output, options.assets);
  assert.equal(received.networkDeny, options.networkDeny);
  assert.equal(received.toolchainCache, join(options.cache, 'tools'));
  assert.ok(received.cache.startsWith(options.cache + '/sources/steam-42'));
  assert.equal(received.signal.aborted, false);
  assert.equal(typeof received.beforePublish, 'function');
  await received.beforePublish();
  await assert.rejects(() => prepareIdleGameplaySounds(options, '../source'), /uint64/);
});
