import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
  lstat,
  symlink,
  link,
  utimes,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Document, NodeIO } from '@gltf-transform/core';
import sharp from 'sharp';
import {
  canonicalMapApproval,
  mapPackId,
  latestOfficialSelection,
  latestMapRequestId,
  latestMapPackId,
} from '../../backend/dist/map-catalog.js';
import {
  enqueueMapRequest,
  prepareMapJobs,
  readMapRequest,
  readMapResult,
  writeMapJobResult,
  retryMapRequest,
  retryLatestMapRequest,
  enqueueLatestMapRequest,
  writeOfficialMapInventory,
} from '../../backend/dist/map-jobs.js';
import {
  lockMapWorker,
  cleanMapPreparations,
  mapWorkerOptions,
  processOneMapRequest,
  sourceCache,
  runMapWorker,
  mapWorkerLimits,
} from './map-worker.mjs';
import { validatePreparedMap } from './prepared-map-publication.mjs';
import { buildNetworkDeny } from './build-network-deny.mjs';
import { refreshOfficialMapInventory } from './official-map-inventory.mjs';

let boundaryRoot, networkDeny;
before(async () => {
  boundaryRoot = await mkdtemp(join(tmpdir(), 'cswatch-map-worker-kernel-'));
  networkDeny = buildNetworkDeny(join(boundaryRoot, 'asset-network-deny'));
});
after(async () => {
  if (boundaryRoot) await rm(boundaryRoot, { recursive: true, force: true });
});

const marker = '.cswatch-official-source.json';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const approval = {
  identity: {
    map: 'de_mirage',
    buildNum: 9842,
    patchVersion: 13984,
    demoVersionGuid: '8e9d71ab-04a1-4c01-bb61-acfede27c046',
    addonPresence: 'none',
  },
  source: {
    appId: 730,
    depotId: 2347770,
    manifest: '807392217824910805',
    mapSha256: 'a'.repeat(64),
  },
  assetVersion: 'original-worker-fixture',
};
const versionOf = (entry) => entry.assetVersion || `steam-2347770-${entry.source.manifest}`;
const absent = async (path) =>
  !(await lstat(path).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  }));
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(t, entry = structuredClone(approval)) {
  const root = await mkdtemp(join(tmpdir(), 'cswatch-map-worker-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = {
    jobs: join(root, 'jobs'),
    assets: join(root, 'assets'),
    cache: join(root, 'cache'),
    catalog: join(root, 'catalog.json'),
    networkDeny,
  };
  for (const path of [options.assets, options.cache]) await mkdir(path, { mode: 0o700 });
  await prepareMapJobs(options.jobs);
  const catalog = async (entries) =>
    writeFile(options.catalog, JSON.stringify({ schemaVersion: 1, entries }), { mode: 0o600 });
  await catalog([entry]);
  assert.equal(await enqueueMapRequest(options.jobs, entry), 'queued');
  const packId = mapPackId(entry),
    target = join(options.assets, 'packs', packId);
  return { root, options, entry, packId, target, catalog };
}
let originals;
async function latestFixture(t) {
  const f = await fixture(t);
  await rm(join(f.options.jobs, 'requests', f.packId + '.json'));
  await f.catalog([]);
  const inventory = {
    schemaVersion: 1,
    appId: 730,
    depotId: 2347770,
    manifest: f.entry.source.manifest,
    updatedAt: Math.floor(Date.now() / 1000),
    maps: [{ map: f.entry.identity.map, sha1: 'b'.repeat(40), bytes: 100 }],
  };
  await writeOfficialMapInventory(f.options.jobs, inventory);
  const selection = latestOfficialSelection(inventory, f.entry.identity.map);
  await enqueueLatestMapRequest(f.options.jobs, selection);
  f.entry.assetVersion = `steam-2347770-${inventory.manifest}`;
  return {
    ...f,
    inventory,
    selection,
    packId: latestMapRequestId(selection),
    assetPackId: latestMapPackId(selection.map, f.entry.source),
  };
}

test('explicit Steam rate failures pause globally without reclassifying as unavailable source or affecting native exit 4', async (t) => {
  const f = await fixture(t);
  let limited = 0;
  const downloader = join(f.root, 'rate-limited-downloader');
  await writeFile(
    downloader,
    '#!/bin/sh\necho "Steam gave no manifest request code" >&2\nexit 4\n',
    { mode: 0o700 },
  );
  await processOneMapRequest(
    { ...f.options, onSteamRateLimit: () => limited++ },
    {
      prepareToolchain: async () => ({ downloader, s2v: '/trusted/unused-s2v' }),
      prepare: async (options, subprocess) => {
        await mkdir(options.output, { recursive: true });
        const tools = await subprocess.prepareToolchain({});
        await subprocess.run(tools.downloader, ['ls'], {
          cwd: options.output,
          home: options.output,
          temporary: options.output,
          log: join(options.output, 'private-steam.log'),
        });
      },
    },
  );
  assert.equal(limited, 1);
  assert.equal((await readMapResult(f.options.jobs, f.packId)).code, 'preparation_failed');
  const native = await fixture(t);
  let nativeLimited = 0;
  await processOneMapRequest(
    { ...native.options, onSteamRateLimit: () => nativeLimited++ },
    {
      prepare: async (options, subprocess) => {
        await mkdir(options.output, { recursive: true });
        await subprocess.run(process.execPath, ['-e', 'process.exit(4)'], {
          cwd: options.output,
          home: options.output,
          temporary: options.output,
          conversionWriteRoots: [options.output],
        });
      },
    },
  );
  assert.equal(nativeLimited, 0);
  assert.equal(
    (await readMapResult(native.options.jobs, native.packId)).code,
    'preparation_failed',
  );
});

test(
  'inventory failure heartbeat and logs retain a safe stage across retries then clear it on successful refresh',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      controller = new AbortController(),
      logs = [];
    let clock = 1000,
      attempts = 0,
      checks = 0;
    const original = await readFile(join(f.options.jobs, 'requests', f.packId + '.json'));
    const secret = 'https://private.invalid/?credential=never-log /private/operator/path';
    const failure = { phase: 'toolchain', code: 'toolchain_failed', at: 1000, retryAt: 1900 };
    await runMapWorker(
      {
        ...f.options,
        signal: AbortSignal.any([controller.signal, t.signal]),
        log: (value) => logs.push(value),
      },
      {
        now: () => clock,
        refreshInventory: (options) =>
          refreshOfficialMapInventory(options, {
            storage: async () => {},
            prepareToolchain: async () => {
              if (++attempts === 1) throw Error(secret);
              return { downloader: '/fixed/trusted/tool' };
            },
            run: async () => ({
              code: 0,
              stdout: `2347770\t42\t${'a'.repeat(40)}\t100\tgame/csgo/maps/de_ancient.vpk`,
              stderr: '',
            }),
          }),
        processRequest: async () => {
          const heartbeat = JSON.parse(
            await readFile(join(f.options.jobs, 'worker-status.json'), 'utf8'),
          );
          if (++checks === 1) assert.deepEqual(heartbeat.inventoryFailure, failure);
          else {
            assert.equal(heartbeat.inventoryFailure, undefined);
            controller.abort();
          }
          return checks > 1;
        },
        delay: async (ms) => {
          assert.equal(ms, 2000);
          clock = 1900;
        },
      },
    );
    assert.equal(attempts, 2);
    assert.deepEqual(
      logs.find((value) => value.event === 'map.inventory_unavailable'),
      { event: 'map.inventory_unavailable', ...failure },
    );
    assert.equal(JSON.stringify(logs).includes(secret), false);
    assert.equal(
      JSON.parse(await readFile(join(f.options.jobs, 'worker-status.json'), 'utf8'))
        .inventoryFailure,
      undefined,
    );
    assert.deepEqual(
      await readFile(join(f.options.jobs, 'requests', f.packId + '.json')),
      original,
    );
  },
);

