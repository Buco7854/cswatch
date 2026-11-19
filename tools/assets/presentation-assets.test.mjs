import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
  symlink,
  rename,
  lstat,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Document, NodeIO } from '@gltf-transform/core';
import { buildNetworkDeny } from './build-network-deny.mjs';
import { installPresentationAssets } from './install-presentation-assets.mjs';
import { equipmentIconSources } from './install-equipment-icons.mjs';
import { agentRolesForIndex } from './install-equipment-models.mjs';
import { agentAnimationRegistry, agentAnimationRoles } from './agent-animation-registry.mjs';
import {
  cleanPresentationStages,
  registerPresentationStage,
  presentationStageIdentity,
} from './presentation-stages.mjs';
import {
  readPresentationStatus,
  writePresentationStatus,
  presentationStatusSchema,
  enqueuePresentationRetry,
  consumePresentationRetries,
  presentationCatalogComplete,
  cleanupPresentationRetryTemps,
} from '../../backend/dist/presentation-assets.js';
import { prepareMapJobs } from '../../backend/dist/map-jobs.js';
import { runMapWorker } from './map-worker.mjs';

let boundaryRoot, boundary;
before(async () => {
  boundaryRoot = await mkdtemp(join(tmpdir(), 'cswatch-native-boundary-'));
  boundary = buildNetworkDeny(join(boundaryRoot, 'boundary'));
});
after(async () => {
  await rm(boundaryRoot, { recursive: true, force: true });
});
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cswatch-native-banks-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = {
    assets: join(root, 'assets'),
    jobs: join(root, 'jobs'),
    cacheRoot: join(root, 'cache'),
    cache: join(root, 'cache/sources/steam-1'),
    networkDeny: boundary,
  };
  for (const path of [options.assets, options.cache])
    await mkdir(path, { recursive: true, mode: 0o700 });
  await prepareMapJobs(options.jobs);
  return { root, options, stageOptions: { ...options, cache: options.cacheRoot } };
}
const noStorage = async () => {};
const adapters = { storage: noStorage, reserve: noStorage };
async function triangle() {
  const document = new Document(),
    buffer = document.createBuffer();
  const positions = document
    .createAccessor()
    .setType('VEC3')
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
    .setBuffer(buffer);
  document
    .createScene()
    .addChild(
      document
        .createNode()
        .setMesh(
          document
            .createMesh()
            .addPrimitive(document.createPrimitive().setAttribute('POSITION', positions)),
        ),
    );
  return Buffer.from(await new NodeIO().writeBinary(document));
}
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function preparedModel(output, id, agent = false) {
  const directory = agent ? join(output, 'agents') : join(output, 'equipment-models', id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const bytes = await triangle();
  const metadata = {
    schemaVersion: 1,
    ...(agent ? { team: id } : { id }),
    assetVersion: 'steam-2347770-1',
    sha256: digest(bytes),
    bytes: bytes.length,
  };
  await writeFile(join(directory, agent ? `${id}.glb` : 'model.glb'), bytes, {
    flag: 'wx',
    mode: 0o600,
  });
  await writeFile(
    join(directory, agent ? `${id}.manifest.json` : 'manifest.json'),
    JSON.stringify(metadata),
    { flag: 'wx', mode: 0o600 },
  );
}
test('presentation banks publish both original agent fixtures atomically and reuse the installed bank without acquisition', async (t) => {
  const { options } = await fixture(t);
  let calls = 0;
  const fake = {
    ...adapters,
    installModels: async (settings) => {
      calls++;
      assert.deepEqual(settings.agents, ['ct', 't']);
      assert.equal(settings.networkDeny, boundary);
      assert.equal(settings.cleanup, true);
      await settings.onConverting();
      assert.equal(
        (await readPresentationStatus(options.jobs)).categories.agents.stage,
        'converting',
      );
      await preparedModel(settings.output, 'ct', true);
      await preparedModel(settings.output, 't', true);
      assert.deepEqual((await readPresentationStatus(options.jobs)).categories.agents.attempts, 1);
    },
  };
  assert.equal((await installPresentationAssets(options, '1', 'agents', fake)).status, 'prepared');
  const installed = await readFile(join(options.assets, 'agents/ct.glb'));
  assert.equal((await readPresentationStatus(options.jobs)).categories.agents.status, 'ready');
  assert.equal((await installPresentationAssets(options, '1', 'agents', fake)).status, 'installed');
  assert.equal(calls, 1);
  assert.deepEqual(await readFile(join(options.assets, 'agents/ct.glb')), installed);
  assert.deepEqual(
    (await readdir(options.assets)).filter((name) => name.startsWith('.presentation-')),
    [],
  );
});
test('native model preparation yields after one fixed item and extends only immutable registry identities', async (t) => {
  const { options } = await fixture(t);
  const items = [];
  const fake = {
    ...adapters,
    installModels: async (settings) => {
      assert.equal(settings.manifest, '1');
      assert.equal(settings.cache, options.cache);
      assert.equal(settings.firstItemOnly, true);
      const id = settings.items[0];
      items.push(id);
      await preparedModel(settings.output, id);
      return { installed: [id], unsupported: [] };
    },
  };
  const first = await installPresentationAssets(options, '1', 'equipment-models', fake);
  assert.equal(first.remaining, true);
  const firstBytes = await readFile(join(options.assets, 'equipment-models/ak47/model.glb'));
  const second = await installPresentationAssets(options, '2', 'equipment-models', fake);
  assert.equal(second.remaining, true);
  assert.deepEqual(items, ['ak47', 'aug']);
  assert.deepEqual(
    await readFile(join(options.assets, 'equipment-models/ak47/model.glb')),
    firstBytes,
  );
  assert.equal(
    (await readPresentationStatus(options.jobs)).categories['equipment-models'].counts.ready,
    2,
  );
  assert.equal(
    (await readPresentationStatus(options.jobs)).categories['equipment-models'].manifest,
    '1',
  );
  assert.equal(
    JSON.parse(
      await readFile(join(options.assets, 'equipment-models/.cswatch-presentation.json'), 'utf8'),
    ).manifest,
    '1',
  );
});

test('explicit native retry retains source A through inventory B and restart before actual preparation', async (t) => {
  const { options } = await fixture(t),
    initial = {
      manifest: '1',
      generation: 'a'.repeat(24),
      status: 'failed',
      attempts: 3,
      updatedAt: 1,
      code: 'preparation_failed',
    };
  await writePresentationStatus(options.jobs, {
    schemaVersion: 1,
    categories: { agents: initial },
  });
  assert.equal(await enqueuePresentationRetry(options.jobs, 'agents'), 'queued');
  const workerOptions = { ...options, cache: options.cacheRoot };
  const first = new AbortController();
  let firstPreparations = 0,
    optionalPreparations = 0;
  await runMapWorker(
    { ...workerOptions, signal: first.signal },
    {
      refreshInventory: async () => ({ manifest: '2', maps: [{}] }),
      processRequest: async () => {
        first.abort();
        return false;
      },
      preparePresentation: async () => {
        firstPreparations++;
        throw Error('First worker must stop after acknowledging retry, before preparing.');
      },
      delay: async () => {},
    },
  );
  assert.equal(firstPreparations, 0);
  const acknowledged = (await readPresentationStatus(options.jobs)).categories.agents;
  assert.equal(acknowledged.manifest, '1');
  assert.equal(acknowledged.attempts, 0);
  assert.notEqual(acknowledged.generation, initial.generation);
  const restarted = new AbortController(),
    selections = [];
  await runMapWorker(
    { ...workerOptions, signal: restarted.signal },
    {
      refreshInventory: async () => ({ manifest: '2', maps: [{}] }),
      processRequest: async () => false,
      preparePresentation: async (_worker, selectedManifest, kind) => {
        assert.equal(kind, 'agents');
        assert.equal(selectedManifest, '1');
        const result = await installPresentationAssets(
          {
            ...options,
            prepareSource: async (manifest, cache) => {
              selections.push({ manifest, cache });
            },
          },
          selectedManifest,
          kind,
          {
            ...adapters,
            installModels: async (settings) => {
              assert.equal(settings.manifest, '1');
              assert.equal(settings.cache, options.cache);
              await preparedModel(settings.output, 'ct', true);
              await preparedModel(settings.output, 't', true);
            },
          },
        );
        restarted.abort();
        return result;
      },
      preparePreview: async () => {
        optionalPreparations++;
        throw Error('Core retained retry precedes optional preview.');
      },
      prepareSounds: async () => {
        optionalPreparations++;
        throw Error('Core retained retry precedes optional audio.');
      },
      delay: async () => {},
    },
  );
  assert.equal(optionalPreparations, 0);
  assert.deepEqual(selections, [{ manifest: '1', cache: options.cache }]);
  const ready = (await readPresentationStatus(options.jobs)).categories.agents;
  assert.equal(ready.manifest, '1');
  assert.equal(ready.generation, acknowledged.generation);
  assert.equal(ready.attempts, 1);
  assert.equal(ready.status, 'ready');
});

test('conflicting retained native source and owned bank persist a terminal diagnostic without modifying artwork', async (t) => {
  const { options } = await fixture(t);
  await installPresentationAssets(options, '1', 'equipment-models', {
    ...adapters,
    installModels: async (settings) => {
      await preparedModel(settings.output, 'ak47');
      return { installed: ['ak47'], unsupported: [] };
    },
  });
  const bank = join(options.assets, 'equipment-models'),
    installed = await readFile(join(bank, 'ak47/model.glb')),
    marker = await readFile(join(bank, '.cswatch-presentation.json'));
  await writePresentationStatus(options.jobs, {
    schemaVersion: 1,
    categories: {
      'equipment-models': {
        manifest: '2',
        generation: 'b'.repeat(24),
        status: 'failed',
        attempts: 3,
        updatedAt: 1,
        code: 'preparation_failed',
      },
    },
  });
  assert.equal(await enqueuePresentationRetry(options.jobs, 'equipment-models'), 'queued');
  const [resumed] = await consumePresentationRetries(options.jobs);
  let acquisitions = 0;
  assert.equal(
    (
      await installPresentationAssets(options, '3', 'equipment-models', {
        ...adapters,
        installModels: async () => {
          acquisitions++;
        },
      })
    ).status,
    'failed',
  );
  const failed = (await readPresentationStatus(options.jobs)).categories['equipment-models'];
  assert.equal(failed.manifest, '2');
  assert.equal(failed.generation, resumed.generation);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.code, 'source_mismatch');
  assert.equal(failed.attempts, 3);
  assert.equal(failed.stage, undefined);
  assert.equal(failed.retryAt, undefined);
  assert.equal(acquisitions, 0);
  assert.equal(await enqueuePresentationRetry(options.jobs, 'equipment-models'), 'stale');
  assert.deepEqual(await readFile(join(bank, 'ak47/model.glb')), installed);
  assert.deepEqual(await readFile(join(bank, '.cswatch-presentation.json')), marker);
});

