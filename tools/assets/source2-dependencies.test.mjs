import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  open,
  readFile,
  rm,
  symlink,
  writeFile,
  rename,
  link,
  unlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  dependencyLimits,
  readVpkDirectory,
  resourcePath,
  scanSource2Dependencies,
  source2References,
} from './source2-dependencies.mjs';

// Original binary fixtures exercise only documented container framing, never game content.
const u32 = (number) => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(number);
  return bytes;
};
const text = (value) => Buffer.from(value + '\0');
function resource(references = []) {
  const strings = references.map(text),
    tableSize = references.length * 16;
  const rerl = Buffer.alloc(8 + tableSize + strings.reduce((sum, bytes) => sum + bytes.length, 0));
  rerl.writeUInt32LE(8);
  rerl.writeUInt32LE(references.length, 4);
  let stringOffset = 8 + tableSize;
  references.forEach((_reference, index) => {
    const at = 8 + index * 16;
    rerl.writeBigUInt64LE(BigInt(index + 1), at);
    rerl.writeInt32LE(stringOffset - (at + 8), at + 8);
    strings[index].copy(rerl, stringOffset);
    stringOffset += strings[index].length;
  });
  const bytes = Buffer.alloc(28 + rerl.length);
  bytes.writeUInt32LE(bytes.length);
  bytes.writeUInt16LE(12, 4);
  bytes.writeUInt16LE(1, 6);
  bytes.writeUInt32LE(8, 8);
  bytes.writeUInt32LE(1, 12);
  bytes.write('RERL', 16);
  bytes.writeUInt32LE(8, 20);
  bytes.writeUInt32LE(rerl.length, 24);
  rerl.copy(bytes, 28);
  return bytes;
}
function vpk(records, { version = 2 } = {}) {
  const groups = new Map(),
    data = [],
    archives = new Map();
  let embeddedOffset = 0;
  for (const record of records) {
    const slash = record.resource.lastIndexOf('/'),
      dot = record.resource.lastIndexOf('.');
    const extension = dot > slash ? record.resource.slice(dot + 1) : ' ',
      folder = slash < 0 ? ' ' : record.resource.slice(0, slash),
      name = record.resource.slice(slash + 1, dot > slash ? dot : undefined);
    const folders = groups.get(extension) ?? new Map(),
      names = folders.get(folder) ?? [];
    const bytes = record.bytes,
      preloadBytes = record.preloadBytes ?? 0,
      prefix = bytes.subarray(0, preloadBytes),
      remaining = bytes.subarray(preloadBytes),
      archive = record.archiveIndex ?? 0x7fff;
    let start;
    if (archive === 0x7fff) {
      start = embeddedOffset;
      data.push(remaining);
      embeddedOffset += remaining.length;
    } else {
      const previous = archives.get(archive) ?? Buffer.alloc(record.archiveOffset ?? 0);
      start = previous.length;
      archives.set(archive, Buffer.concat([previous, remaining]));
    }
    const entry = Buffer.alloc(18);
    entry.writeUInt32LE(crc32(bytes));
    entry.writeUInt16LE(preloadBytes, 4);
    entry.writeUInt16LE(archive, 6);
    entry.writeUInt32LE(record.startOverride ?? start, 8);
    entry.writeUInt32LE(record.declaredLength ?? remaining.length, 12);
    entry.writeUInt16LE(0xffff, 16);
    names.push(Buffer.concat([text(name), entry, prefix]));
    folders.set(folder, names);
    groups.set(extension, folders);
  }
  const parts = [];
  for (const [extension, folders] of groups) {
    parts.push(text(extension));
    for (const [folder, names] of folders) parts.push(text(folder), ...names, text(''));
    parts.push(text(''));
  }
  parts.push(text(''));
  const tree = Buffer.concat(parts),
    header = Buffer.alloc(version === 2 ? 28 : 12);
  header.writeUInt32LE(0x55aa1234);
  header.writeUInt32LE(version, 4);
  header.writeUInt32LE(tree.length, 8);
  if (version === 2) header.writeUInt32LE(embeddedOffset, 12);
  return { bytes: Buffer.concat([header, tree, ...data]), archives, treeOffset: header.length };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cswatch-dependencies-'));
  return { root, close: () => rm(root, { recursive: true, force: true }) };
}