test('shared Steam cooldown blocks queued work after inventory rate failure and keeps heartbeat responsive', async (t) => {
  const f = await fixture(t),
    controller = new AbortController(),
    refreshes = [],
    jobs = [],
    beats = [];
  let clock = 1000;
  const before = await readFile(join(f.options.jobs, 'requests', f.packId + '.json'));
  await runMapWorker(
    { ...f.options, signal: controller.signal },
    {
      now: () => clock,
      refreshInventory: async () => {
        refreshes.push(clock);
        if (refreshes.length === 1)
          throw Object.assign(Error('Rate limit'), { code: 'STEAM_RATE_LIMIT' });
        return { manifest: '1', maps: [{}] };
      },
      processRequest: async () => {
        jobs.push(clock);
        controller.abort();
        return true;
      },
      delay: async (ms, _value, { signal }) => {
        if (signal.aborted) throw new DOMException('Stopped', 'AbortError');
        assert.equal(jobs.length, 0);
        const status = JSON.parse(
          await readFile(join(f.options.jobs, 'worker-status.json'), 'utf8'),
        );
        assert.equal(status.status, 'idle');
        assert.equal(status.updatedAt, clock);
        beats.push(status.updatedAt);
        assert.ok(ms <= 15000 && ms > 0);
        clock += ms / 1000;
      },
    },
  );
  assert.deepEqual(refreshes, [1000, 1000 + mapWorkerLimits.steamCooldownSeconds]);
  assert.deepEqual(jobs, [1900]);
  assert.ok(beats.length >= 60);
  assert.deepEqual(await readFile(join(f.options.jobs, 'requests', f.packId + '.json')), before);
  assert.equal(
    await lockMapWorker(f.options.jobs).then(async (release) => {
      if (!release) return false;
      await release();
      return true;
    }),
    true,
  );
});