test('retained native retries require fresh observed inventory and survive a stale refresh failure', async (t) => {
  const { options } = await fixture(t);
  await writePresentationStatus(options.jobs, {
    schemaVersion: 1,
    categories: {
      agents: {
        manifest: '1',
        generation: 'a'.repeat(24),
        status: 'failed',
        attempts: 3,
        updatedAt: 1,
        code: 'preparation_failed',
      },
    },
  });
  assert.equal(await enqueuePresentationRetry(options.jobs, 'agents'), 'queued');
  const controller = new AbortController();
  let clock = 1000,
    inventories = 0,
    maps = 0,
    preparations = 0,
    optionalPreparations = 0;
  await runMapWorker(
    { ...options, cache: options.cacheRoot, signal: controller.signal },
    {
      now: () => clock,
      refreshInventory: async () => {
        if (++inventories === 2) throw Error('Original unavailable-inventory fixture.');
        return { manifest: '2', maps: [{}] };
      },
      processRequest: async () => {
        if (++maps > 4) {
          controller.abort();
          throw Error('Fresh-inventory fixture exceeded its bounded map turns.');
        }
        if (maps === 1) {
          clock += 86401;
          return true;
        }
        return false;
      },
      preparePresentation: async (_worker, manifest, kind) => {
        preparations++;
        assert.equal(inventories, 3);
        assert.equal(manifest, '1');
        assert.equal(kind, 'agents');
        controller.abort();
        return { status: 'installed' };
      },
      preparePreview: async () => {
        optionalPreparations++;
      },
      prepareSounds: async () => {
        optionalPreparations++;
      },
      delay: async () => {
        assert.equal(inventories, 2);
        assert.equal(preparations, 0);
        assert.equal(optionalPreparations, 0);
        clock += 900;
      },
    },
  );
  assert.equal(inventories, 3);
  assert.equal(preparations, 1);
  assert.equal(optionalPreparations, 0);
  const retained = (await readPresentationStatus(options.jobs)).categories.agents;
  assert.equal(retained.manifest, '1');
  assert.equal(retained.status, 'preparing');
  assert.equal(retained.attempts, 0);
});

