import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import {
  inspectViewmodelSource,
  viewmodelSourceBudget,
  viewmodelSourceSeeds,
} from './inspect-viewmodel-source.mjs';
import { steamAssetLimits } from './steam-assets-plan.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const text = (value) => Buffer.from(value + '\0');

// Original container fixtures, with no game model, animation, material or artwork bytes.
function resource(references = []) {
  const strings = references.map(text),
    tableBytes = references.length * 16,
    rerl = Buffer.alloc(8 + tableBytes + strings.reduce((sum, bytes) => sum + bytes.length, 0));
  rerl.writeUInt32LE(8);
  rerl.writeUInt32LE(references.length, 4);
  let stringOffset = 8 + tableBytes;
  strings.forEach((bytes, index) => {
    const position = 8 + index * 16;
    rerl.writeBigUInt64LE(BigInt(index + 1), position);
    rerl.writeInt32LE(stringOffset - position - 8, position + 8);
    bytes.copy(rerl, stringOffset);
    stringOffset += bytes.length;
  });
  const bytes = Buffer.alloc(28 + rerl.length);
  bytes.writeUInt32LE(bytes.length);
  bytes.writeUInt16LE(12, 4);
  bytes.writeUInt32LE(8, 8);
  bytes.writeUInt32LE(1, 12);
  bytes.write('RERL', 16);
  bytes.writeUInt32LE(8, 20);
  bytes.writeUInt32LE(rerl.length, 24);
  rerl.copy(bytes, 28);
  return bytes;
}
function vpk(records) {
  const groups = new Map(),
    payloads = [];
  let dataBytes = 0;
  for (const [name, payload] of records) {
    const slash = name.lastIndexOf('/'),
      dot = name.lastIndexOf('.'),
      extension = name.slice(dot + 1),
      folder = name.slice(0, slash),
      leaf = name.slice(slash + 1, dot),
      folders = groups.get(extension) ?? new Map(),
      rows = folders.get(folder) ?? [],
      entry = Buffer.alloc(18);
    entry.writeUInt32LE(crc32(payload));
    entry.writeUInt16LE(0x7fff, 6);
    entry.writeUInt32LE(dataBytes, 8);
    entry.writeUInt32LE(payload.length, 12);
    entry.writeUInt16LE(0xffff, 16);
    rows.push(Buffer.concat([text(leaf), entry]));
    folders.set(folder, rows);
    groups.set(extension, folders);
    payloads.push(payload);
    dataBytes += payload.length;
  }
  const parts = [];
  for (const [extension, folders] of groups) {
    parts.push(text(extension));
    for (const [folder, rows] of folders) parts.push(text(folder), ...rows, text(''));
    parts.push(text(''));
  }
  parts.push(text(''));
  const tree = Buffer.concat(parts),
    header = Buffer.alloc(12);
  header.writeUInt32LE(0x55aa1234);
  header.writeUInt32LE(1, 4);
  header.writeUInt32LE(tree.length, 8);
  return { bytes: Buffer.concat([header, tree, ...payloads]), dataOffset: 12 + tree.length };
}
async function fixture(records) {
  const root = await mkdtemp(join(tmpdir(), 'cswatch-viewmodel-plan-'));
  for (const group of ['csgo', 'core'])
    await mkdir(join(root, `game/${group}`), { recursive: true });
  const input = vpk(records),
    csgo = join(root, 'game/csgo/pak01_dir.vpk'),
    core = join(root, 'game/core/pak01_dir.vpk');
  await writeFile(csgo, input.bytes);
  await writeFile(core, vpk([]).bytes);
  return { root, csgo, core, input, close: () => rm(root, { recursive: true, force: true }) };
}
const disk = { statfs: async () => ({ bavail: 1024, bsize: 1024 ** 2 }) };