test('shared Steam cooldown from a queued job also defers an inventory refresh becoming due during the pause', async (t) => {
  const f = await fixture(t),
    controller = new AbortController(),
    refreshes = [],
    jobs = [],
    beats = [];
  let clock = 1000;
  await runMapWorker(
    { ...f.options, signal: controller.signal },
    {
      now: () => clock,
      refreshInventory: async () => {
        refreshes.push(clock);
        return { manifest: '1', maps: [{}] };
      },
      processRequest: async (options) => {
        jobs.push(clock);
        if (jobs.length === 1) {
          clock += 2600;
          return true;
        }
        if (jobs.length === 2) {
          clock += 900;
          options.onSteamRateLimit();
          return true;
        }
        controller.abort();
        return true;
      },
      delay: async (ms, _value, { signal }) => {
        if (signal.aborted) throw new DOMException('Stopped', 'AbortError');
        assert.equal(jobs.length, 2);
        assert.equal(refreshes.length, 1);
        const status = JSON.parse(
          await readFile(join(f.options.jobs, 'worker-status.json'), 'utf8'),
        );
        assert.equal(status.status, 'idle');
        assert.equal(status.updatedAt, clock);
        beats.push(clock);
        clock += ms / 1000;
      },
    },
  );
  assert.deepEqual(jobs, [1000, 3600, 5400]);
  assert.deepEqual(refreshes, [1000, 5400]);
  assert.equal(beats[0], 4500);
  assert.ok(beats.at(-1) < 5400);
  assert.ok(beats.length >= 60);
});
test('latest official source publishes a distinct content-bound immutable pack and recovers it without another conversion', async (t) => {
  const f = await latestFixture(t);
  let calls = 0;
  const prepare = async (options) => {
    calls++;
    assert.deepEqual(options.expectedMapFiles, {
      [f.selection.map]: { sha1: f.selection.sha1, bytes: f.selection.bytes },
    });
    assert.equal(options.expectedMapHashes, undefined);
    await options.onSourceVerified({ ...f.selection, mapSha256: f.entry.source.mapSha256 });
    const processing = await readMapResult(f.options.jobs, f.packId);
    assert.equal(processing.status, 'processing');
    assert.equal(processing.assetPackId, f.assetPackId);
    await originalPack(options.output, f.entry);
  };
  await processOneMapRequest(f.options, { prepare });
  const result = await readMapResult(f.options.jobs, f.packId);
  assert.equal(result.status, 'ready');
  assert.notEqual(f.packId, f.assetPackId);
  assert.equal(result.assetPackId, f.assetPackId);
  assert.deepEqual(result.source, f.entry.source);
  const target = join(f.options.assets, 'packs', f.assetPackId);
  const marker = JSON.parse(await readFile(join(target, 'pack.json')));
  assert.equal(marker.kind, 'latest-official');
  assert.equal(marker.requestId, f.packId);
  assert.equal(marker.packId, f.assetPackId);
  assert.deepEqual(marker.selection, f.selection);
  await writeMapJobResult(f.options.jobs, { ...result, status: 'processing' });
  await processOneMapRequest(f.options, { prepare });
  assert.equal(calls, 1);
  assert.equal((await readMapResult(f.options.jobs, f.packId)).status, 'ready');
  const ledger = await readFile(join(f.options.jobs, 'locks', `${f.packId}.attempts.json`), 'utf8');
  await writeMapJobResult(f.options.jobs, {
    ...result,
    status: 'failed',
    code: 'worker_interrupted',
  });
  assert.equal(
    await retryLatestMapRequest(f.options.jobs, f.selection, result.updatedAt + 301),
    'queued',
  );
  await processOneMapRequest(f.options, {
    prepare: () => assert.fail('A retry of already-published content must not reconvert.'),
  });
  assert.equal((await readMapResult(f.options.jobs, f.packId)).status, 'ready');
  assert.equal(
    await readFile(join(f.options.jobs, 'locks', `${f.packId}.attempts.json`), 'utf8'),
    ledger,
  );
});
test('latest conversion refuses absent or inconsistent source proof and removed official membership', async (t) => {
  for (const mode of ['absent', 'sha1', 'manifest', 'membership'])
    await t.test(mode, async (t) => {
      const f = await latestFixture(t);
      if (mode === 'membership')
        await writeOfficialMapInventory(f.options.jobs, {
          ...f.inventory,
          maps: [{ ...f.inventory.maps[0], map: 'de_other' }],
        });
      let calls = 0;
      await processOneMapRequest(f.options, {
        prepare: async (options) => {
          calls++;
          if (mode !== 'absent')
            await options.onSourceVerified({
              ...f.selection,
              mapSha256: f.entry.source.mapSha256,
              ...(mode === 'sha1' ? { sha1: 'c'.repeat(40) } : { manifest: '42' }),
            });
          await originalPack(options.output, f.entry);
        },
      });
      const result = await readMapResult(f.options.jobs, f.packId);
      assert.equal(result.status, 'failed');
      assert.equal(
        result.code,
        mode === 'membership'
          ? 'approval_removed'
          : mode === 'absent'
            ? 'preparation_failed'
            : 'source_mismatch',
      );
      assert.equal(calls, mode === 'membership' ? 0 : 1);
      assert.equal(await absent(join(f.options.assets, 'packs', f.assetPackId)), true);
    });
});
test('a concurrent or interrupted web atomic request never blocks another valid map job', async (t) => {
  const f = await fixture(t);
  const temporary = join(f.options.jobs, 'requests', `.${'b'.repeat(64)}-${'c'.repeat(24)}.tmp`);
  await writeFile(temporary, 'incomplete atomic web request', { mode: 0o640 });
  let calls = 0;
  assert.equal(
    await processOneMapRequest(f.options, {
      prepare: async ({ output }) => {
        calls++;
        await originalPack(output, f.entry);
      },
    }),
    true,
  );
  assert.equal(calls, 1);
  assert.equal((await readMapResult(f.options.jobs, f.packId)).status, 'ready');
  assert.equal(await readFile(temporary, 'utf8'), 'incomplete atomic web request');
});
async function originalArtifacts() {
  if (!originals)
    originals = (async () => {
      const document = new Document(),
        buffer = document.createBuffer(),
        positions = document
          .createAccessor()
          .setType('VEC3')
          .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
          .setBuffer(buffer);
      document
        .createScene()
        .addChild(
          document
            .createNode('original QA triangle')
            .setMesh(
              document
                .createMesh()
                .addPrimitive(document.createPrimitive().setAttribute('POSITION', positions)),
            ),
        );
      return {
        model: Buffer.from(await new NodeIO().writeBinary(document)),
        png: await sharp({ create: { width: 8, height: 8, channels: 4, background: '#8090a0' } })
          .png()
          .toBuffer(),
      };
    })();
  return originals;
}
/** Real complete-pack validation exercises actual GLB, PNG, calibration and hashes.
 * The fixture is original geometry/pixels, never game content or a fake validator. */