test('a newly observed inventory cannot reset exhausted or integrity-failed native source authority', async (t) => {
  const { options } = await fixture(t);
  for (const code of ['preparation_failed', 'source_mismatch']) {
    const failed = {
      manifest: '1',
      generation: 'a'.repeat(24),
      status: 'failed',
      attempts: 3,
      updatedAt: 1,
      code,
    };
    await writePresentationStatus(options.jobs, {
      schemaVersion: 1,
      categories: { agents: failed },
    });
    let acquisitions = 0;
    assert.equal(
      (
        await installPresentationAssets(options, '2', 'agents', {
          ...adapters,
          installModels: async () => {
            acquisitions++;
          },
        })
      ).status,
      'failed',
    );
    assert.equal(acquisitions, 0);
    assert.deepEqual((await readPresentationStatus(options.jobs)).categories.agents, failed);
  }
});

test('retry consumption rejects a renewed failure, terminal evidence or cooldown even within the same second and generation', async (t) => {
  const { options } = await fixture(t);
  for (const change of [
    { code: 'source_mismatch', attempts: 3 },
    { retryAt: Math.floor(Date.now() / 1000) + 300 },
    { attempts: 2 },
    { item: 'aug' },
    { counts: { ready: 0, unavailable: 0, total: 67 } },
    { unsupported: ['aug'] },
  ]) {
    const failed = {
      manifest: '1',
      generation: 'a'.repeat(24),
      status: 'failed',
      attempts: 1,
      updatedAt: 1,
      code: 'preparation_failed',
      item: 'ak47',
    };
    await writePresentationStatus(options.jobs, {
      schemaVersion: 1,
      categories: { 'equipment-models': failed },
    });
    assert.equal(await enqueuePresentationRetry(options.jobs, 'equipment-models'), 'queued');
    const renewed = { ...failed, ...change };
    await writePresentationStatus(options.jobs, {
      schemaVersion: 1,
      categories: { 'equipment-models': renewed },
    });
    assert.deepEqual(await consumePresentationRetries(options.jobs), []);
    assert.deepEqual(
      (await readPresentationStatus(options.jobs)).categories['equipment-models'],
      renewed,
    );
    assert.equal(
      (await readdir(options.jobs)).includes('presentation-retry-equipment-models.json'),
      false,
    );
  }
});

