import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  writeFile,
  readFile,
  rm,
  symlink,
  link,
  mkdir,
  readdir,
  chmod,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { inspectMapIdentity, inspectionLimits } from './inspect-map-identity.mjs';
const identity = {
  map: 'de_original_fixture',
  buildNum: 123,
  patchVersion: 456,
  demoVersionGuid: '12345678-abcd-1234-5678-123456789abc',
  addonPresence: 'none',
};
const approval = {
  identity,
  source: {
    appId: 730,
    depotId: 2347770,
    manifest: '18014398509481985',
    mapSha256: 'a'.repeat(64),
  },
};
const manifest = {
  version: 3,
  map: identity.map,
  mapIdentity: identity,
  actors: [{ steamid: '76561190000000000', name: 'PRIVATE_ACTOR_DO_NOT_PRINT' }],
  server_name: 'PRIVATE_SERVER_DO_NOT_PRINT',
  notes: 'PRIVATE_NOTE_DO_NOT_PRINT',
};
const catalog = { schemaVersion: 1, entries: [approval] };
const enabled = process.platform === 'linux';
const input = (value) => Readable.from([JSON.stringify(value)]);
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'cswatch-map-inspection-'));
  try {
    const replay = join(root, 'manifest.json'),
      approvals = join(root, 'catalog.json');
    await writeFile(replay, JSON.stringify(manifest));
    await writeFile(approvals, JSON.stringify(catalog));
    await run({ root, replay, catalog: approvals });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test(
  'operator inspection projects only map evidence and leaves input files unchanged',
  { skip: !enabled },
  async () =>
    fixture(async (paths) => {
      const before = await readFile(paths.replay);
      const result = await inspectMapIdentity(paths);
      assert.equal(result.resolution, 'approved');
      assert.equal(result.selected.source.manifest, '18014398509481985');
      assert.doesNotMatch(
        JSON.stringify(result),
        /PRIVATE_|76561190000000000|manifest\.json|catalog\.json/,
      );
      assert.equal(result.evidence.originalMapContent, 'not-verified');
      assert.equal(result.evidence.sourceAvailability, 'not-checked');
      assert.deepEqual(await readFile(paths.replay), before);
      assert.deepEqual((await readdir(paths.root)).sort(), ['catalog.json', 'manifest.json']);
      await chmod(paths.catalog, 0o666);
      await assert.rejects(inspectMapIdentity(paths));
    }),
);

test('stdin inspection explains missing recorded identity and optional catalog without fabricating revisions', async () => {
  const missing = await inspectMapIdentity({ input: input({ version: 3, map: 'de_mirage' }) });
  assert.equal(missing.resolution, 'unknown');
  assert.equal(missing.recordedIdentity, null);
  assert.equal(missing.selected, null);
  assert.ok(missing.issues.includes('identity_missing'));
  const complete = await inspectMapIdentity({ input: input(manifest) });
  assert.equal(complete.resolution, 'not_evaluated');
  assert.equal(complete.catalog.status, 'not_provided');
  assert.equal(complete.candidates.length, 0);
  await assert.rejects(
    inspectMapIdentity({ input: input({ ...manifest, version: 1 }) }),
    /validated replay manifest/,
  );
  await assert.rejects(
    inspectMapIdentity({ input: input({ ...manifest, map: '../../private' }) }),
    /validated replay manifest/,
  );
});

test(
  'stdin and regular-file byte limits fail before native parsing or extra stream consumption',
  { skip: !enabled },
  async () =>
    fixture(async (paths) => {
      let continued = false;
      async function* oversized() {
        yield Buffer.alloc(inspectionLimits.replayBytes + 1, 32);
        continued = true;
        yield JSON.stringify(manifest);
      }
      await assert.rejects(inspectMapIdentity({ input: oversized() }), /byte bound/);
      assert.equal(continued, false);
      await writeFile(paths.replay, Buffer.alloc(inspectionLimits.replayBytes + 1, 32));
      await assert.rejects(inspectMapIdentity(paths));
      await writeFile(paths.replay, 'PBDEMS2\0not-a-replay-manifest');
      await assert.rejects(inspectMapIdentity(paths));
      await assert.rejects(inspectMapIdentity({ input: Readable.from([Buffer.from([255, 255])]) }));
    }),
);

test(
  'linked files/ancestors, hardlinks and FIFO inputs are rejected without touching targets or blocking',
  { skip: !enabled },
  async () =>
    fixture(async (paths) => {
      const alias = join(paths.root, 'alias.json');
      await symlink(paths.replay, alias);
      await assert.rejects(inspectMapIdentity({ ...paths, replay: alias }));
      const linked = join(paths.root, 'linked');
      await symlink(paths.root, linked);
      await assert.rejects(inspectMapIdentity({ ...paths, replay: join(linked, 'manifest.json') }));
      await rm(alias);
      await link(paths.replay, alias);
      await assert.rejects(inspectMapIdentity({ ...paths, replay: alias }));
      await rm(alias);
      const fifo = join(paths.root, 'pipe.json');
      assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
      await assert.rejects(inspectMapIdentity({ ...paths, replay: fifo }));
      assert.deepEqual(JSON.parse(await readFile(paths.replay, 'utf8')), manifest);
    }),
);

test(
  'CLI accepts original replay metadata over stdin and rejects URL/selectors without echoing private input',
  { skip: !enabled },
  async () =>
    fixture(async (paths) => {
      const cli = new URL('./inspect-map-identity.mjs', import.meta.url).pathname;
      const result = spawnSync(process.execPath, [cli, '--catalog', paths.catalog], {
        input: JSON.stringify(manifest),
        encoding: 'utf8',
        timeout: 5000,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).resolution, 'approved');
      assert.doesNotMatch(result.stdout, /PRIVATE_|76561190000000000/);
      const invalid = spawnSync(
        process.execPath,
        [cli, '--url', 'https://invalid.test/PRIVATE_TOKEN_DO_NOT_PRINT'],
        { input: JSON.stringify(manifest), encoding: 'utf8', timeout: 5000 },
      );
      assert.equal(invalid.status, 1);
      assert.doesNotMatch(invalid.stdout + invalid.stderr, /PRIVATE_|https:/);
    }),
);