async function originalPack(output, entry) {
  const { model, png } = await originalArtifacts(),
    map = entry.identity.map,
    assetVersion = versionOf(entry);
  for (const tier of ['desktop', 'mobile']) {
    const directory = join(output, map, tier);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'scene.glb'), model);
    await writeFile(
      join(directory, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        map,
        tier,
        assetVersion,
        bytes: model.length,
        outputSha256: hash(model),
      }),
    );
  }
  const overview = join(output, 'overviews', map),
    environment = join(output, 'environments', map);
  await mkdir(overview, { recursive: true });
  await mkdir(environment, { recursive: true });
  await writeFile(join(overview, 'overview.png'), png);
  await writeFile(
    join(overview, 'overview.json'),
    JSON.stringify({
      schemaVersion: 1,
      map,
      assetVersion,
      origin: { x: 0, y: 0 },
      scale: 1,
      referenceSize: 1024,
      imageSha256: hash(png),
    }),
  );
  await writeFile(join(overview, 'provenance.json'), '{}');
  const faces = {};
  for (const face of ['px', 'nx', 'py', 'ny', 'pz', 'nz']) {
    await writeFile(join(environment, `${face}.png`), png);
    faces[face] = hash(png);
  }
  await writeFile(
    join(environment, 'environment.json'),
    JSON.stringify({
      schemaVersion: 1,
      map,
      assetVersion,
      source: 'Original worker QA pixels',
      landscape: false,
      sky: { brightness: 1, faces },
    }),
  );
  await writeFile(join(environment, 'provenance.json'), '{}');
}
async function writePackMarker(f) {
  await writeFile(
    join(f.target, 'pack.json'),
    JSON.stringify({
      schemaVersion: 1,
      packId: f.packId,
      approval: canonicalMapApproval(f.entry),
      preparedAt: 1,
    }),
  );
}
async function noPartialPack(f) {
  assert.equal(
    await absent(f.target),
    true,
    'failed work must never appear at the immutable pack URL',
  );
  const packs = await readdir(join(f.options.assets, 'packs')).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  assert.deepEqual(packs, [], 'private preparation staging must be reclaimed');
}