test('read-only fixed source plan follows CRC-verified dependencies and excludes full animation graphs', async () => {
  const material = 'materials/original-fixture.vmat_c',
    graph = 'animation/original-fixture.vnmgraph_c',
    otherClip = 'animation/original-fixture.vnmclip_c',
    rows = Object.values(viewmodelSourceSeeds).map((seed) => [
      seed,
      resource(seed === viewmodelSourceSeeds.arms ? [material, graph, otherClip] : []),
    ]);
  rows.push([material, resource([viewmodelSourceSeeds.arms])]);
  const s = await fixture(rows);
  try {
    const before = [hash(await readFile(s.csgo)), hash(await readFile(s.core))],
      result = await inspectViewmodelSource(
        { game: s.root, manifest: '18446744073709551615' },
        disk,
      );
    assert.equal(result.source.manifest, '18446744073709551615');
    assert.equal(result.source.officialSourceRevalidated, false);
    assert.equal(result.source.evidence, 'operator-selected-local-indexes');
    assert.equal(result.boundedResourceClosureComplete, true);
    assert.equal(result.shaderPreflightPerformed, false);
    assert.equal(result.sourceBytes.isLowerBound, false);
    assert.equal(result.resources.length, 6);
    assert.deepEqual(result.excludedAnimationResources, [graph, otherClip]);
    assert.deepEqual(result.missingFromIndex, []);
    assert.ok(result.resources.every((row) => row.status === 'crc_verified'));
    assert.equal(
      result.sourceBytes.crcVerifiedCached,
      rows.reduce((sum, [, bytes]) => sum + bytes.length, 0),
    );
    assert.equal(result.sourceBytes.attemptedReads, result.sourceBytes.crcVerifiedCached);
    assert.equal(result.budget.minimumAdditionalSourceCacheBytes, 0);
    assert.equal(result.budget.steamTransferBytes, null);
    assert.equal(result.budget.conversionHeadroomBytes, null);
    assert.equal(result.budget.isCompletePreparationEstimate, false);
    assert.equal(JSON.stringify(result).includes(s.root), false);
    assert.deepEqual([hash(await readFile(s.csgo)), hash(await readFile(s.core))], before);
  } finally {
    await s.close();
  }
});

test('missing or corrupt seed bytes remain a lower bound and cannot establish a complete closure', async () => {
  const rows = Object.values(viewmodelSourceSeeds).map((seed) => [seed, resource()]),
    s = await fixture(rows);
  try {
    const mutated = Buffer.from(s.input.bytes);
    mutated[s.input.dataOffset] ^= 1;
    await writeFile(s.csgo, mutated);
    const result = await inspectViewmodelSource({ game: s.root, manifest: '1' }, disk);
    assert.equal(result.boundedResourceClosureComplete, false);
    assert.equal(result.resources[0].status, 'missing_or_crc_invalid');
    assert.equal(result.resources[0].sha256, undefined);
    assert.equal(result.sourceBytes.isLowerBound, true);
    assert.equal(
      result.sourceBytes.indexedSeeds,
      rows.reduce((sum, [, bytes]) => sum + bytes.length, 0),
    );
    assert.equal(result.sourceBytes.missingOrCrcInvalid, rows[0][1].length);
    assert.equal(result.sourceBytes.attemptedReads, result.sourceBytes.indexedSeeds);
  } finally {
    await s.close();
  }
});

test('a missing index entry has no invented size and does not become native readiness', async () => {
  const s = await fixture([[viewmodelSourceSeeds.weapon, resource(['materials/missing.vmat'])]]);
  try {
    const result = await inspectViewmodelSource({ game: s.root, manifest: '1' }, disk);
    assert.equal(result.boundedResourceClosureComplete, false);
    assert.equal(result.sourceBytes.isLowerBound, true);
    assert.equal(result.resources.length, 1);
    assert.ok(result.missingFromIndex.includes(viewmodelSourceSeeds.arms));
    assert.ok(result.missingFromIndex.includes('materials/missing.vmat_c'));
    assert.equal(result.sourceBytes.missingOrCrcInvalid, 0);
    assert.equal('ready' in result, false);
  } finally {
    await s.close();
  }
});

