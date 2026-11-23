import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  symlink,
  link,
  readdir,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { crc32, deflateSync } from 'node:zlib';
import sharp from 'sharp';
import { completePng, createSourceImageCompactor } from './source-image-compactor.mjs';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const event = (name, count = 1, total = 1) => `--- [${count}/${total}] Exported texture: ${name}`;
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cswatch-source-image-'));
  const exportRoot = join(root, 'export');
  await mkdir(exportRoot, { mode: 0o700 });
  return { root, exportRoot, close: () => rm(root, { recursive: true, force: true }) };
}
const png = (width = 64, height = 32) =>
  sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 100, g: 120, b: 140, alpha: 113 / 255 },
    },
  })
    .png()
    .toBuffer();

test('a complete Source PNG can use more than 4096 IDAT chunks within its byte bound', async () => {
  const original = await png();
  const empty = Buffer.alloc(12);
  empty.write('IDAT', 4);
  empty.writeUInt32BE(crc32(empty.subarray(4, 8)), 8);
  const split = Buffer.alloc(4096 * empty.length, empty);
  assert.doesNotThrow(() =>
    completePng(Buffer.concat([original.subarray(0, -12), split, original.subarray(-12)])),
  );
});

test('only exact completed events compact a known fresh PNG and leave geometry bytes unchanged', async () => {
  const f = await fixture();
  try {
    const compactor = await createSourceImageCompactor({ root: f.exportRoot });
    const image = await png(4096, 4),
      geometry = Buffer.from('unchanged original authored mesh bytes');
    await writeFile(join(f.exportRoot, 'native_color.png'), image);
    await writeFile(join(f.exportRoot, 'scene.bin'), geometry);
    await compactor.consume('[1/1] Exported texture: native_color.vtex_c');
    assert.deepEqual(await readFile(join(f.exportRoot, 'native_color.png')), image);
    await compactor.consume(event('native_color.vtex_c'));
    const result = await compactor.finish(),
      output = await readFile(join(f.exportRoot, 'native_color.png'));
    assert.deepEqual(await readFile(join(f.exportRoot, 'scene.bin')), geometry);
    assert.deepEqual(result.images[0], {
      file: 'native_color.png',
      input: { sha256: sha(image), width: 4096, height: 4, bytes: image.length },
      output: { sha256: sha(output), width: 2048, height: 2, bytes: output.length },
    });
    const decoded = await sharp(output).raw().toBuffer({ resolveWithObject: true });
    assert.equal(decoded.info.channels, 4);
    assert.equal(decoded.data[3], 113);
    assert.equal(result.readBytes, image.length * 2);
    assert.equal(await compactor.finish(), result, 'finish is idempotent');
    assert.deepEqual((await readdir(f.exportRoot)).sort(), ['native_color.png', 'scene.bin']);
  } finally {
    await f.close();
  }
});

test('small completed PNGs are fully decoded but remain byte-for-byte and inode identical', async () => {
  const f = await fixture();
  try {
    const compactor = await createSourceImageCompactor({ root: f.exportRoot });
    const image = await png();
    const path = join(f.exportRoot, 'small.png');
    await writeFile(path, image);
    const before = await stat(path);
    await compactor.consume(event('small'));
    const result = await compactor.finish();
    assert.deepEqual(await readFile(path), image);
    assert.equal((await stat(path)).ino, before.ino);
    assert.equal(result.images[0].input.sha256, result.images[0].output.sha256);
  } finally {
    await f.close();
  }
});

test('a small PNG flush after its progress event is still checked and recorded', async () => {
  const f = await fixture();
  try {
    const compactor = await createSourceImageCompactor({ root: f.exportRoot });
    const image = await png(1, 1);
    const path = join(f.exportRoot, 'late.png');
    await writeFile(path, '');
    const completion = compactor.consume(event('late'));
    const flush = delay(30).then(() => writeFile(path, image));
    await Promise.all([completion, flush]);
    const { images } = await compactor.finish();
    assert.equal(images[0].input.sha256, sha(image));
    assert.deepEqual(await readFile(path), image);
  } finally {
    await f.close();
  }
});

test('completed paths, count overflow and duplicate completion cannot target external or repeated files', async () => {
  for (const line of [
    event('../private'),
    event('/private'),
    event('a\\b'),
    event('.hidden'),
    event('name', 0, 1),
    event('name', 2, 1),
    event('name', 1, 20001),
  ]) {
    const f = await fixture();
    try {
      const compactor = await createSourceImageCompactor({ root: f.exportRoot });
      await assert.rejects(compactor.consume(line), /Invalid completed/);
      await assert.rejects(compactor.finish(), /Invalid completed/);
    } finally {
      await f.close();
    }
  }
  const f = await fixture();
  try {
    const compactor = await createSourceImageCompactor({ root: f.exportRoot });
    await writeFile(join(f.exportRoot, 'same.png'), await png());
    await compactor.consume(event('same'));
    await assert.rejects(compactor.consume(event('same')), /Duplicate/);
    await assert.rejects(compactor.finish(), /Duplicate/);
  } finally {
    await f.close();
  }
});