test('worker passes exact approved provenance and publishes a complete immutable pack only after real validation', async (t) => {
  const f = await fixture(t),
    started = deferred(),
    finish = deferred();
  let calls = 0;
  const job = processOneMapRequest(f.options, {
    prepare: async (options) => {
      calls++;
      assert.deepEqual(options.maps, [f.entry.identity.map]);
      assert.equal(options.manifest, f.entry.source.manifest);
      assert.deepEqual(options.expectedMapHashes, {
        [f.entry.identity.map]: f.entry.source.mapSha256,
      });
      assert.equal(options.assetVersion, f.entry.assetVersion);
      assert.equal(
        options.cache,
        join(f.options.cache, 'sources', `steam-${f.entry.source.manifest}`),
      );
      assert.equal(options.signal.aborted, false);
      assert.ok(
        options.output.startsWith(join(f.options.assets, 'packs', `.preparing-${f.packId}-`)),
      );
      await mkdir(join(options.output, f.entry.identity.map, 'desktop'), { recursive: true });
      await writeFile(
        join(options.output, f.entry.identity.map, 'desktop/scene.glb'),
        'incomplete private conversion',
      );
      started.resolve();
      await finish.promise;
      await originalPack(options.output, f.entry);
    },
  });
  try {
    await Promise.race([
      started.promise,
      job.then(() => {
        throw Error('Worker returned before reaching the private preparation gate.');
      }),
    ]);
    assert.equal((await readMapResult(f.options.jobs, f.packId)).status, 'processing');
    assert.equal(await absent(f.target), true);
    finish.resolve();
    assert.equal(await job, true);
  } finally {
    finish.resolve();
    await job;
  }
  const result = await readMapResult(f.options.jobs, f.packId);
  assert.equal(result.status, 'ready');
  assert.equal(result.code, undefined);
  assert.equal(calls, 1);
  const markerData = JSON.parse(await readFile(join(f.target, 'pack.json'), 'utf8'));
  assert.equal(markerData.packId, f.packId);
  assert.equal(markerData.approval, canonicalMapApproval(f.entry));
  assert.ok(
    (await validatePreparedMap(join(f.target, 'maps'), f.entry.identity.map, versionOf(f.entry)))
      .length >= 15,
  );
  const before = await lstat(f.target),
    model = await readFile(join(f.target, 'maps', f.entry.identity.map, 'desktop/scene.glb'));
  assert.equal(
    await processOneMapRequest(f.options, {
      prepare: () => {
        throw Error('ready packs must not convert again');
      },
    }),
    false,
  );
  assert.equal((await lstat(f.target)).ino, before.ino);
  assert.deepEqual(
    await readFile(join(f.target, 'maps', f.entry.identity.map, 'desktop/scene.glb')),
    model,
  );
  assert.equal(
    JSON.parse(await readFile(join(f.options.jobs, 'worker-status.json'), 'utf8')).status,
    'idle',
  );
});

test('real output validation rejects missing tiers and changed cube pixels without a partial ready pack', async (t) => {
  for (const corruption of ['missing-mobile', 'changed-sky'])
    await t.test(corruption, async (t) => {
      const f = await fixture(t);
      assert.equal(
        await processOneMapRequest(f.options, {
          prepare: async (options) => {
            await originalPack(options.output, f.entry);
            if (corruption === 'missing-mobile')
              await rm(join(options.output, f.entry.identity.map, 'mobile'), { recursive: true });
            else
              await writeFile(
                join(options.output, 'environments', f.entry.identity.map, 'px.png'),
                Buffer.from('not the approved original PNG'),
              );
          },
        }),
        true,
      );
      assert.equal((await readMapResult(f.options.jobs, f.packId)).code, 'preparation_failed');
      await noPartialPack(f);
    });
});

test('current approval is checked before conversion and again after preparation', async (t) => {
  for (const phase of ['before', 'after', 'source-replaced', 'between-conversion-stages'])
    await t.test(phase, async (t) => {
      const f = await fixture(t);
      let calls = 0;
      if (phase === 'before') await f.catalog([]);
      assert.equal(
        await processOneMapRequest(f.options, {
          prepare: async (options, subprocess) => {
            calls++;
            await originalPack(options.output, f.entry);
            await f.catalog(
              phase === 'source-replaced'
                ? [
                    {
                      ...f.entry,
                      source: { ...f.entry.source, manifest: '123', mapSha256: 'b'.repeat(64) },
                    },
                  ]
                : [],
            );
            if (phase === 'between-conversion-stages')
              await subprocess.run('unapproved-command-must-never-run', [], {});
          },
        }),
        true,
      );
      assert.equal(calls, phase === 'before' ? 0 : 1);
      assert.equal((await readMapResult(f.options.jobs, f.packId)).code, 'approval_removed');
      await noPartialPack(f);
    });
});