test('compiled resource references retain exact relative offset semantics, normalize names and deduplicate cycles', () => {
  assert.deepEqual(
    source2References(
      resource([
        'Materials/Example.VMAT',
        'materials/example.vmat_c',
        '_bakeresourcecache/maps/test.vtex',
      ]),
    ),
    ['materials/example.vmat_c', '_bakeresourcecache/maps/test.vtex_c'],
  );
  assert.deepEqual(source2References(Buffer.from('plain local text')), []);
  assert.equal(resourcePath('models/a.vmdl', { compiled: true }), 'models/a.vmdl_c');
  assert.equal(
    resourcePath('maps/de_fixture/entities/2_28160#entitylumpname.vents', { compiled: true }),
    'maps/de_fixture/entities/2_28160#entitylumpname.vents_c',
  );
  assert.equal(
    resourcePath('maps/cs_fixture/entities/2_42786_7678_13#entitylumpname.vents_c'),
    'maps/cs_fixture/entities/2_42786_7678_13#entitylumpname.vents_c',
  );
  for (const path of [
    '../outside.vmat',
    '/absolute.vtex',
    'materials/../outside.vmat',
    'materials//a.vmat',
    'https://host/a.vmat',
    'file:///tmp/a.vmat',
    'a\\b.vmat',
    'a\0b.vmat',
    'a/./b.vmat',
    'a.vmat?secret',
    'a.vmat#fragment',
    'maps/de_fixture/entities/2_28160#arbitrary.vents_c',
    'maps/de_fixture/entities/2_28160#entitylumpname.vmat_c',
  ])
    assert.throws(() => resourcePath(path));
});

test('RERL and resource block parsing fails closed on truncation, bounds, unsafe paths and output limits', () => {
  const original = resource(['materials/a.vmat']);
  const mutate = (change) => {
    const bytes = Buffer.from(original);
    change(bytes);
    return bytes;
  };
  for (const bytes of [
    original.subarray(0, original.length - 1),
    mutate((bytes) => bytes.writeUInt32LE(0xffffffff, 8)),
    mutate((bytes) => bytes.writeUInt32LE(1025, 12)),
    mutate((bytes) => bytes.writeUInt32LE(0xffffffff, 20)),
    mutate((bytes) => bytes.writeUInt32LE(0xffffffff, 24)),
    mutate((bytes) => bytes.writeUInt32LE(0xffffffff, 28)),
    mutate((bytes) => bytes.writeUInt32LE(20001, 32)),
    mutate((bytes) => bytes.writeInt32LE(-999, 44)),
    mutate((bytes) => bytes.fill(65, 52)),
    resource(['../secret.vmat']),
  ])
    assert.throws(() => source2References(bytes));
  assert.throws(() => source2References(original, { limits: { resourceBytes: 16 } }));
  assert.throws(() =>
    source2References(resource(['materials/a.vmat', 'materials/b.vmat']), {
      limits: { references: 1 },
    }),
  );
  assert.throws(() =>
    source2References(original, { limits: { references: dependencyLimits.references + 1 } }),
  );
});

test('VPK v1/v2 indexes preserve preloads and CRC-check bounded embedded or split-archive slices', async () => {
  const s = await fixture();
  try {
    for (const version of [1, 2]) {
      const input = vpk(
        [
          {
            resource: 'models/example.vmdl_c',
            bytes: resource(['materials/a.vmat']),
            preloadBytes: 7,
          },
          { resource: 'readme', bytes: Buffer.from('Operator fixture') },
        ],
        { version },
      );
      const path = join(s.root, `map-${version}.vpk`);
      await writeFile(path, input.bytes);
      const index = await readVpkDirectory(path);
      assert.equal(index.provenance.version, version);
      assert.equal(index.provenance.entries, 2);
      assert.equal(index.provenance.sha256, createHash('sha256').update(input.bytes).digest('hex'));
      assert.deepEqual(
        await index.readEntry('models/example.vmdl_c'),
        resource(['materials/a.vmat']),
      );
      assert.equal(index.entries.get('models/example.vmdl_c').preloadBytes, 7);
      assert.equal((await index.readEntry('readme')).toString(), 'Operator fixture');
    }
    const payload = resource(['materials/a.vmat']),
      input = vpk([
        {
          resource: 'models/external.vmdl_c',
          bytes: payload,
          archiveIndex: 2,
          archiveOffset: 1024,
          preloadBytes: 8,
        },
      ]);
    const path = join(s.root, 'pak01_dir.vpk');
    await writeFile(path, input.bytes);
    const index = await readVpkDirectory(path),
      entry = index.entries.get('models/external.vmdl_c');
    assert.equal(entry.archiveIndex, 2);
    assert.equal(entry.offset, 1024);
    assert.equal(entry.length, payload.length - 8);
    assert.equal(entry.archivePath, join(s.root, 'pak01_002.vpk'));
    assert.equal(await index.readEntry(entry.resource), undefined);
    const archive = await open(entry.archivePath, 'w');
    try {
      await archive.truncate(512 * 1024 * 1024);
    } finally {
      await archive.close();
    }
    assert.equal(
      await index.readEntry(entry.resource),
      undefined,
      'Sparse zero-filled ranges never count as available resources.',
    );
    const complete = await open(entry.archivePath, 'r+');
    try {
      await complete.write(input.archives.get(2), 0, input.archives.get(2).length, 0);
    } finally {
      await complete.close();
    }
    assert.deepEqual(
      await index.readEntry(entry.resource),
      payload,
      'Only the bounded entry slice is read, not the 512 MiB archive body.',
    );
    const changed = await open(entry.archivePath, 'r+');
    try {
      await changed.write(Buffer.from([0]), 0, 1, entry.offset);
    } finally {
      await changed.close();
    }
    assert.equal(await index.readEntry(entry.resource), undefined);
  } finally {
    await s.close();
  }
});

