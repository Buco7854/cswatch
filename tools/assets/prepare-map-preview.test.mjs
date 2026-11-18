import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { prepareMapPreview } from './prepare-map-preview.mjs';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cswatch-map-preview-'));
  const image = join(root, 'original.png'),
    output = join(root, 'maps');
  const bytes = await sharp({
    create: {
      width: 320,
      height: 180,
      channels: 4,
      background: { r: 30, g: 60, b: 90, alpha: 0.5 },
    },
  })
    .png()
    .toBuffer();
  await writeFile(image, bytes, { mode: 0o600 });
  return {
    root,
    image,
    output,
    bytes,
    options: {
      image,
      output,
      map: 'de_mirage',
      version: 'original-qa',
      source: 'Original generated pixel fixture, not game artwork.',
    },
  };
}
test('operator preview normalizes genuine local pixels and binds metadata without replacing an installed image', async () => {
  const f = await fixture();
  try {
    const result = await prepareMapPreview(f.options);
    const png = await readFile(join(result.directory, 'preview.png'));
    const metadata = JSON.parse(await readFile(join(result.directory, 'preview.json')));
    assert.equal(metadata.imageSha256, createHash('sha256').update(png).digest('hex'));
    assert.equal(metadata.map, 'de_mirage');
    assert.equal(metadata.assetVersion, 'original-qa');
    const provenance = JSON.parse(await readFile(join(result.directory, 'provenance.json')));
    assert.deepEqual(
      [provenance.width, provenance.height, provenance.sourceWidth, provenance.sourceHeight],
      [320, 180, 320, 180],
    );
    const decoded = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    assert.deepEqual(
      [decoded.info.width, decoded.info.height, decoded.info.channels],
      [320, 180, 4],
    );
    assert.deepEqual([...decoded.data.subarray(0, 4)], [30, 60, 90, 128]);
    await assert.rejects(prepareMapPreview(f.options), { code: 'EEXIST' });
    assert.deepEqual(await readFile(join(result.directory, 'preview.png')), png);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test('preview preparation rejects maps outside the shared landing artwork registry', async () => {
  await assert.rejects(
    prepareMapPreview({ map: 'de_other', image: '/missing.png', output: '/unused' }),
    /supported landing preview/,
  );
});
test('truncated or CRC-corrupt previews fail before any publication', async () => {
  const f = await fixture();
  try {
    for (const bytes of [f.bytes.subarray(0, f.bytes.length - 2), Buffer.from(f.bytes)]) {
      if (bytes.length === f.bytes.length) bytes[bytes.length - 20] ^= 1;
      await writeFile(f.image, bytes);
      await assert.rejects(prepareMapPreview(f.options), /PNG/);
      await assert.rejects(readFile(join(f.output, 'previews', 'de_mirage', 'preview.json')), {
        code: 'ENOENT',
      });
    }
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test('preview inputs and output ancestors reject links and FIFO without blocking or writing outside the root', async () => {
  const f = await fixture();
  try {
    const link = join(f.root, 'image-link.png'),
      outside = join(f.root, 'outside'),
      alias = join(f.root, 'alias');
    await symlink(f.image, link);
    await assert.rejects(prepareMapPreview({ ...f.options, image: link }));
    await mkdir(outside);
    await symlink(outside, alias);
    await assert.rejects(
      prepareMapPreview({ ...f.options, output: join(alias, 'maps') }),
      /real directories/,
    );
    await assert.rejects(readFile(join(outside, 'maps', 'previews', 'de_mirage', 'preview.json')), {
      code: 'ENOENT',
    });
    const fifo = join(f.root, 'pipe.png');
    execFileSync('mkfifo', [fifo]);
    await assert.rejects(prepareMapPreview({ ...f.options, image: fifo }), /regular file/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