test('failure codes and cancellation are durable and never expose incomplete output', async (t) => {
  const failures = [
    [
      'source_mismatch',
      () => Object.assign(Error('Selected map hash differs'), { code: 'SOURCE_MAP_MISMATCH' }),
    ],
    ['source_unavailable', () => Error('Steam gave no manifest request code')],
    [
      'storage_limit',
      () => Object.assign(Error('Operator storage limit reached'), { code: 'ASSET_STORAGE_LIMIT' }),
    ],
    ['preparation_failed', () => Error('Original controlled conversion failure')],
    [
      'worker_interrupted',
      (controller) => {
        controller.abort();
        return new DOMException('Cancelled', 'AbortError');
      },
    ],
  ];
  for (const [code, error] of failures)
    await t.test(code, async (t) => {
      const f = await fixture(t),
        controller = new AbortController();
      assert.equal(
        await processOneMapRequest(
          { ...f.options, signal: controller.signal },
          {
            prepare: async (options) => {
              await mkdir(options.output, { recursive: true });
              await writeFile(
                join(options.output, 'private-partial.bin'),
                'original partial QA bytes',
              );
              throw error(controller);
            },
          },
        ),
        true,
      );
      const result = await readMapResult(f.options.jobs, f.packId);
      assert.equal(result.status, 'failed');
      assert.equal(result.code, code);
      await noPartialPack(f);
    });
});

test('processing recovery validates an already-published pack and never overwrites it or reconverts', async (t) => {
  const entry = structuredClone(approval);
  delete entry.assetVersion;
  const f = await fixture(t, entry);
  await originalPack(join(f.target, 'maps'), f.entry);
  await writePackMarker(f);
  await writeMapJobResult(f.options.jobs, {
    schemaVersion: 1,
    packId: f.packId,
    status: 'processing',
    updatedAt: 1,
  });
  const before = await lstat(f.target);
  let calls = 0;
  assert.equal(
    await processOneMapRequest(f.options, {
      prepare: () => {
        calls++;
        throw Error('must reuse validated publication');
      },
    }),
    true,
  );
  assert.equal(calls, 0);
  assert.equal((await readMapResult(f.options.jobs, f.packId)).status, 'ready');
  assert.equal((await lstat(f.target)).ino, before.ino);
  assert.ok(
    (await validatePreparedMap(join(f.target, 'maps'), f.entry.identity.map, versionOf(f.entry)))
      .length >= 15,
  );
});

test('a pre-existing incomplete immutable pack is never repaired in place or marked ready', async (t) => {
  const f = await fixture(t);
  await mkdir(f.target, { recursive: true });
  await writePackMarker(f);
  const sentinel = join(f.target, 'operator-original.txt');
  await writeFile(sentinel, 'preserve me');
  let calls = 0;
  assert.equal(
    await processOneMapRequest(f.options, {
      prepare: () => {
        calls++;
        throw Error('must not overwrite');
      },
    }),
    true,
  );
  assert.equal(calls, 0);
  assert.equal((await readMapResult(f.options.jobs, f.packId)).code, 'preparation_failed');
  assert.equal(await readFile(sentinel, 'utf8'), 'preserve me');
});

test('malformed, linked and path-bearing queued requests never reach conversion', async (t) => {
  const changes = [
    (value) => {
      value.packId = 'b'.repeat(64);
    },
    (value) => {
      value.approval.identity.map = '../../outside';
    },
    (value) => {
      value.approval.source.manifest = '../../outside';
    },
    (value) => {
      value.approval.source.depotId = 999;
    },
    (value) => {
      value.approval.source.url = 'https://untrusted.invalid/game';
    },
    (value) => {
      value.output = '/outside';
    },
  ];
  for (const [index, change] of changes.entries())
    await t.test(`invalid request ${index + 1}`, async (t) => {
      const f = await fixture(t),
        file = join(f.options.jobs, 'requests', `${f.packId}.json`),
        value = JSON.parse(await readFile(file, 'utf8'));
      change(value);
      await writeFile(file, JSON.stringify(value));
      let calls = 0;
      assert.equal(
        await processOneMapRequest(f.options, {
          prepare: () => {
            calls++;
            throw Error('untrusted request converted');
          },
        }),
        false,
      );
      assert.equal(calls, 0);
      assert.equal(await readMapRequest(f.options.jobs, f.packId), undefined);
      assert.equal(await readMapResult(f.options.jobs, f.packId), undefined);
      assert.equal(await absent(f.target), true);
    });
  for (const kind of ['symlink', 'hardlink'])
    await t.test(kind, async (t) => {
      const f = await fixture(t),
        file = join(f.options.jobs, 'requests', `${f.packId}.json`),
        outside = join(f.root, 'untrusted.json');
      await writeFile(outside, await readFile(file));
      await rm(file);
      if (kind === 'symlink') await symlink(outside, file);
      else await link(outside, file);
      let calls = 0;
      assert.equal(
        await processOneMapRequest(f.options, {
          prepare: () => {
            calls++;
          },
        }),
        false,
      );
      assert.equal(calls, 0);
      assert.equal(await readMapResult(f.options.jobs, f.packId), undefined);
    });
});