test('VPK directory validation rejects invalid signatures, malformed trees, duplicate paths and linked inputs', async () => {
  const s = await fixture();
  try {
    const valid = vpk([{ resource: 'models/a.vmdl_c', bytes: resource() }]);
    const badSignature = Buffer.from(valid.bytes);
    badSignature.writeUInt32LE(0, 0);
    const badTerminator = Buffer.from(valid.bytes);
    const terminator = badTerminator.indexOf(Buffer.from([0xff, 0xff]), valid.treeOffset);
    badTerminator[terminator] = 0;
    const badSize = Buffer.from(valid.bytes);
    badSize.writeUInt32LE(0xffffffff, 8);
    const sources = [
      badSignature,
      badTerminator,
      badSize,
      valid.bytes.subarray(0, 30),
      vpk([{ resource: '../outside.vmat_c', bytes: resource() }]).bytes,
      vpk([
        { resource: 'a.vmat_c', bytes: resource() },
        { resource: 'a.vmat_c', bytes: resource() },
      ]).bytes,
    ];
    for (let index = 0; index < sources.length; index++) {
      const path = join(s.root, `invalid-${index}.vpk`);
      await writeFile(path, sources[index]);
      await assert.rejects(readVpkDirectory(path));
    }
    const path = join(s.root, 'map.vpk');
    await writeFile(path, valid.bytes);
    await assert.rejects(readVpkDirectory(path, { limits: { entries: 0 } }));
    const bounded = await readVpkDirectory(path, { limits: { resourceBytes: 16 } });
    await assert.rejects(bounded.readEntry('models/a.vmdl_c'), /read limit/);
    await symlink(path, join(s.root, 'linked.vpk'));
    await assert.rejects(readVpkDirectory(join(s.root, 'linked.vpk')), /without linked/);
  } finally {
    await s.close();
  }
});

test('empty and preload-only VPK entries ignore sentinel disk offsets while retaining CRC checks', async () => {
  const s = await fixture();
  try {
    const source = vpk([
      {
        resource: 'panorama/window_keybinds.cfg',
        bytes: Buffer.alloc(0),
        startOverride: 0xffffffff,
      },
      {
        resource: 'scripts/preload.txt',
        bytes: Buffer.from('abc'),
        preloadBytes: 3,
        startOverride: 0xffffffff,
        archiveIndex: 4,
      },
    ]);
    const path = join(s.root, 'pak01_dir.vpk');
    await writeFile(path, source.bytes);
    const index = await readVpkDirectory(path);
    assert.deepEqual(await index.readEntry('panorama/window_keybinds.cfg'), Buffer.alloc(0));
    assert.deepEqual(await index.readEntry('scripts/preload.txt'), Buffer.from('abc'));
    assert.equal(index.entries.get('scripts/preload.txt').offset, 0);
    index.entries.get('scripts/preload.txt').crc32 ^= 1;
    assert.equal(await index.readEntry('scripts/preload.txt'), undefined);
  } finally {
    await s.close();
  }
});

test('large unselected archive entries remain indexable without weakening selected resource read limits', async () => {
  const s = await fixture();
  try {
    const length = 330897636;
    const source = vpk([
      {
        resource: 'shaders/vfx/unselected_vulkan_50_ps.vcs',
        bytes: Buffer.from([1]),
        archiveIndex: 2,
        declaredLength: length,
      },
      { resource: 'materials/selected.vmat_c', bytes: resource() },
    ]);
    const path = join(s.root, 'shaders_vulkan_dir.vpk');
    await writeFile(path, source.bytes);
    const index = await readVpkDirectory(path);
    assert.equal(index.entries.get('shaders/vfx/unselected_vulkan_50_ps.vcs').length, length);
    assert.deepEqual(await index.readEntry('materials/selected.vmat_c'), resource());
    // No archive exists: a selected oversized read must reject before opening
    // it or allocating the declared 330 MB body.
    await assert.rejects(index.readEntry('shaders/vfx/unselected_vulkan_50_ps.vcs'), /read limit/);
    const archive = await open(join(s.root, 'shaders_vulkan_002.vpk'), 'w');
    try {
      await archive.truncate(length);
    } finally {
      await archive.close();
    }
    await assert.rejects(index.readEntry('shaders/vfx/unselected_vulkan_50_ps.vcs'), /read limit/);
  } finally {
    await s.close();
  }
});

