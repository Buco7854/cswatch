import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  open,
  readdir,
  symlink,
  readlink,
  link,
  mkdir,
  chmod,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { updateMapCatalog } from './update-map-catalog.mjs';
import { mapCatalogLimits, readMapCatalog } from '../../backend/dist/map-catalog.js';

const original = { schemaVersion: 1, entries: [] };
const approved = {
  schemaVersion: 1,
  entries: [
    {
      identity: {
        map: 'de_original_fixture',
        buildNum: 123,
        patchVersion: 456,
        demoVersionGuid: '12345678-abcd-1234-5678-123456789abc',
        addonPresence: 'none',
      },
      source: { appId: 730, depotId: 2347770, manifest: '123456789', mapSha256: 'a'.repeat(64) },
      assetVersion: 'synthetic-catalog-test',
    },
  ],
};
const input = (catalog) => Readable.from([JSON.stringify(catalog)]);
const enabled = process.platform === 'linux';
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'cswatch-catalog-maintenance-'));
  const filename = join(root, 'catalog.json');
  try {
    await writeFile(filename, JSON.stringify(original), { mode: 0o640 });
    await run({ root, filename });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test(
  'reviewed catalog replacement is schema-validated, atomic, durable and readable through the application catalog contract',
  { skip: !enabled },
  async () =>
    fixture(async ({ root, filename }) => {
      const old = await open(filename, constants.O_RDONLY);
      try {
        const before = await old.stat();
        const result = await updateMapCatalog({ filename, input: input(approved) });
        assert.equal(result.entries, 1);
        assert.deepEqual(await readMapCatalog(filename), approved);
        assert.equal(await old.readFile('utf8'), JSON.stringify(original));
        const current = await open(filename, constants.O_RDONLY);
        try {
          const after = await current.stat();
          assert.notEqual(before.ino, after.ino);
          assert.equal(after.mode & 0o777, 0o640);
        } finally {
          await current.close();
        }
        assert.deepEqual((await readdir(root)).sort(), ['.catalog-update.lock', 'catalog.json']);
      } finally {
        await old.close();
      }
    }),
);

test(
  'invalid, oversized, incomplete and non-UTF8 input never changes the active catalog',
  { skip: !enabled },
  async () =>
    fixture(async ({ root, filename }) => {
      for (const invalid of [
        { ...approved, unknown: true },
        {
          ...approved,
          entries: [
            { ...approved.entries[0], source: { ...approved.entries[0].source, appId: 999 } },
          ],
        },
        {
          ...approved,
          entries: [
            {
              ...approved.entries[0],
              identity: { ...approved.entries[0].identity, buildNum: undefined },
            },
          ],
        },
      ])
        await assert.rejects(updateMapCatalog({ filename, input: input(invalid) }));
      await assert.rejects(updateMapCatalog({ filename, input: Readable.from(['{']) }));
      await assert.rejects(
        updateMapCatalog({ filename, input: Readable.from([Buffer.from([0xff, 0xff])]) }),
      );
      let continued = false;
      async function* oversized() {
        yield Buffer.alloc(mapCatalogLimits.bytes + 1, 32);
        continued = true;
        yield '{}';
      }
      await assert.rejects(updateMapCatalog({ filename, input: oversized() }), /byte limit/);
      assert.equal(continued, false);
      assert.equal(await readFile(filename, 'utf8'), JSON.stringify(original));
      assert.deepEqual(await readdir(root), ['catalog.json']);
    }),
);

test(
  'catalog and ancestor symlinks, hardlinks and FIFOs are refused without touching their targets',
  { skip: !enabled },
  async () =>
    fixture(async ({ root, filename }) => {
      const actual = join(root, 'operator-original');
      await writeFile(actual, 'preserve-original', { mode: 0o640 });
      await rm(filename);
      await symlink(actual, filename);
      await assert.rejects(updateMapCatalog({ filename, input: input(approved) }));
      assert.equal(await readlink(filename), actual);
      assert.equal(await readFile(actual, 'utf8'), 'preserve-original');
      const linked = join(root, 'linked-directory');
      await symlink(root, linked);
      await assert.rejects(
        updateMapCatalog({ filename: join(linked, 'catalog.json'), input: input(approved) }),
      );
      assert.equal(await readlink(linked), root);
      await rm(filename);
      await link(actual, filename);
      await assert.rejects(updateMapCatalog({ filename, input: input(approved) }));
      assert.equal(await readFile(actual, 'utf8'), 'preserve-original');
      await rm(filename);
      assert.equal(spawnSync('mkfifo', [filename]).status, 0);
      await assert.rejects(updateMapCatalog({ filename, input: input(approved) }));
      assert.equal(
        (await readdir(root)).some((name) => /^\.catalog-[a-f0-9]+\.tmp$/.test(name)),
        false,
      );
    }),
);

test(
  'real inherited flock serializes maintenance and releases without replacing the lock inode',
  { skip: !enabled },
  async () =>
    fixture(async ({ root, filename }) => {
      const path = join(root, '.catalog-update.lock'),
        held = await open(path, constants.O_RDWR | constants.O_CREAT, 0o600);
      try {
        assert.equal(
          spawnSync('flock', ['-n', '3'], { stdio: ['ignore', 'ignore', 'ignore', held.fd] })
            .status,
          0,
        );
        await assert.rejects(updateMapCatalog({ filename, input: input(approved) }));
        assert.equal(await readFile(filename, 'utf8'), JSON.stringify(original));
      } finally {
        await held.close();
      }
      assert.equal((await updateMapCatalog({ filename, input: input(approved) })).entries, 1);
    }),
);

test(
  'CLI accepts bounded stdin only and rejects unsafe control-directory ownership modes',
  { skip: !enabled },
  async () =>
    fixture(async ({ root, filename }) => {
      const cli = new URL('./update-map-catalog.mjs', import.meta.url).pathname;
      const result = spawnSync(process.execPath, [cli], {
        env: { ...process.env, MAP_CATALOG_FILE: filename },
        input: JSON.stringify(approved),
        encoding: 'utf8',
        timeout: 5000,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).entries, 1);
      assert.equal(
        spawnSync(process.execPath, [cli, '--url', 'https://example.invalid'], {
          input: '{}',
          encoding: 'utf8',
          timeout: 5000,
        }).status,
        1,
      );
      const unsafe = join(root, 'unsafe');
      await mkdir(unsafe, { mode: 0o700 });
      await chmod(unsafe, 0o777);
      await assert.rejects(
        updateMapCatalog({ filename: join(unsafe, 'catalog.json'), input: input(approved) }),
      );
      await assert.rejects(
        updateMapCatalog({ filename: join(root, 'other.json'), input: input(approved) }),
      );
    }),
);