test('enqueue revalidates the complete failure snapshot and current cooldown after asynchronous intent writes', async (t) => {
  const { options } = await fixture(t);
  for (const change of [
    { code: 'source_mismatch', attempts: 3 },
    { retryAt: Math.floor(Date.now() / 1000) + 300 },
    { attempts: 2 },
  ]) {
    const failed = {
      manifest: '1',
      generation: 'a'.repeat(24),
      status: 'failed',
      attempts: 1,
      updatedAt: 1,
      code: 'preparation_failed',
    };
    await writePresentationStatus(options.jobs, {
      schemaVersion: 1,
      categories: { agents: failed },
    });
    let enter,
      release,
      authorized = 0;
    const entered = new Promise((resolve) => {
        enter = resolve;
      }),
      gate = new Promise((resolve) => {
        release = resolve;
      });
    const operation = enqueuePresentationRetry(
      options.jobs,
      'agents',
      () => {
        authorized++;
      },
      {
        beforeRevalidate: async () => {
          enter();
          await gate;
        },
      },
    );
    try {
      await Promise.race([
        entered,
        operation.then(() => {
          throw Error('Retry unexpectedly completed before the controlled write barrier.');
        }),
      ]);
      await writePresentationStatus(options.jobs, {
        schemaVersion: 1,
        categories: { agents: { ...failed, ...change } },
      });
    } finally {
      release();
    }
    assert.equal(await operation, 'stale');
    assert.equal(authorized, 0);
    assert.equal((await readdir(options.jobs)).includes('presentation-retry-agents.json'), false);
  }
});
test('presentation failures retain a durable three-attempt budget and require explicit generation-safe admin retry', async (t) => {
  const { options } = await fixture(t);
  let calls = 0;
  const failure = {
    ...adapters,
    installModels: async () => {
      calls++;
      throw Object.assign(Error('private diagnostic never persisted'), {
        code: 'STEAM_RATE_LIMIT',
      });
    },
  };
  for (let index = 0; index < 3; index++)
    await assert.rejects(installPresentationAssets(options, '1', 'agents', failure));
  assert.equal((await installPresentationAssets(options, '1', 'agents', failure)).status, 'failed');
  assert.equal(calls, 3);
  const failed = await readPresentationStatus(options.jobs);
  assert.equal(failed.categories.agents.attempts, 3);
  assert.equal(failed.categories.agents.code, 'steam_rate_limited');
  assert.doesNotMatch(JSON.stringify(failed), /private diagnostic/);
  assert.equal(await enqueuePresentationRetry(options.jobs, 'agents'), 'stale');
  delete failed.categories.agents.retryAt;
  await writePresentationStatus(options.jobs, failed);
  let authorized = 0;
  await assert.rejects(
    enqueuePresentationRetry(options.jobs, 'agents', () => {
      throw Error('session revoked');
    }),
    /session revoked/,
  );
  assert.equal(
    (await readdir(options.jobs)).some((name) => name === 'presentation-retry-agents.json'),
    false,
  );
  assert.equal(
    await enqueuePresentationRetry(options.jobs, 'agents', () => {
      authorized++;
    }),
    'queued',
  );
  assert.equal(await enqueuePresentationRetry(options.jobs, 'agents'), 'pending');
  assert.equal(authorized, 1);
  const consumed = await consumePresentationRetries(options.jobs);
  const resumed = await readPresentationStatus(options.jobs);
  assert.deepEqual(consumed, [
    { kind: 'agents', manifest: '1', generation: resumed.categories.agents.generation },
  ]);
  assert.notEqual(resumed.categories.agents.generation, failed.categories.agents.generation);
  assert.equal(resumed.categories.agents.attempts, 0);
  assert.deepEqual(await consumePresentationRetries(options.jobs), []);
  await assert.rejects(installPresentationAssets(options, '1', 'agents', failure));
  assert.equal(calls, 4);
});
test('stale retry intents cannot reset a newer presentation generation and strict status rejects contradictory counts', async (t) => {
  const { options } = await fixture(t);
  const status = {
    schemaVersion: 1,
    categories: {
      agents: {
        manifest: '1',
        generation: 'a'.repeat(24),
        status: 'failed',
        attempts: 3,
        updatedAt: 1,
        code: 'preparation_failed',
      },
    },
  };
  await writePresentationStatus(options.jobs, status);
  assert.equal(await enqueuePresentationRetry(options.jobs, 'agents'), 'queued');
  status.categories.agents.generation = 'b'.repeat(24);
  await writePresentationStatus(options.jobs, status);
  assert.equal(await enqueuePresentationRetry(options.jobs, 'agents'), 'stale');
  assert.deepEqual(await consumePresentationRetries(options.jobs), []);
  assert.equal((await readPresentationStatus(options.jobs)).categories.agents.attempts, 3);
  assert.equal(
    presentationStatusSchema.safeParse({
      ...status,
      categories: {
        agents: {
          ...status.categories.agents,
          status: 'ready',
          counts: { ready: 1, unavailable: 2, total: 2 },
        },
      },
    }).success,
    false,
  );
  assert.equal(
    presentationStatusSchema.safeParse({
      ...status,
      categories: {
        agents: { ...status.categories.agents, code: 'https://untrusted.invalid/secret' },
      },
    }).success,
    false,
  );
});
test('native source-integrity failures remain terminal for the selected source and cannot use admin retry to bypass evidence', async (t) => {
  const { options } = await fixture(t);
  let calls = 0;
  const integrity = {
    ...adapters,
    installModels: async () => {
      calls++;
      throw Object.assign(Error('original source-integrity fixture'), {
        code: 'SOURCE_MAP_MISMATCH',
      });
    },
  };
  await assert.rejects(installPresentationAssets(options, '1', 'agents', integrity));
  assert.equal((await readPresentationStatus(options.jobs)).categories.agents.attempts, 3);
  assert.equal(await enqueuePresentationRetry(options.jobs, 'agents'), 'stale');
  assert.equal(
    (await installPresentationAssets(options, '1', 'agents', integrity)).status,
    'failed',
  );
  assert.equal(calls, 1);
});
test('malformed private native status cannot reset durable preparation budgets or be overwritten as a new cache', async (t) => {
  const { options } = await fixture(t);
  let acquisitions = 0;
  await writeFile(
    join(options.jobs, 'presentation-status.json'),
    '{"schemaVersion":1,"categories":{"agents":{"attempts":-1}}}',
    { mode: 0o600 },
  );
  const before = await readFile(join(options.jobs, 'presentation-status.json'));
  await assert.rejects(
    installPresentationAssets(options, '1', 'agents', {
      ...adapters,
      installModels: async () => {
        acquisitions++;
      },
    }),
    /status is invalid/,
  );
  assert.equal(acquisitions, 0);
  assert.deepEqual(await readFile(join(options.jobs, 'presentation-status.json')), before);
});
test('operator-owned presentation directories and linked decoder output are preserved without publication', async (t) => {
  const { root, options } = await fixture(t);
  await mkdir(join(options.assets, 'agents'));
  await writeFile(join(options.assets, 'agents/operator.txt'), 'preserve operator content');
  assert.equal(
    (
      await installPresentationAssets(options, '1', 'agents', {
        ...adapters,
        installModels: async () => {
          throw Error('must not acquire');
        },
      })
    ).status,
    'preserved',
  );
  const outside = join(root, 'outside');
  await writeFile(outside, 'private sentinel');
  await assert.rejects(
    installPresentationAssets(options, '1', 'equipment-models', {
      ...adapters,
      installModels: async (settings) => {
        const directory = join(settings.output, 'equipment-models/ak47');
        await mkdir(directory, { recursive: true });
        await symlink(outside, join(directory, 'model.glb'));
        return { installed: ['ak47'], unsupported: [] };
      },
    }),
  );
  assert.equal(await readFile(outside, 'utf8'), 'private sentinel');
  assert.equal(
    await readFile(join(options.assets, 'agents/operator.txt'), 'utf8'),
    'preserve operator content',
  );
  assert.equal(
    (await readPresentationStatus(options.jobs)).categories['equipment-models'].status,
    'failed',
  );
});
test('crash journal recovers work, pre-rename claims and renamed publishing banks without deleting unknown or published directories', async (t) => {
  const { options, stageOptions } = await fixture(t);
  const unknown = await mkdtemp(join(options.assets, '.presentation-'));
  await writeFile(join(unknown, 'operator.txt'), 'unknown');
  for (const renamed of [false, true]) {
    const work = await mkdtemp(join(options.assets, '.presentation-'));
    await registerPresentationStage(stageOptions, work, {
      manifest: '1',
      kind: 'agents',
      location: 'assets',
    });
    const bank = join(work, 'agents');
    await mkdir(bank);
    await writeFile(join(bank, 'original.txt'), 'original');
    const publishing = await mkdtemp(join(options.assets, '.presentation-'));
    await registerPresentationStage(stageOptions, publishing, {
      manifest: '1',
      kind: 'agents',
      location: 'assets',
      futureIdentity: presentationStageIdentity(await lstat(bank, { bigint: true })),
    });
    if (renamed) await rename(bank, publishing);
    assert.equal(await cleanPresentationStages(stageOptions), 0);
    assert.equal((await readdir(options.assets)).includes(publishing.split('/').at(-1)), false);
  }
  assert.equal(await readFile(join(unknown, 'operator.txt'), 'utf8'), 'unknown');
  const nativeControl = await mkdtemp(join(options.cache, 'equipment-install-'));
  await registerPresentationStage(stageOptions, nativeControl, {
    manifest: '1',
    kind: 'agents',
    location: 'source',
  });
  await writeFile(join(nativeControl, 'original.txt'), 'interrupted native controls');
  assert.equal(await cleanPresentationStages(stageOptions), 0);
  assert.equal((await readdir(options.cache)).includes(nativeControl.split('/').at(-1)), false);
});
test('coarse catalog completion exposes no diagnostics and startup cleanup removes only recognized private web orphans', async (t) => {
  const { options } = await fixture(t);
  assert.equal(await presentationCatalogComplete(options.jobs, 'equipment', 0), undefined);
  const status = {
    schemaVersion: 1,
    categories: {
      equipment: {
        manifest: '1',
        generation: 'a'.repeat(24),
        status: 'preparing',
        attempts: 1,
        updatedAt: 1,
      },
    },
  };
  await writePresentationStatus(options.jobs, status);
  assert.equal(await presentationCatalogComplete(options.jobs, 'equipment', 0), false);
  status.categories.equipment = {
    ...status.categories.equipment,
    status: 'ready',
    counts: { ready: 1, unavailable: 82, total: 83 },
  };
  await writePresentationStatus(options.jobs, status);
  assert.equal(await presentationCatalogComplete(options.jobs, 'equipment', 0), false);
  assert.equal(await presentationCatalogComplete(options.jobs, 'equipment', 1), true);
  const orphan = join(options.jobs, `.presentation-retry-${'a'.repeat(24)}.tmp`),
    worker = join(options.jobs, `.presentation-stages-${'b'.repeat(24)}.tmp`),
    unknown = join(options.jobs, '.presentation-retry-unknown.tmp');
  await writeFile(orphan, '{', { mode: 0o600 });
  await writeFile(worker, 'worker');
  await writeFile(unknown, 'operator');
  assert.equal(await cleanupPresentationRetryTemps(options.jobs), 1);
  assert.equal(await readFile(worker, 'utf8'), 'worker');
  assert.equal(await readFile(unknown, 'utf8'), 'operator');
});
test('compiled publication modes reject replacement, arbitrary IDs, linked stages and different parents', async (t) => {
  const { options } = await fixture(t);
  const stage = await mkdtemp(join(options.assets, '.presentation-'));
  await writeFile(join(stage, 'original.txt'), 'original');
  const publish = (source, target, mode = '--publish-presentation') =>
    spawnSync(boundary, [mode, source, target], { stdio: 'ignore', timeout: 5000 }).status;
  assert.equal(publish(stage, join(options.assets, 'agents')), 0);
  const rejected = await mkdtemp(join(options.assets, '.presentation-'));
  assert.equal(publish(rejected, join(options.assets, 'agents')), 125);
  assert.equal(publish(rejected, join(options.assets, 'arbitrary')), 125);
  const linked = join(options.assets, '.presentation-ABC123');
  await symlink(rejected, linked);
  assert.equal(publish(linked, join(options.assets, 'equipment')), 125);
  const other = join(options.assets, 'other');
  await mkdir(other);
  assert.equal(publish(rejected, join(other, 'equipment')), 125);
  const models = join(options.assets, 'equipment-models');
  await mkdir(models);
  const item = await mkdtemp(join(models, '.equipment-'));
  assert.equal(publish(item, join(models, 'ak47'), '--publish-equipment'), 0);
  const another = await mkdtemp(join(models, '.equipment-'));
  assert.equal(publish(another, join(models, 'ak47'), '--publish-equipment'), 125);
  assert.equal(publish(another, join(models, 'arbitrary'), '--publish-equipment'), 125);
});
test('fixed official icon selectors never accept URLs, uploaded paths or wildcard resources', () => {
  assert.equal(equipmentIconSources.ak47.resource, 'panorama/images/icons/equipment/ak47.vsvg_c');
  assert.ok(Object.keys(equipmentIconSources).length <= 128);
  for (const row of Object.values(equipmentIconSources))
    assert.doesNotMatch(row.resource, /\.\.|https?:|\*/);
});
test('fixed native idle remains usable when optional locomotion clips are missing without inventing a pose', () => {
  const index = {
    entries: new Map(Object.values(agentAnimationRegistry).map((resource) => [resource, {}])),
  };
  assert.deepEqual(agentRolesForIndex(index, true), agentAnimationRoles);
  index.entries.delete(agentAnimationRegistry.walk);
  assert.deepEqual(agentRolesForIndex(index, true), ['idle']);
  assert.deepEqual(agentRolesForIndex(index, false), agentAnimationRoles);
  index.entries.delete(agentAnimationRegistry.idle);
  assert.throws(() => agentRolesForIndex(index, true), /idle clip is unavailable/);
});
test('confined original SVG rasterization succeeds without granting metadata changes or control-file writes', async (t) => {
  const { root } = await fixture(t),
    conversion = join(root, 'conversion'),
    output = join(root, 'output');
  for (const path of [conversion, output]) await mkdir(path);
  const input = join(conversion, 'svg');
  await mkdir(input);
  await writeFile(
    join(input, 'ak47.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="32"><path fill="#ffffff" d="M4 4h100v20H4z"/></svg>',
  );
  const control = join(root, 'control.txt');
  await writeFile(control, 'sentinel');
  const result = spawnSync(
    boundary,
    [
      '--write-root',
      conversion,
      '--write-root',
      output,
      '--',
      process.execPath,
      resolve('tools/assets/prepare-equipment.mjs'),
      '--input',
      input,
      '--output',
      join(output, 'equipment'),
      '--version',
      'original-fixture',
      '--source',
      'Original synthetic SVG fixture',
      '--confined',
      'true',
    ],
    {
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 16384,
      env: { PATH: process.env.PATH, HOME: conversion, TMPDIR: conversion, LANG: 'C.UTF-8' },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).count, 1);
  assert.equal(await readFile(control, 'utf8'), 'sentinel');
  const denied = spawnSync(
    boundary,
    [
      '--write-root',
      conversion,
      '--',
      process.execPath,
      '-e',
      'require("node:fs").writeFileSync(process.argv[1],"forbidden")',
      control,
    ],
    { stdio: 'ignore', timeout: 5000 },
  );
  assert.notEqual(denied.status, 0);
  assert.equal(await readFile(control, 'utf8'), 'sentinel');
});
test('confined original model packing keeps metadata normalization in the supervisor', async (t) => {
  const { root } = await fixture(t),
    conversion = join(root, 'conversion'),
    output = join(root, 'models');
  for (const path of [conversion, output]) await mkdir(path);
  const input = join(conversion, 'original.glb');
  await writeFile(input, await triangle(), { mode: 0o600 });
  const result = spawnSync(
    boundary,
    [
      '--write-root',
      conversion,
      '--write-root',
      output,
      '--',
      process.execPath,
      resolve('tools/assets/prepare-equipment-model.mjs'),
      '--input',
      input,
      '--output',
      output,
      '--id',
      'ak47',
      '--asset-version',
      'original-fixture',
      '--confined',
    ],
    {
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 16384,
      env: { PATH: process.env.PATH, HOME: conversion, TMPDIR: conversion, LANG: 'C.UTF-8' },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).manifest.id, 'ak47');
});