test('source cache cleanup removes only older exact owned markers, preserving operator folders and published packs', async (t) => {
  const f = await fixture(t),
    sources = join(f.options.cache, 'sources');
  await mkdir(sources);
  const owned = async (manifest, stamp) => {
    const path = join(sources, `steam-${manifest}`);
    await mkdir(path);
    const file = join(path, marker);
    await writeFile(
      file,
      JSON.stringify({ schemaVersion: 1, appId: 730, depotId: 2347770, manifest }),
    );
    await writeFile(join(path, 'source.bin'), 'original cached bytes');
    await utimes(file, stamp, stamp);
    return path;
  };
  const oldest = await owned('11', 1),
    older = await owned('22', 2),
    newest = await owned('33', 3);
  const unmarked = join(sources, 'steam-55'),
    foreign = join(sources, 'steam-66');
  await mkdir(unmarked);
  await mkdir(foreign);
  await writeFile(join(unmarked, 'operator.txt'), 'never claim/delete');
  await writeFile(
    join(foreign, marker),
    JSON.stringify({ schemaVersion: 1, appId: 999, depotId: 2347770, manifest: '66' }),
  );
  await mkdir(f.target, { recursive: true });
  await writeFile(join(f.target, 'operator.txt'), 'published bytes');
  assert.equal(await sourceCache(f.options, '44'), join(sources, 'steam-44'));
  assert.equal(await absent(oldest), true);
  assert.equal(await absent(older), true);
  assert.equal(await absent(newest), false);
  assert.equal(await readFile(join(unmarked, 'operator.txt'), 'utf8'), 'never claim/delete');
  assert.equal(await absent(foreign), false);
  assert.equal(await readFile(join(f.target, 'operator.txt'), 'utf8'), 'published bytes');
});

test('source cache rejects unsafe manifest paths and never adopts an existing unmarked operator directory', async (t) => {
  for (const manifest of ['../escape', '1/../../escape', '0', '18446744073709551616'])
    await t.test(manifest, async (t) => {
      const f = await fixture(t);
      await assert.rejects(sourceCache(f.options, manifest));
      assert.deepEqual(await readdir(f.options.cache), []);
    });
  const f = await fixture(t),
    directory = join(f.options.cache, 'sources', 'steam-44');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'operator.txt'), 'unclaimed source');
  await assert.rejects(sourceCache(f.options, '44'));
  assert.equal(await absent(join(directory, marker)), true);
  assert.equal(await readFile(join(directory, 'operator.txt'), 'utf8'), 'unclaimed source');
});

test('worker configuration rejects overlapping state/cache/assets roots', () => {
  for (const env of [
    { MAP_JOBS_DIR: '/same', MAP_CACHE_DIR: '/same', MAP_ASSETS_DIR: '/assets' },
    { MAP_JOBS_DIR: '/jobs', MAP_CACHE_DIR: '/assets/cache', MAP_ASSETS_DIR: '/assets' },
    { MAP_JOBS_DIR: '/jobs/assets', MAP_CACHE_DIR: '/cache', MAP_ASSETS_DIR: '/jobs' },
    { MAP_JOBS_DIR: '/', MAP_CACHE_DIR: '/cache', MAP_ASSETS_DIR: '/assets' },
  ])
    assert.throws(() => mapWorkerOptions(env), /separate/);
});

const flockAvailable =
  process.platform === 'linux' &&
  spawnSync('flock', ['--version'], { stdio: 'ignore', timeout: 5000 }).status === 0;