test('streamed VPK CRC verifies sparse complete ranges with preload continuation above the unchanged read cap', async () => {
  const s = await fixture();
  try {
    const payload = Buffer.alloc(180000);
    for (let i = 0; i < 32; i++) payload[i] = i + 1;
    payload.fill(7, payload.length - 32);
    const resource = 'shaders/vfx/csgo_fixture_vulkan_50_ps.vcs';
    const source = vpk([
      { resource, bytes: payload, preloadBytes: 8, archiveIndex: 3, archiveOffset: 8192 },
    ]);
    const path = join(s.root, 'shaders_vulkan_dir.vpk');
    await writeFile(path, source.bytes);
    const directory = await readVpkDirectory(path, { limits: { resourceBytes: 1024 } });
    const entry = directory.entries.get(resource);
    const archive = await open(entry.archivePath, 'w');
    try {
      await archive.truncate(entry.offset + entry.length);
      await archive.write(payload.subarray(8, 72), 0, 64, entry.offset);
      await archive.write(
        payload.subarray(payload.length - 64),
        0,
        64,
        entry.offset + entry.length - 64,
      );
    } finally {
      await archive.close();
    }
    await assert.rejects(directory.readEntry(resource), /read limit/);
    assert.equal(await directory.verifyEntry(resource), true);
    assert.equal(await directory.verifyEntry('shaders/vfx/missing.vcs'), false);
    const file = await open(entry.archivePath, 'r+');
    try {
      await file.write(Buffer.from([99]), 0, 1, entry.offset + 80000);
    } finally {
      await file.close();
    }
    assert.equal(
      await directory.verifyEntry(resource),
      false,
      'sparse holes are not sufficient when a required byte differs',
    );
    const restore = await open(entry.archivePath, 'r+');
    try {
      await restore.write(Buffer.from([0]), 0, 1, entry.offset + 80000);
    } finally {
      await restore.close();
    }
    assert.equal(await directory.verifyEntry(resource), true);
    const short = await open(entry.archivePath, 'r+');
    try {
      await short.truncate(entry.offset + entry.length - 1);
    } finally {
      await short.close();
    }
    assert.equal(await directory.verifyEntry(resource), false);
    const strict = await readVpkDirectory(path, {
      limits: { resourceBytes: 1024, verifyEntryBytes: payload.length - 1 },
    });
    await assert.rejects(strict.verifyEntry(resource), /streamed verification limit/);
  } finally {
    await s.close();
  }
});

test('streamed VPK verification rejects archive links and handles embedded/preload-only entries without complete buffers', async () => {
  const s = await fixture();
  try {
    const resource = 'shaders/vfx/csgo_fixture_vulkan_50_vs.vcs',
      payload = Buffer.from('Original streamed shader fixture');
    const source = vpk([{ resource, bytes: payload, preloadBytes: 3, archiveIndex: 1 }]);
    const path = join(s.root, 'shaders_vulkan_dir.vpk');
    await writeFile(path, source.bytes);
    const directory = await readVpkDirectory(path),
      archive = directory.entries.get(resource).archivePath;
    await writeFile(archive, source.archives.get(1));
    assert.equal(await directory.verifyEntry(resource), true);
    const saved = join(s.root, 'saved.vpk');
    await rename(archive, saved);
    await symlink(saved, archive);
    assert.equal(await directory.verifyEntry(resource), false);
    await unlink(archive);
    await link(saved, archive);
    assert.equal(await directory.verifyEntry(resource), false);
    await unlink(archive);
    await rename(saved, archive);
    assert.equal(await directory.verifyEntry(resource), true);
    const embedded = vpk([
      { resource: 'embedded.vcs', bytes: payload, preloadBytes: 4 },
      { resource: 'preloaded.vcs', bytes: payload, preloadBytes: payload.length },
    ]);
    const embeddedPath = join(s.root, 'embedded.vpk');
    await writeFile(embeddedPath, embedded.bytes);
    const small = await readVpkDirectory(embeddedPath, {
      limits: { resourceBytes: 8, verifyChunkBytes: 4 },
    });
    assert.equal(await small.verifyEntry('embedded.vcs'), true);
    assert.equal(await small.verifyEntry('preloaded.vcs'), true);
    small.entries.get('preloaded.vcs').crc32 ^= 1;
    assert.equal(await small.verifyEntry('preloaded.vcs'), false);
    await assert.rejects(small.readEntry('embedded.vcs'), /read limit/);
  } finally {
    await s.close();
  }
});

