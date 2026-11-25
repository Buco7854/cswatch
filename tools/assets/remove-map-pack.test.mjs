import { writeNativeWorld, vertexFile } from './fixtures/native-world.mjs';
import { mapPreparerRevision } from '../../backend/dist/asset-preparer.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  symlink,
  link,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalMapApproval,
  mapPackId,
  latestMapPackId,
  latestMapRequestId,
} from '../../backend/dist/map-catalog.js';
import {
  enqueueMapRequest,
  prepareMapJobs,
  readMapRequest,
  readMapResult,
  writeMapJobResult,
  retryMapRequest,
  atomicMapJobWrite,
  enqueueLatestMapRequest,
  retryLatestMapRequest,
} from '../../backend/dist/map-jobs.js';
import {
  listManagedMaps,
  enqueueMapRemoval,
  readMapRemoval,
  readMapRemovalResult,
  unsettledMapRemoval,
} from '../../backend/dist/map-removals.js';
import { processOneMapRemoval } from './remove-map-pack.mjs';
import { buildNetworkDeny } from './build-network-deny.mjs';
import { spawnSync } from 'node:child_process';
let boundaryRoot, networkDeny;
before(async () => {
  boundaryRoot = await mkdtemp(join(tmpdir(), 'cswatch-map-removal-kernel-'));
  networkDeny = buildNetworkDeny(join(boundaryRoot, 'asset-network-deny'));
});
after(async () => {
  await rm(boundaryRoot, { recursive: true, force: true });
});
const approval = {
  identity: {
    map: 'de_ancient',
    buildNum: 1,
    patchVersion: 1,
    demoVersionGuid: '8e9d71ab-04a1-4c01-bb61-acfede27c046',
    addonPresence: 'none',
  },
  source: {
    appId: 730,
    depotId: 2347770,
    manifest: '807392217824910805',
    mapSha256: 'a'.repeat(64),
  },
};
async function fixture(t, latest = false) {
  const root = await mkdtemp(join(tmpdir(), 'cswatch-remove-owned-map-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const jobs = join(root, 'jobs'),
    assets = join(root, 'assets'),
    cache = join(root, 'source-cache'),
    selection = {
      map: approval.identity.map,
      appId: 730,
      depotId: 2347770,
      manifest: approval.source.manifest,
      sha1: 'b'.repeat(40),
      bytes: 100,
    },
    requestId = latest ? latestMapRequestId(selection) : mapPackId(approval),
    packId = latest ? latestMapPackId(selection.map, approval.source) : requestId;
  await prepareMapJobs(jobs);
  await mkdir(cache);
  await writeFile(join(cache, 'retained-source'), 'retained source fixture');
  if (latest) await enqueueLatestMapRequest(jobs, selection);
  else await enqueueMapRequest(jobs, approval);
  await writeMapJobResult(jobs, {
    schemaVersion: mapPreparerRevision,
    packId: requestId,
    status: 'ready',
    updatedAt: Math.floor(Date.now() / 1000),
    ...(latest
      ? {
          assetPackId: packId,
          source: approval.source,
          sourceCheckedAt: Math.floor(Date.now() / 1000),
        }
      : {}),
  });
  const target = join(assets, 'packs', packId),
    model = join(target, 'maps/de_ancient', vertexFile);
  writeNativeWorld(join(target, 'maps'), 'de_ancient', approval.source.manifest);
  await writeFile(
    join(target, 'pack.json'),
    JSON.stringify(
      latest
        ? {
            schemaVersion: mapPreparerRevision,
            kind: 'latest-official',
            packId,
            requestId,
            selection,
            source: approval.source,
            preparedAt: Math.floor(Date.now() / 1000),
          }
        : {
            schemaVersion: mapPreparerRevision,
            packId,
            approval: canonicalMapApproval(approval),
            preparedAt: Math.floor(Date.now() / 1000),
          },
    ),
  );
  await writeFile(model, 'original fixture only');
  await writeFile(join(assets, 'operator-sentinel'), 'operator fixture');
  const [map] = await listManagedMaps(assets, jobs);
  await enqueueMapRemoval(assets, jobs, packId, map.version);
  const removal = await readMapRemoval(jobs, packId);
  return {
    root,
    target,
    model,
    packId,
    requestId,
    selection,
    removal,
    options: { jobs, assets, cache, networkDeny },
    quarantine: join(assets, 'packs', `.removing-${packId}-${removal.removalId}`),
  };
}
const absent = async (path) =>
  readFile(path).then(
    () => false,
    (error) => {
      if (error.code === 'ENOENT') return true;
      throw error;
    },
  );

test('worker removes only the reviewed owned pack, preserves active file descriptors and requires explicit retry', async (t) => {
  const f = await fixture(t),
    reader = await open(f.model);
  t.after(() => reader.close());
  assert.equal(await processOneMapRemoval(f.options), true);
  assert.equal(await absent(join(f.target, 'pack.json')), true);
  assert.equal(await absent(join(f.quarantine, 'pack.json')), true);
  assert.equal(await reader.readFile('utf8'), 'original fixture only');
  assert.equal(
    await readFile(join(f.options.assets, 'operator-sentinel'), 'utf8'),
    'operator fixture',
  );
  assert.equal(
    await readFile(join(f.options.cache, 'retained-source'), 'utf8'),
    'retained source fixture',
  );
  assert.equal((await readMapResult(f.options.jobs, f.packId)).code, 'removed_by_admin');
  assert.equal((await readMapRemovalResult(f.options.jobs, f.packId)).status, 'removed');
  assert.equal(await unsettledMapRemoval(f.options.jobs, f.packId), false);
  assert.equal(await processOneMapRemoval(f.options), false);
  const result = await readMapResult(f.options.jobs, f.packId);
  assert.equal(
    await retryMapRequest(f.options.jobs, approval, result.updatedAt + 299),
    'ineligible',
  );
  assert.equal(await retryMapRequest(f.options.jobs, approval, result.updatedAt + 300), 'queued');
  assert.notEqual(
    (await readMapRequest(f.options.jobs, f.packId)).generation,
    f.removal.generation,
  );
});

test('latest deletion uses the content pack rather than queue ID and preserves exact proof for an explicit future retry', async (t) => {
  const f = await fixture(t, true);
  assert.notEqual(f.packId, f.requestId);
  assert.equal(f.removal.requestId, f.requestId);
  assert.equal(await processOneMapRemoval(f.options), true);
  const result = await readMapResult(f.options.jobs, f.requestId);
  assert.equal(result.code, 'removed_by_admin');
  assert.equal(result.assetPackId, f.packId);
  assert.deepEqual(result.source, approval.source);
  assert.equal(await absent(join(f.target, 'pack.json')), true);
  assert.equal(
    await retryLatestMapRequest(f.options.jobs, f.selection, result.updatedAt + 300),
    'queued',
  );
  assert.equal((await readMapResult(f.options.jobs, f.requestId)).status, 'processing');
  assert.equal((await readMapResult(f.options.jobs, f.requestId)).assetPackId, f.packId);
});

test('foreign files, symlinks and hardlinks prevent deletion before the public pack is retired', async (t) => {
  for (const kind of ['foreign', 'symlink', 'hardlink'])
    await t.test(kind, async (t) => {
      const f = await fixture(t),
        outside = join(f.root, 'outside');
      await writeFile(outside, 'outside fixture');
      if (kind === 'foreign') await writeFile(join(f.target, 'operator-extra'), 'foreign fixture');
      else {
        await rm(f.model);
        await (kind === 'symlink' ? symlink : link)(outside, f.model);
      }
      const logs = [];
      await processOneMapRemoval({ ...f.options, log: (event) => logs.push(event) });
      assert.equal((await readMapRemovalResult(f.options.jobs, f.packId)).status, 'failed');
      assert.equal((await readMapRemovalResult(f.options.jobs, f.packId)).code, 'files_changed');
      assert.equal((await readMapResult(f.options.jobs, f.packId)).status, 'ready');
      assert.equal(await absent(join(f.target, 'pack.json')), false);
      assert.equal(await readFile(outside, 'utf8'), 'outside fixture');
      assert.equal(JSON.stringify(logs).includes(f.root), false);
    });
});

test('changed immutable markers or request generations cannot retire a newer snapshot', async (t) => {
  for (const kind of ['marker', 'generation'])
    await t.test(kind, async (t) => {
      const f = await fixture(t);
      if (kind === 'marker') await writeFile(join(f.target, 'pack.json'), '{}');
      else
        await atomicMapJobWrite(f.options.jobs, 'requests', f.packId, {
          ...(await readMapRequest(f.options.jobs, f.packId)),
          generation: 'b'.repeat(32),
        });
      await processOneMapRemoval(f.options);
      assert.equal((await readMapRemovalResult(f.options.jobs, f.packId)).code, 'request_changed');
      assert.equal(await readFile(f.model, 'utf8'), 'original fixture only');
    });
});

test('a crash after quarantine rename resumes through the durable reviewed identity', async (t) => {
  const f = await fixture(t);
  await rename(f.target, f.quarantine);
  assert.equal(await processOneMapRemoval(f.options), true);
  assert.equal((await readMapRemovalResult(f.options.jobs, f.packId)).status, 'removed');
  assert.equal((await readMapResult(f.options.jobs, f.packId)).code, 'removed_by_admin');
  assert.deepEqual(await listManagedMaps(f.options.assets, f.options.jobs), []);
});

test('a crash during private cleanup and after its final marker remains recoverable', async (t) => {
  const f = await fixture(t);
  await rename(f.target, f.quarantine);
  const result = await readMapResult(f.options.jobs, f.packId);
  await writeMapJobResult(f.options.jobs, {
    ...result,
    status: 'failed',
    code: 'removed_by_admin',
  });
  await rm(join(f.quarantine, 'maps'), { recursive: true });
  await rm(join(f.quarantine, 'pack.json'));
  assert.equal(await processOneMapRemoval(f.options), true);
  assert.equal((await readMapRemovalResult(f.options.jobs, f.packId)).status, 'removed');
});

test('an existing quarantine entry is preserved and no restart automatically retries failed removal', async (t) => {
  const f = await fixture(t);
  await mkdir(f.quarantine);
  await writeFile(join(f.quarantine, 'operator-extra'), 'preserve fixture');
  await processOneMapRemoval(f.options);
  assert.equal(await readFile(join(f.quarantine, 'operator-extra'), 'utf8'), 'preserve fixture');
  assert.equal(await readFile(f.model, 'utf8'), 'original fixture only');
  assert.equal((await readMapRemovalResult(f.options.jobs, f.packId)).status, 'failed');
  assert.equal(await processOneMapRemoval(f.options), false);
});

test('atomic retirement has no preclaim crash state and preserves every unverified existing destination', async (t) => {
  for (const kind of ['empty', 'nonempty', 'symlink'])
    await t.test(kind, async (t) => {
      const f = await fixture(t);
      if (kind === 'symlink') await symlink(f.target, f.quarantine);
      else {
        await mkdir(f.quarantine, { mode: 0o700 });
        if (kind === 'nonempty') await writeFile(join(f.quarantine, 'operator-extra'), 'untouched');
      }
      const before = await readFile(join(f.target, 'pack.json'));
      const result = spawnSync(networkDeny, ['--retire-map-pack', f.target, f.quarantine], {
        stdio: 'ignore',
      });
      assert.notEqual(result.status, 0);
      assert.deepEqual(await readFile(join(f.target, 'pack.json')), before);
      if (kind === 'nonempty')
        assert.equal(await readFile(join(f.quarantine, 'operator-extra'), 'utf8'), 'untouched');
      await rm(f.quarantine, { recursive: kind !== 'symlink' });
      // A worker stopped before the atomic rename has created no claim to recover.
      assert.equal(await processOneMapRemoval(f.options), true);
      assert.equal((await readMapRemovalResult(f.options.jobs, f.packId)).status, 'removed');
    });
});

test('native retirement rejects a different pack identity, malformed removal ID and different parent', async (t) => {
  const f = await fixture(t),
    before = await readFile(join(f.target, 'pack.json'));
  for (const target of [
    join(f.options.assets, 'packs', `.removing-${'f'.repeat(64)}-${f.removal.removalId}`),
    join(f.options.assets, 'packs', `.removing-${f.packId}-${'Z'.repeat(32)}`),
    join(f.root, `.removing-${f.packId}-${f.removal.removalId}`),
  ]) {
    assert.notEqual(
      spawnSync(networkDeny, ['--retire-map-pack', f.target, target], { stdio: 'ignore' }).status,
      0,
    );
    assert.deepEqual(await readFile(join(f.target, 'pack.json')), before);
  }
});

test('foreign result metadata fails closed before retiring a pack and is never overwritten', async (t) => {
  const f = await fixture(t),
    outside = join(f.root, 'outside-metadata');
  await writeFile(outside, 'original operator metadata');
  await symlink(outside, join(f.options.jobs, 'removal-results', f.packId + '.json'));
  await assert.rejects(processOneMapRemoval(f.options), /Invalid map management record/);
  assert.equal(await readFile(f.model, 'utf8'), 'original fixture only');
  assert.equal(await readFile(outside, 'utf8'), 'original operator metadata');
});

test('controlled shutdown after quarantine leaves its durable intent pending and the next worker resumes safely', async (t) => {
  const f = await fixture(t),
    controller = new AbortController();
  await processOneMapRemoval({
    ...f.options,
    signal: controller.signal,
    log: (event) => {
      if (event.event === 'map.removing') controller.abort();
    },
  });
  assert.equal(await readMapRemovalResult(f.options.jobs, f.packId), undefined);
  assert.equal(await absent(join(f.quarantine, 'pack.json')), false);
  assert.equal(await processOneMapRemoval(f.options), true);
  assert.equal((await readMapRemovalResult(f.options.jobs, f.packId)).status, 'removed');
});