test('partial PNGs, damaged CRCs and incomplete pixels fail without replacing source bytes', async () => {
  const complete = await png();
  const corrupt = Buffer.from(complete);
  corrupt[corrupt.length - 1] ^= 1;
  const chunk = (kind, bytes) => {
    const header = Buffer.alloc(8),
      crc = Buffer.alloc(4);
    header.writeUInt32BE(bytes.length);
    header.write(kind, 4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(kind), bytes])));
    return Buffer.concat([header, bytes, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(8);
  ihdr.writeUInt32BE(8, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const incompletePixels = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.from([0]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  for (const bytes of [complete.subarray(0, complete.length - 5), corrupt, incompletePixels]) {
    const f = await fixture();
    try {
      const compactor = await createSourceImageCompactor({ root: f.exportRoot });
      const path = join(f.exportRoot, 'partial.png');
      await writeFile(path, bytes);
      await assert.rejects(compactor.consume(event('partial')));
      await assert.rejects(compactor.finish());
      assert.deepEqual(await readFile(path), bytes);
    } finally {
      await f.close();
    }
  }
});

test('fresh-root and source link guards reject existing trees, symlinks and shared inodes', async () => {
  const f = await fixture();
  try {
    const outside = join(f.root, 'outside.png');
    await writeFile(outside, await png());
    const rootLink = join(f.root, 'linked-root');
    await symlink(f.exportRoot, rootLink);
    await assert.rejects(createSourceImageCompactor({ root: rootLink }));
    for (const type of ['symbolic', 'hard']) {
      const folder = join(f.root, type);
      await mkdir(folder, { mode: 0o700 });
      const compactor = await createSourceImageCompactor({ root: folder });
      const target = join(folder, 'linked.png');
      await (type === 'symbolic' ? symlink(outside, target) : link(outside, target));
      await assert.rejects(compactor.consume(event('linked')));
      await assert.rejects(compactor.finish());
      assert.deepEqual(await readFile(outside), await png());
    }
    await writeFile(join(f.exportRoot, 'existing.png'), await png());
    await assert.rejects(createSourceImageCompactor({ root: f.exportRoot }), /fresh empty/);
  } finally {
    await f.close();
  }
});

test('nonblocking special-file reads and cancellation never replace a source', async () => {
  const f = await fixture();
  try {
    if (process.platform === 'linux') {
      const fifoRoot = join(f.root, 'fifo');
      await mkdir(fifoRoot, { mode: 0o700 });
      const compactor = await createSourceImageCompactor({ root: fifoRoot });
      assert.equal(spawnSync('mkfifo', [join(fifoRoot, 'pipe.png')]).status, 0);
      await assert.rejects(compactor.consume(event('pipe')), /regular PNG/);
      await assert.rejects(compactor.finish());
    }
    const controller = new AbortController();
    const compactor = await createSourceImageCompactor({
      root: f.exportRoot,
      signal: controller.signal,
      checkStorage: async () => controller.abort(),
    });
    const image = await png(4096, 4),
      path = join(f.exportRoot, 'cancelled.png');
    await writeFile(path, image);
    await assert.rejects(compactor.consume(event('cancelled')), /cancelled/);
    await assert.rejects(compactor.finish(), /cancelled/);
    assert.deepEqual(await readFile(path), image);
    assert.deepEqual(await readdir(f.exportRoot), ['cancelled.png']);
  } finally {
    await f.close();
  }
});

test('concurrent completion events serialize exact writes and reject content changed during compaction', async () => {
  const f = await fixture();
  let active = 0,
    maximum = 0,
    checks = 0;
  try {
    const compactor = await createSourceImageCompactor({
      root: f.exportRoot,
      checkStorage: async (bytes) => {
        assert.ok(bytes > 0);
        active++;
        maximum = Math.max(maximum, active);
        checks++;
        await new Promise((done) => setImmediate(done));
        active--;
      },
    });
    for (const name of ['first', 'second'])
      await writeFile(join(f.exportRoot, name + '.png'), await png(4096, 4));
    await Promise.all([
      compactor.consume(event('first', 2, 2)),
      compactor.consume(event('second', 1, 2)),
    ]);
    const result = await compactor.finish();
    assert.equal(result.images.length, 2);
    assert.equal(maximum, 1);
    assert.equal(checks, 2);
    const changedRoot = join(f.root, 'changed');
    await mkdir(changedRoot, { mode: 0o700 });
    const original = await png(4096, 4),
      changed = await png(4096, 5),
      path = join(changedRoot, 'changing.png');
    const guarded = await createSourceImageCompactor({
      root: changedRoot,
      checkStorage: async () => {
        await writeFile(path, changed);
      },
    });
    await writeFile(path, original);
    await assert.rejects(guarded.consume(event('changing')), /changed before/);
    await assert.rejects(guarded.finish());
    assert.deepEqual(await readFile(path), changed);
    assert.deepEqual(await readdir(changedRoot), ['changing.png']);
  } finally {
    await f.close();
  }
});
