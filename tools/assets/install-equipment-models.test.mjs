import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installEquipmentModels } from './install-equipment-models.mjs';
test('operator model installer rejects linked roots before any downloader or bootstrap work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cswatch-equipment-roots-'));
  try {
    const real = join(root, 'real');
    await mkdir(real);
    for (const kind of ['cache', 'game', 'output', 'models']) {
      const folder = join(root, kind);
      await mkdir(folder);
      const output = join(folder, 'output'),
        cache = join(folder, 'cache');
      if (kind === 'cache') await symlink(real, cache);
      else {
        await mkdir(cache);
        if (kind === 'game') await symlink(real, join(cache, 'steam'));
      }
      if (kind === 'output') await symlink(real, output);
      else {
        await mkdir(output);
        if (kind === 'models') await symlink(real, join(output, 'equipment-models'));
      }
      let calls = 0;
      await assert.rejects(
        () =>
          installEquipmentModels(
            { items: 'ak47', manifest: '6678473446694075055', cache, output },
            {
              prepareToolchain: async () => {
                calls++;
                throw Error('Bootstrap must never run');
              },
              run: async () => {
                calls++;
                throw Error('Downloader must never run');
              },
            },
          ),
        /real directories/,
      );
      assert.equal(calls, 0);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('operator model installer requires exact IDs and exact uint64 pinned manifest before side effects', async () => {
  for (const options of [
    { items: '*', manifest: '1' },
    { items: 'ak47', manifest: '1.5' },
    { items: 'ak47', manifest: '18446744073709551616' },
    { items: 'ak47', manifest: undefined },
  ]) {
    await assert.rejects(() =>
      installEquipmentModels({ ...options, output: '/unopened-output', cache: '/unopened-cache' }),
    );
  }
});
