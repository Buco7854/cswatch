import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseOfficialMapInventory,
  refreshOfficialMapInventory,
  officialInventoryFailure,
} from './official-map-inventory.mjs';
import { prepareMapJobs, readOfficialMapInventory } from '../../backend/dist/map-jobs.js';
const row = (map = 'de_mirage', manifest = '18446744073709551615') =>
  `2347770\t${manifest}\t${'a'.repeat(40)}\t100\tgame/csgo/maps/${map}.vpk`;

test('official inventory is bounded fixed-depot membership with exact string versions', () => {
  const inventory = parseOfficialMapInventory(
    [row('de_new_official'), row('de_mirage')].join('\n'),
    100,
  );
  assert.equal(inventory.manifest, '18446744073709551615');
  assert.deepEqual(
    inventory.maps.map((m) => m.map),
    ['de_mirage', 'de_new_official'],
  );
  assert.equal(inventory.updatedAt, 100);
  const child = row().replace('maps/de_mirage.vpk', 'maps/prefabs/sky.vpk');
  assert.equal(parseOfficialMapInventory(row() + '\n' + child).maps.length, 1);
  for (const text of [
    '',
    row() + '\n' + row(),
    row().replace('2347770', '730'),
    row().replace('18446744073709551615', '18446744073709551616'),
    row().replace('game/csgo/maps/de_mirage.vpk', 'https://example.invalid/map.vpk'),
    row().replace('maps/de_mirage', 'maps/../de_mirage'),
    row().replace('\t100\t', '\t2147483649\t'),
    row() + '\n' + row('de_dust2', '42'),
    'x'.repeat(131073),
  ])
    assert.throws(() => parseOfficialMapInventory(text));
});

test('refresh lists metadata only through the fixed anonymous selector and atomically retains previous success on failure', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cswatch-inventory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = {
    jobs: join(root, 'jobs'),
    cache: join(root, 'cache'),
    assets: join(root, 'assets'),
  };
  await mkdir(options.assets);
  await prepareMapJobs(options.jobs);
  let context;
  const adapters = {
    prepareToolchain: async () => ({ downloader: '/trusted/downloader' }),
    run: async (command, args, received) => {
      assert.equal(command, '/trusted/downloader');
      assert.deepEqual(args, ['ls', '730', '2347770', '--anonymous', '--', 'game/csgo/maps/*.vpk']);
      context = received;
      assert.ok(received.signal);
      await received.storageGuard();
      return { code: 0, stdout: row(), stderr: '' };
    },
  };
  const inventory = await refreshOfficialMapInventory(options, adapters);
  assert.deepEqual(await readOfficialMapInventory(options.jobs), inventory);
  await assert.rejects(readFile(context.log), { code: 'ENOENT' });
  await assert.rejects(
    refreshOfficialMapInventory(options, {
      ...adapters,
      run: async () => ({ code: 5, stdout: row(), stderr: '' }),
    }),
    /unavailable/,
  );
  assert.deepEqual(await readOfficialMapInventory(options.jobs), inventory);
  await assert.rejects(
    refreshOfficialMapInventory(options, {
      ...adapters,
      run: async () => ({ code: 0, stdout: row() + '\n' + row(), stderr: '' }),
    }),
  );
  assert.deepEqual(await readOfficialMapInventory(options.jobs), inventory);
});

test('explicit Steam exit 4 is tagged from actual downloader status and preserves the last inventory', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cswatch-inventory-rate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = {
    jobs: join(root, 'jobs'),
    cache: join(root, 'cache'),
    assets: join(root, 'assets'),
  };
  await mkdir(options.assets);
  await prepareMapJobs(options.jobs);
  const tool = join(root, 'downloader');
  await writeFile(tool, '#!/bin/sh\nexit 4\n', { mode: 0o700 });
  const adapters = { prepareToolchain: async () => ({ downloader: tool }) };
  const previous = await refreshOfficialMapInventory(options, {
    ...adapters,
    run: async () => ({ code: 0, stdout: row(), stderr: '' }),
  });
  await assert.rejects(refreshOfficialMapInventory(options, adapters), (error) => {
    assert.equal(error.code, 'STEAM_RATE_LIMIT');
    assert.equal(error.exitCode, 4);
    return true;
  });
  assert.deepEqual(await readOfficialMapInventory(options.jobs), previous);
  await assert.rejects(
    refreshOfficialMapInventory(options, {
      ...adapters,
      run: async () => ({ code: 4, stdout: row(), stderr: '' }),
    }),
    (error) => {
      assert.equal(error.code, 'STEAM_RATE_LIMIT');
      return true;
    },
  );
  assert.deepEqual(await readOfficialMapInventory(options.jobs), previous);
});