test('source-cache payload floor preserves the reserve and separates unmeasured transfer/conversion', () => {
  const reserve = steamAssetLimits.reserveBytes,
    result = viewmodelSourceBudget({
      missingSourceBytes: 1163745,
      availableBytes: 198 * 1024 ** 2,
    });
  assert.equal(result.reserveBytes, 512 * 1024 ** 2);
  assert.equal(result.reserveSatisfied, false);
  assert.equal(result.minimumAdditionalSourceCacheBytes, reserve + 1163745 - 198 * 1024 ** 2);
  assert.equal(
    viewmodelSourceBudget({ missingSourceBytes: 0, availableBytes: reserve }).reserveSatisfied,
    true,
  );
  for (const value of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() =>
      viewmodelSourceBudget({ missingSourceBytes: value, availableBytes: reserve }),
    );
    assert.throws(() => viewmodelSourceBudget({ missingSourceBytes: 0, availableBytes: value }));
  }
  assert.throws(() =>
    viewmodelSourceBudget({ missingSourceBytes: Number.MAX_SAFE_INTEGER, availableBytes: 0 }),
  );
});

test('invalid manifest pins and paths fail before any source inspection', async () => {
  const index = async () => assert.fail('Invalid source options must not reach local inspection.');
  for (const manifest of [
    1,
    0,
    '',
    '0',
    '01',
    '18446744073709551616',
    'https://example.test',
    undefined,
  ])
    await assert.rejects(inspectViewmodelSource({ game: '/unused', manifest }, { index }));
  for (const game of ['', undefined, 5])
    await assert.rejects(inspectViewmodelSource({ game, manifest: '1' }, { index }));
});

test('planning counts failed reads toward its cap and never allocates an oversized resource', async () => {
  let reads = 0;
  const entries = new Map(
    Object.values(viewmodelSourceSeeds).map((seed) => [
      seed,
      { length: 32 * 1024 ** 2, preloadBytes: 0 },
    ]),
  );
  const fakeIndex = {
    entries,
    readEntry: async () => {
      reads++;
      return undefined;
    },
    provenance: { sha256: 'a'.repeat(64), bytes: 1, entries: entries.size },
  };
  await assert.rejects(
    inspectViewmodelSource(
      { game: '/unused', manifest: '1' },
      { index: async () => fakeIndex, ...disk },
    ),
    /reads exceed 128 MiB/,
  );
  assert.equal(reads, 4);
  reads = 0;
  const large = {
    ...fakeIndex,
    entries: new Map([
      [viewmodelSourceSeeds.arms, { length: 32 * 1024 ** 2 + 1, preloadBytes: 0 }],
    ]),
  };
  const result = await inspectViewmodelSource(
    { game: '/unused', manifest: '1' },
    { index: async () => large, ...disk },
  );
  assert.equal(reads, 0);
  assert.equal(result.resources[0].status, 'uninspected_over_limit');
  assert.equal(result.boundedResourceClosureComplete, false);
  assert.equal(result.sourceBytes.uninspectedOverLimit, 32 * 1024 ** 2 + 1);
});

test('a verified resource cannot expand the fixed planning graph beyond its bounded count', async () => {
  const payload = resource(
    Array.from({ length: 512 }, (_, index) => `materials/original-fixture-${index}.vmat`),
  );
  let reads = 0;
  const index = {
    entries: new Map([[viewmodelSourceSeeds.arms, { length: payload.length, preloadBytes: 0 }]]),
    readEntry: async () => {
      reads++;
      return payload;
    },
    provenance: { sha256: 'a'.repeat(64), bytes: 1, entries: 1 },
  };
  await assert.rejects(
    inspectViewmodelSource(
      { game: '/unused', manifest: '1' },
      { index: async () => index, ...disk },
    ),
    /graph exceeds 512 resources/,
  );
  assert.equal(reads, 1);
});
