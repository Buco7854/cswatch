import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildNetworkDeny } from './build-network-deny.mjs';
import { prepareGameplaySoundBank, canonicalizeNativePCM } from './prepare-gameplay-sounds.mjs';
import { allocatedStorage } from './asset-storage.mjs';
import { inspectGameplayAudio } from '../../shared/gameplay-sound-files.mjs';
function wav() {
  const data = Buffer.alloc(1644);
  data.write('RIFF');
  data.writeUInt32LE(1636, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(8000, 24);
  data.writeUInt32LE(16000, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(1600, 40);
  return data;
}
test('only the native exporter odd PCM tail is padded without changing a sample or weakening served validation', () => {
  const input = wav().subarray(0, 145);
  input.writeUInt32LE(input.length - 8, 4);
  input.writeUInt16LE(1, 22);
  input.writeUInt32LE(8000, 28);
  input.writeUInt16LE(1, 32);
  input.writeUInt16LE(8, 34);
  input.writeUInt32LE(101, 40);
  assert.throws(() => inspectGameplayAudio(input));
  const result = canonicalizeNativePCM(input);
  assert.equal(result.normalization, 'riff-tail-padding');
  assert.deepEqual(result.data.subarray(44, 145), input.subarray(44));
  assert.equal(result.data.length, 146);
  assert.equal(inspectGameplayAudio(result.data).durationMs, (101 / 8000) * 1000);
  const corrupt = Buffer.from(input);
  corrupt.writeUInt16LE(85, 20);
  assert.throws(() => canonicalizeNativePCM(corrupt));
  assert.equal(canonicalizeNativePCM(wav()).normalization, 'native-pcm');
});
test('fixed native bank publishes only decoded/bounded samples with exact hashes and immutable source pin', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sound-bank-'));
  const networkDeny = buildNetworkDeny(join(root, 'boundary'));
  try {
    const input = join(root, 'input'),
      output = join(root, 'output');
    await mkdir(input);
    await mkdir(output);
    await writeFile(join(input, 'ak47-fire.wav'), wav());
    const result = await prepareGameplaySoundBank({
      input,
      output,
      networkDeny,
      items: ['ak47-fire', 'awp-fire'],
      source: { appId: 730, depotId: 2347770, manifest: '123' },
    });
    assert.equal(result.report.prepared.length, 1);
    assert.deepEqual(result.report.unsupported, [
      { id: 'awp-fire', reason: 'native-format-unavailable' },
    ]);
    const descriptor = JSON.parse(
      await readFile(join(output, 'sounds/ak47-fire/manifest.json'), 'utf8'),
    );
    assert.equal(descriptor.durationMs, 100);
    assert.equal(descriptor.sha256.length, 64);
    for (const name of ['sounds', 'sounds/ak47-fire'])
      assert.equal((await stat(join(output, name))).mode & 0o777, 0o755);
    for (const name of [
      'sounds/provenance.json',
      'sounds/ak47-fire/manifest.json',
      'sounds/ak47-fire/sound.wav',
    ])
      assert.equal((await stat(join(output, name))).mode & 0o777, 0o644);
    await assert.rejects(
      () =>
        prepareGameplaySoundBank({
          input,
          output,
          networkDeny,
          source: { appId: 730, depotId: 2347770, manifest: '123' },
        }),
      /exists/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('sound preparation refuses unknown ids, linked input/output directories and deceptive formats', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sound-bank-invalid-'));
  const networkDeny = buildNetworkDeny(join(root, 'boundary'));
  try {
    const input = join(root, 'input'),
      output = join(root, 'output');
    await mkdir(input);
    await mkdir(output);
    const source = { appId: 730, depotId: 2347770, manifest: '123' };
    await assert.rejects(
      () => prepareGameplaySoundBank({ input, output, networkDeny, source, items: ['../../x'] }),
      /Unknown/,
    );
    await symlink(input, join(root, 'linked'));
    await assert.rejects(
      () => prepareGameplaySoundBank({ input: join(root, 'linked'), output, networkDeny, source }),
      /symlink|link|director/i,
    );
    await writeFile(join(input, 'ak47-fire.wav'), Buffer.alloc(200));
    await assert.rejects(() =>
      prepareGameplaySoundBank({ input, output, networkDeny, source, items: ['ak47-fire'] }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('prepared sound accounting uses the asset budget above16GiB and rejects a full32GiB root before publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sound-prepared-budget-')),
    networkDeny = buildNetworkDeny(join(root, 'boundary')),
    input = join(root, 'input');
  await mkdir(input);
  await writeFile(join(input, 'ak47-fire.wav'), wav());
  const GiB = 1024 ** 3,
    assetLimit = 32 * GiB;
  try {
    for (const existingAssets of [17 * GiB, assetLimit - 1]) {
      const output = join(root, String(existingAssets));
      await mkdir(output);
      await writeFile(join(output, 'operator-sentinel'), 'keep');
      let reserveCalls = 0,
        budgetCalls = 0;
      const prepare = () =>
        prepareGameplaySoundBank(
          {
            input,
            output,
            networkDeny,
            items: ['ak47-fire'],
            source: { appId: 730, depotId: 2347770, manifest: '123' },
            beforePublish: async () => {
              budgetCalls++;
              assert.equal(await readFile(join(output, 'operator-sentinel'), 'utf8'), 'keep');
              const stages = (await readdir(output)).filter((name) =>
                /^\.sounds-[a-zA-Z0-9]{6}$/.test(name),
              );
              assert.equal(stages.length, 1);
              assert.equal((await stat(join(output, stages[0]))).mode & 0o777, 0o700);
              assert.deepEqual(
                await readFile(join(output, stages[0], 'ak47-fire/sound.wav')),
                wav(),
              );
              const actual = await allocatedStorage(output);
              if (existingAssets + actual.physicalBytes > assetLimit)
                throw Object.assign(Error('Prepared asset storage exhausted'), {
                  code: 'ASSET_STORAGE_LIMIT',
                });
            },
          },
          {
            reserve: async (first, second, needed) => {
              reserveCalls++;
              assert.equal(first, output);
              assert.equal(second, output);
              assert.equal(needed, wav().length + 16384);
            },
          },
        );
      if (existingAssets < assetLimit - 1) {
        const result = await prepare();
        assert.equal(result.report.prepared.length, 1);
        assert.deepEqual(await readFile(join(output, 'sounds/ak47-fire/sound.wav')), wav());
      } else {
        await assert.rejects(prepare, (error) => error.code === 'ASSET_STORAGE_LIMIT');
        assert.deepEqual(await readdir(output), ['operator-sentinel']);
      }
      assert.equal(reserveCalls, 1);
      assert.equal(budgetCalls, 1);
      assert.equal(await readFile(join(output, 'operator-sentinel'), 'utf8'), 'keep');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