test('inventory stages retain only safe failure codes and preserve prior metadata until complete recovery', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cswatch-inventory-diagnostics-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = {
    jobs: join(root, 'jobs'),
    cache: join(root, 'cache'),
    assets: join(root, 'assets'),
  };
  await mkdir(options.assets);
  await prepareMapJobs(options.jobs);
  const base = {
    storage: async () => {},
    reserve: async () => {},
    prepareToolchain: async () => ({ downloader: '/fixed/trusted/tool' }),
    run: async () => ({ code: 0, stdout: row(), stderr: '' }),
  };
  const previous = await refreshOfficialMapInventory(options, base);
  const secret = 'https://private.invalid/token?credential=never-log /operator/private';
  const fail = (attributes = {}) => Object.assign(Error(secret), attributes);
  for (const [adapters, expected] of [
    [
      {
        storage: async () => {
          throw fail({ code: 'ENOSPC' });
        },
      },
      { phase: 'storage', code: 'storage_limit' },
    ],
    [
      {
        prepareToolchain: async () => {
          throw fail();
        },
      },
      { phase: 'toolchain', code: 'toolchain_failed' },
    ],
    [
      {
        prepareToolchain: async () => {
          throw fail({ exitCode: 4 });
        },
      },
      { phase: 'toolchain', code: 'toolchain_failed', exitCode: 4 },
    ],
    [
      {
        prepareToolchain: async () => {
          throw fail({ cause: { code: 'EAI_AGAIN' } });
        },
      },
      { phase: 'toolchain', code: 'network_unavailable' },
    ],
    [
      {
        run: async () => {
          throw fail({ exitCode: 4 });
        },
      },
      { phase: 'downloader', code: 'steam_rate_limited', exitCode: 4 },
    ],
    [
      { run: async () => ({ code: 5, stdout: secret, stderr: secret }) },
      { phase: 'downloader', code: 'steam_unavailable', exitCode: 5 },
    ],
    [
      {
        run: async () => {
          throw Error('Operator asset stage timed out.');
        },
      },
      { phase: 'downloader', code: 'timeout' },
    ],
    [
      { run: async () => ({ code: 0, stdout: secret, stderr: secret }) },
      { phase: 'metadata', code: 'metadata_invalid' },
    ],
    [
      {
        publish: async () => {
          throw fail({ code: 'EACCES' });
        },
      },
      { phase: 'publication', code: 'access_denied' },
    ],
    [
      {
        reserve: async () => {
          throw fail({ code: 'ENOSPC' });
        },
        run: async (_command, _args, context) => {
          await context.storageGuard();
        },
      },
      { phase: 'storage', code: 'storage_limit' },
    ],
  ]) {
    await assert.rejects(
      () => refreshOfficialMapInventory(options, { ...base, ...adapters }),
      (error) => {
        assert.deepEqual(officialInventoryFailure(error), expected);
        assert.equal(JSON.stringify(error).includes(secret), false);
        return true;
      },
    );
    assert.deepEqual(await readOfficialMapInventory(options.jobs), previous);
  }
  const recovered = await refreshOfficialMapInventory(options, {
    ...base,
    run: async () => ({ code: 0, stdout: row('de_ancient', '42'), stderr: '' }),
  });
  assert.equal((await readOfficialMapInventory(options.jobs)).manifest, recovered.manifest);
  assert.equal(recovered.manifest, '42');
  assert.deepEqual(
    officialInventoryFailure(
      Object.assign(Error(secret), { inventoryDiagnostic: { phase: secret, code: secret } }),
    ),
    { phase: 'storage', code: 'storage_unavailable' },
  );
});
