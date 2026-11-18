import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertPreparedModelStorage, writePreparedModel } from './prepared-model-output.mjs';
import { steamAssetLimits } from './steam-assets-plan.mjs';

test('encoded GLB budget uses the exact bytes plus reserve and retains the 2 GiB per-model bound', () => {
  const reserve = BigInt(steamAssetLimits.reserveBytes);
  assert.doesNotThrow(() => assertPreparedModelStorage(24, reserve + 24n));
  assert.doesNotThrow(() =>
    assertPreparedModelStorage(
      steamAssetLimits.modelBytes,
      reserve + BigInt(steamAssetLimits.modelBytes),
    ),
  );
  assert.throws(() => assertPreparedModelStorage(24, reserve + 23n), /512 MiB reserve/);
  for (const size of [23, 0, -1, 24.5, NaN, Infinity, steamAssetLimits.modelBytes + 1])
    assert.throws(() => assertPreparedModelStorage(size, reserve + 10n ** 20n), /2 GiB/);
});

test('prepared model checks free bytes before exclusive output and never overwrites an existing model', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cswatch-exact-model-output-'));
  try {
    const path = join(root, 'scene.glb');
    const bytes = Buffer.alloc(32, 7);
    const storage = (available) => async (directory, options) => {
      assert.equal(directory, root);
      assert.deepEqual(options, { bigint: true });
      return { bavail: available, bsize: 1n };
    };
    const threshold = BigInt(bytes.length + steamAssetLimits.reserveBytes);
    await assert.rejects(
      writePreparedModel(path, bytes, { storage: storage(threshold - 1n) }),
      /reserve/,
    );
    assert.deepEqual(await readdir(root), []);
    assert.equal(
      await writePreparedModel(path, bytes, { storage: storage(threshold) }),
      bytes.length,
    );
    await assert.rejects(
      writePreparedModel(path, Buffer.alloc(32, 8), { storage: storage(threshold) }),
      { code: 'EEXIST' },
    );
    assert.deepEqual(await readFile(path), bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
