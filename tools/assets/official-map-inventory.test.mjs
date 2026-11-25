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
import { toolchainPreparationLimits } from './prepare-toolchain.mjs';
const row = (map = 'de_mirage', manifest = '18446744073709551615') =>
  `2347770\t${manifest}\t${'a'.repeat(40)}\t100\tgame/csgo/maps/${map}.vpk`;

function controlledDeadlines(t) {
  let clock = 0;
  const deadlines = [];
  t.mock.method(AbortSignal, 'timeout', (duration) => {
    const controller = new AbortController();
    deadlines.push({ duration, due: clock + duration, controller });
    return controller.signal;
  });
  return {
    deadlines,
    advance(milliseconds) {
      clock += milliseconds;
      for (const deadline of deadlines)
        if (deadline.due <= clock && !deadline.controller.signal.aborted)
          deadline.controller.abort(
            new DOMException('Controlled bounded deadline.', 'TimeoutError'),
          );
    },
  };
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function deadlineFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cswatch-inventory-deadline-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = {
    jobs: join(root, 'jobs'),
    cache: join(root, 'cache'),
    assets: join(root, 'assets'),
  };
  await mkdir(options.assets);
  await prepareMapJobs(options.jobs);
  return {
    options,
    adapters: { storage: async () => {}, reserve: async () => {} },
  };
}

test('cold tool preparation can cross the old metadata deadline before a separate bounded listing succeeds', async (t) => {
  const clock = controlledDeadlines(t),
    f = await deadlineFixture(t),
    entered = deferred(),
    tools = deferred();
  let bootstrapSignal, listingSignal;
  const work = refreshOfficialMapInventory(f.options, {
    ...f.adapters,
    prepareToolchain: async ({ signal }) => {
      bootstrapSignal = signal;
      entered.resolve();
      return tools.promise;
    },
    run: async (_command, _args, context) => {
      listingSignal = context.signal;
      assert.equal(context.timeoutMs, 120000);
      assert.deepEqual(
        clock.deadlines.map((value) => value.duration),
        [toolchainPreparationLimits.timeoutMs, 180000],
      );
      clock.advance(120000);
      assert.equal(context.signal.aborted, false);
      return { code: 0, stdout: row(), stderr: '' };
    },
  });
  await entered.promise;
  assert.equal(toolchainPreparationLimits.timeoutMs, 20 * 60 * 1000);
  assert.deepEqual(
    clock.deadlines.map((value) => value.duration),
    [20 * 60 * 1000],
  );
  clock.advance(4 * 60 * 1000);
  assert.equal(bootstrapSignal.aborted, false);
  tools.resolve({ downloader: '/fixed/trusted/tool' });
  const inventory = await work;
  assert.notEqual(bootstrapSignal, listingSignal);
  assert.deepEqual(await readOfficialMapInventory(f.options.jobs), inventory);
});

test('controlled bootstrap deadlines and operator aborts classify generic child cancellation separately without Steam', async (t) => {
  const clock = controlledDeadlines(t);
  for (const operator of [false, true]) {
    const f = await deadlineFixture(t),
      caller = new AbortController(),
      entered = deferred();
    let downloads = 0;
    const work = assert.rejects(
      refreshOfficialMapInventory(
        { ...f.options, signal: caller.signal },
        {
          ...f.adapters,
          prepareToolchain: ({ signal }) =>
            new Promise((_resolve, reject) => {
              signal.addEventListener(
                'abort',
                () => reject(Error('Toolchain command was cancelled or exceeded its time limit.')),
                { once: true },
              );
              entered.resolve();
            }),
          run: async () => {
            downloads++;
            throw Error('No Steam work may start.');
          },
        },
      ),
      (error) => {
        assert.deepEqual(error.inventoryDiagnostic, {
          phase: 'toolchain',
          code: operator ? 'interrupted' : 'timeout',
        });
        return true;
      },
    );
    await entered.promise;
    if (operator)
      caller.abort(new DOMException('Private operator reason must not be logged.', 'AbortError'));
    else clock.advance(toolchainPreparationLimits.timeoutMs);
    await work;
    assert.equal(downloads, 0);
    assert.equal(await readOfficialMapInventory(f.options.jobs), undefined);
  }
});

test('listing deadline starts after bootstrap and preserves timeout identity through generic downloader cancellation', async (t) => {
  const clock = controlledDeadlines(t),
    f = await deadlineFixture(t),
    entered = deferred();
  const work = assert.rejects(
    refreshOfficialMapInventory(f.options, {
      ...f.adapters,
      prepareToolchain: async () => {
        clock.advance(4 * 60 * 1000);
        return { downloader: '/fixed/trusted/tool' };
      },
      run: async (_command, _args, { signal, timeoutMs }) => {
        assert.equal(timeoutMs, 120000);
        entered.resolve();
        await new Promise((_resolve, reject) =>
          signal.addEventListener(
            'abort',
            () => reject(Error('Operator asset installation was cancelled.')),
            { once: true },
          ),
        );
      },
    }),
    (error) => {
      assert.deepEqual(error.inventoryDiagnostic, { phase: 'downloader', code: 'timeout' });
      return true;
    },
  );
  await entered.promise;
  assert.deepEqual(
    clock.deadlines.map((value) => value.duration),
    [20 * 60 * 1000, 180000],
  );
  clock.advance(180000);
  await work;
  assert.equal(await readOfficialMapInventory(f.options.jobs), undefined);
});

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

const addonRow = (map = 'de_mirage', manifest = '42', folder = map) =>
  `2347773\t${manifest}\t${'b'.repeat(40)}\t200\tgame/csgo_community_addons/${folder}/${map}_dir.vpk`;

test('official community addons are recorded on their own map from the platform depot', () => {
  const inventory = parseOfficialMapInventory(
    [row('de_mirage'), row('de_dust2'), addonRow('de_mirage'), addonRow('de_absent')].join('\n'),
  );
  assert.deepEqual(inventory.maps.find((m) => m.map === 'de_mirage').addon, {
    manifest: '42',
    sha1: 'b'.repeat(40),
    bytes: 200,
  });
  assert.equal(inventory.maps.find((m) => m.map === 'de_dust2').addon, undefined);
  // An addon file that is not named after its own folder is observed but never membership.
  assert.equal(
    parseOfficialMapInventory([row(), addonRow('de_mirage', '42', 'de_dust2')].join('\n')).maps[0]
      .addon,
    undefined,
  );
  for (const text of [
    [row(), addonRow(), addonRow()].join('\n'),
    [row(), addonRow('de_mirage', '42'), addonRow('de_dust2', '43')].join('\n'),
    [row(), addonRow().replace('csgo_community_addons/de_mirage', 'csgo/../x')].join('\n'),
    [row(), addonRow().replace('2347773', '2347771')].join('\n'),
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
      assert.deepEqual(args, [
        'ls',
        '730',
        '2347770',
        '2347773',
        '--anonymous',
        '--',
        'game/csgo/maps/*.vpk',
        'game/csgo_community_addons/*/*_dir.vpk',
      ]);
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
          throw Error('Toolchain command was cancelled or exceeded its time limit.');
        },
      },
      { phase: 'toolchain', code: 'timeout' },
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