test('recursive planning honors loose/map/csgo/core precedence and exposes only missing exact resources for fetching', async () => {
  const s = await fixture();
  try {
    const mapVpk = join(s.root, 'map.vpk'),
      csgoVpk = join(s.root, 'csgo', 'pak01_dir.vpk'),
      coreVpk = join(s.root, 'core', 'pak01_dir.vpk'),
      looseRoot = join(s.root, 'loose');
    await mkdir(join(s.root, 'csgo'));
    await mkdir(join(s.root, 'core'));
    await mkdir(join(looseRoot, 'materials'), { recursive: true });
    const initial = resource(['materials/start.vmat', 'materials/pending.vmat']);
    await writeFile(
      mapVpk,
      vpk([
        { resource: 'maps/root.vmap_c', bytes: initial },
        {
          resource: 'materials/start.vmat_c',
          bytes: resource(['materials/must_not_be_used.vmat']),
        },
      ]).bytes,
    );
    const csgo = vpk([
      {
        resource: 'materials/pending.vmat_c',
        bytes: resource(['textures/later.vtex']),
        archiveIndex: 0,
      },
      { resource: 'textures/later.vtex_c', bytes: resource(), archiveIndex: 1 },
    ]);
    await writeFile(csgoVpk, csgo.bytes);
    await writeFile(
      coreVpk,
      vpk([
        {
          resource: 'materials/shared.vmat_c',
          bytes: resource(['maps/root.vmap', '_bakeresourcecache/unknown.vtex']),
        },
      ]).bytes,
    );
    await writeFile(
      join(looseRoot, 'materials', 'start.vmat_c'),
      resource(['materials/shared.vmat']),
    );
    const options = { mapVpk, csgoVpk, coreVpk, looseRoots: [looseRoot] };
    const first = await scanSource2Dependencies(options);
    assert.equal(first.sources.length, 3);
    assert.equal(first.loose.length, 1);
    assert.equal(first.counts.initial, 2);
    assert.equal(first.complete, false);
    assert.deepEqual(
      first.pending.csgo.map((entry) => entry.resource),
      ['materials/pending.vmat_c'],
    );
    assert.deepEqual(first.unknown, ['_bakeresourcecache/unknown.vtex_c']);
    assert.ok(first.pending.csgo.every((entry) => !Object.hasOwn(entry, 'preload')));
    assert.deepEqual(first.materials.map((record) => record.resource).sort(), [
      'materials/shared.vmat_c',
      'materials/start.vmat_c',
    ]);
    const start = first.materials.find((record) => record.resource === 'materials/start.vmat_c');
    assert.deepEqual(start.source, {
      kind: 'loose',
      path: join(looseRoot, 'materials/start.vmat_c'),
    });
    assert.equal(
      start.sha256,
      createHash('sha256')
        .update(resource(['materials/shared.vmat']))
        .digest('hex'),
    );
    await writeFile(join(s.root, 'csgo', 'pak01_000.vpk'), csgo.archives.get(0));
    const second = await scanSource2Dependencies(options);
    assert.deepEqual(
      second.materials.find((record) => record.resource === 'materials/pending.vmat_c').source,
      { kind: 'vpk', path: csgoVpk },
    );
    assert.deepEqual(
      second.pending.csgo.map((entry) => entry.resource),
      ['textures/later.vtex_c'],
    );
    await writeFile(join(s.root, 'csgo', 'pak01_001.vpk'), csgo.archives.get(1));
    const final = await scanSource2Dependencies(options);
    assert.equal(final.counts.pending, 0);
    assert.equal(
      final.complete,
      false,
      'Unknown baked resources remain explicit rather than silently declared optional.',
    );
    await assert.rejects(
      scanSource2Dependencies({ ...options, limits: { resources: 2 } }),
      /resource limit/,
    );
    await assert.rejects(
      scanSource2Dependencies({ ...options, limits: { totalReadBytes: 1 } }),
      /read budget/,
    );
    await assert.rejects(
      scanSource2Dependencies({ ...options, required: ['../escape.vtex_c'] }),
      /Unsafe/,
    );
  } finally {
    await s.close();
  }
});