test(
  'flock-held recovery removes only exact owned interrupted stages before rebuilding a processing request',
  { skip: flockAvailable ? false : 'Linux flock is unavailable' },
  async (t) => {
    const f = await fixture(t),
      packs = join(f.options.assets, 'packs');
    await mkdir(packs);
    const owned = await mkdtemp(join(packs, `.preparing-${f.packId}-`)),
      unmarked = await mkdtemp(join(packs, `.preparing-${f.packId}-`)),
      foreign = await mkdtemp(join(packs, `.preparing-${f.packId}-`));
    const content = JSON.stringify({
      schemaVersion: 1,
      packId: f.packId,
      kind: 'cswatch-official-map-preparation',
    });
    await writeFile(join(owned, '.preparation.json'), content);
    await writeFile(join(owned, 'interrupted.bin'), 'original incomplete conversion');
    await writeFile(join(unmarked, 'operator.txt'), 'never delete without marker');
    await writeFile(join(foreign, '.preparation.json'), content.replace(f.packId, 'b'.repeat(64)));
    const outside = join(f.root, 'operator-outside');
    await mkdir(outside);
    await writeFile(join(outside, 'operator.txt'), 'preserve symlink target');
    const linked = join(packs, `.preparing-${f.packId}-ABC123`);
    await symlink(outside, linked);
    const published = join(packs, 'c'.repeat(64));
    await mkdir(published);
    await writeFile(join(published, 'operator.txt'), 'immutable published bytes');
    await writeMapJobResult(f.options.jobs, {
      schemaVersion: 1,
      packId: f.packId,
      status: 'processing',
      updatedAt: 1,
    });
    const release = await lockMapWorker(f.options.jobs);
    assert.equal(typeof release, 'function');
    try {
      await cleanMapPreparations(f.options);
      assert.equal(await absent(owned), true);
      assert.equal(await absent(unmarked), false);
      assert.equal(await absent(foreign), false);
      assert.equal((await lstat(linked)).isSymbolicLink(), true);
      assert.equal(
        await readFile(join(outside, 'operator.txt'), 'utf8'),
        'preserve symlink target',
      );
      assert.equal(
        await readFile(join(published, 'operator.txt'), 'utf8'),
        'immutable published bytes',
      );
      // Remove only this test's known probe link so the normal cache/storage
      // walk can enforce its independent no-symlink rule for conversion.
      await rm(linked);
      let calls = 0;
      assert.equal(
        await processOneMapRequest(f.options, {
          prepare: async (options) => {
            calls++;
            await originalPack(options.output, f.entry);
          },
        }),
        true,
      );
      assert.equal(calls, 1);
      assert.equal((await readMapResult(f.options.jobs, f.packId)).status, 'ready');
      assert.equal(
        await readFile(join(unmarked, 'operator.txt'), 'utf8'),
        'never delete without marker',
      );
    } finally {
      await release();
    }
  },
);
test(
  'real inherited-description flock excludes other workers and releases after close and process death',
  { skip: flockAvailable ? false : 'Linux flock is unavailable', timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    let release = await lockMapWorker(f.options.jobs),
      child;
    assert.equal(typeof release, 'function');
    try {
      assert.equal(
        await lockMapWorker(f.options.jobs),
        undefined,
        'flock child exit must not release the parent-held open-file description',
      );
      await release();
      release = undefined;
      const moduleUrl = new URL('./map-worker.mjs', import.meta.url).href;
      child = spawn(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import {lockMapWorker} from ${JSON.stringify(moduleUrl)}; const release=await lockMapWorker(${JSON.stringify(f.options.jobs)}); if(!release)process.exit(2); process.stdout.write('locked'); setInterval(()=>{},1000);`,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const locked = await Promise.race([
        once(child.stdout, 'data').then(([data]) => data.toString()),
        once(child, 'exit').then(([code]) => {
          throw Error(`Lock holder exited before readiness (${code})`);
        }),
      ]);
      assert.match(locked, /locked/);
      assert.equal(
        await lockMapWorker(f.options.jobs),
        undefined,
        'another OS process must exclude this process',
      );
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
      child = undefined;
      release = await lockMapWorker(f.options.jobs);
      assert.equal(typeof release, 'function', 'kernel must release the lock after holder death');
    } finally {
      if (child) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
      await release?.();
    }
  },
);

test('durable crash attempts stop repeated conversion and a cooled authorized retry starts a new generation', async (t) => {
  const f = await fixture(t);
  const initial = await readMapRequest(f.options.jobs, f.packId);
  let preparations = 0;
  const failedConversion = {
    prepare: async () => {
      preparations++;
      throw Error('Synthetic interrupted conversion.');
    },
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    // A killed worker leaves this durable processing state instead of entering catch.
    await writeMapJobResult(f.options.jobs, {
      schemaVersion: 1,
      packId: f.packId,
      status: 'processing',
      updatedAt: Math.floor(Date.now() / 1000),
    });
    assert.equal(await processOneMapRequest(f.options, failedConversion), true);
  }
  await writeMapJobResult(f.options.jobs, {
    schemaVersion: 1,
    packId: f.packId,
    status: 'processing',
    updatedAt: Math.floor(Date.now() / 1000),
  });
  await processOneMapRequest(f.options, failedConversion);
  assert.equal(preparations, 3, 'a fourth restart must not run a doomed converter again');
  assert.equal((await readMapResult(f.options.jobs, f.packId)).code, 'worker_interrupted');
  await writeMapJobResult(f.options.jobs, {
    schemaVersion: 1,
    packId: f.packId,
    status: 'failed',
    code: 'worker_interrupted',
    updatedAt: Math.floor(Date.now() / 1000) - 301,
  });
  assert.equal(await retryMapRequest(f.options.jobs, f.entry), 'queued');
  const renewed = await readMapRequest(f.options.jobs, f.packId);
  assert.notEqual(renewed.generation, initial.generation);
  assert.equal(renewed.packId, initial.packId);
  await processOneMapRequest(f.options, failedConversion);
  assert.equal(preparations, 4, 'the explicit new generation gets a fresh bounded attempt');
});
