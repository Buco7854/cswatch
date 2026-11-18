import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { cleanupSourceExports } from './cleanup-source-exports.mjs';
import { verifyPreparedGlb } from './prepared-glb.mjs';
import { triangle } from './fixtures/embedded-glb.mjs';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cswatch-source-cleanup-'));
  const stage = join(root, 'private-map-stage');
  const sources = [
    join(stage, 'de_fixture-export-0', 'scene.gltf'),
    join(stage, 'de_fixture-sky-export-1', 'scene.gltf'),
  ];
  for (const source of sources) {
    await mkdir(dirname(source), { recursive: true });
    await writeFile(source, '{"asset":{"version":"2.0"}}');
    await writeFile(join(dirname(source), 'texture.png'), 'Original synthetic source texture');
  }
  const mergedInput = join(stage, 'prepared', '.environment-private', 'merged.glb');
  await mkdir(dirname(mergedInput), { recursive: true });
  await writeFile(mergedInput, triangle());
  const provenance = join(stage, 'prepared', 'environments', 'de_fixture', 'provenance.json');
  await mkdir(dirname(provenance), { recursive: true });
  await writeFile(
    provenance,
    JSON.stringify({ schemaVersion: 1, map: 'de_fixture', assetVersion: 'test-build' }),
  );
  const retained = [
    join(root, 'operator-input.gltf'),
    join(root, 'steam-cache.vpk'),
    join(stage, 'prepared', 'environments', 'de_fixture', 'px.png'),
    join(stage, 'installer.log'),
  ];
  for (const file of retained) await writeFile(file, 'Must survive source cleanup');
  const options = {
    stage,
    map: 'de_fixture',
    assetVersion: 'test-build',
    mergedInput,
    sources,
    provenance,
  };
  return { root, options, retained, close: () => rm(root, { recursive: true, force: true }) };
}

test('verified embedded merge reclaims only this map’s superseded exports and records original hashes privately', async () => {
  const s = await fixture();
  try {
    const expectedHash = createHash('sha256')
      .update(await readFile(s.options.sources[0]))
      .digest('hex');
    const report = await cleanupSourceExports(s.options);
    assert.equal(report.sources.length, 2);
    assert.ok(report.bytes > 0 && report.files === 4);
    assert.equal(report.sources[0].sha256, expectedHash);
    assert.deepEqual(report.verifiedMerged, await verifyPreparedGlb(s.options.mergedInput));
    assert.deepEqual(JSON.parse(await readFile(s.options.provenance)).sourceExportsCleaned, report);
    for (const source of s.options.sources)
      await assert.rejects(readFile(source), { code: 'ENOENT' });
    for (const path of s.retained)
      assert.equal(await readFile(path, 'utf8'), 'Must survive source cleanup');
    assert.ok((await readdir(s.options.stage)).includes('prepared'));
  } finally {
    await s.close();
  }
});

test('external, linked, or merged-result source paths fail before either source is removed', async () => {
  for (const mode of ['external', 'symlink', 'merged']) {
    const s = await fixture();
    try {
      let options = s.options;
      if (mode === 'external')
        options = { ...options, sources: [s.retained[0], options.sources[1]] };
      else if (mode === 'symlink')
        await symlink(s.retained[0], join(dirname(options.sources[0]), 'linked-input'));
      else options = { ...options, mergedInput: join(dirname(options.sources[0]), 'merged.glb') };
      await assert.rejects(cleanupSourceExports(options), /cleanup|links/i);
      for (const source of s.options.sources) assert.ok((await readFile(source)).length);
      for (const path of s.retained)
        assert.equal(await readFile(path, 'utf8'), 'Must survive source cleanup');
    } finally {
      await s.close();
    }
  }
});

test('a merged file that still depends on external data cannot authorize original export cleanup', async () => {
  const s = await fixture();
  try {
    await writeFile(
      s.options.mergedInput,
      triangle((data) => {
        data.buffers[0].uri = '../source.bin';
      }),
    );
    await assert.rejects(cleanupSourceExports(s.options), /self-contained/);
    for (const source of s.options.sources) assert.ok((await readFile(source)).length);
    assert.equal(JSON.parse(await readFile(s.options.provenance)).sourceExportsCleaned, undefined);
    await writeFile(
      s.options.mergedInput,
      triangle((data) => {
        data.bufferViews[0].byteLength = 1000;
      }),
    );
    await assert.rejects(cleanupSourceExports(s.options), /escapes its embedded binary/);
    for (const source of s.options.sources) assert.ok((await readFile(source)).length);
  } finally {
    await s.close();
  }
});
