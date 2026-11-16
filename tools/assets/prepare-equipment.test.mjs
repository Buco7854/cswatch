import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { equipmentSvg, prepareEquipment } from './prepare-equipment.mjs';

// Original synthetic geometry, never a copied game asset.
const drawing =
  '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="32"><path fill="white" d="M8 8h96v8H8zm16 8h8v10h-8z"/></svg>';
test('equipment preparation emits only allowed, bounded PNGs with provenance and refuses overwrite', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cswatch-equipment-'));
  const previousUmask = process.umask(0o077);
  try {
    const input = join(root, 'source'),
      output = join(root, 'output');
    await mkdir(input);
    await writeFile(join(input, 'ak47.svg'), drawing);
    await writeFile(join(input, 'other.svg'), drawing);
    assert.equal(
      (
        await prepareEquipment({
          input,
          output,
          version: 'test',
          source: 'Original synthetic test geometry',
        })
      ).count,
      1,
    );
    assert.deepEqual((await readdir(output)).sort(), ['ak47.png', 'provenance.json']);
    assert.equal((await lstat(output)).mode & 0o777, 0o755);
    assert.equal((await lstat(join(output, 'ak47.png'))).mode & 0o777, 0o644);
    assert.equal((await lstat(join(output, 'provenance.json'))).mode & 0o777, 0o644);
    assert.equal((await lstat(input)).mode & 0o777, 0o700);
    assert.equal((await lstat(join(input, 'ak47.svg'))).mode & 0o777, 0o600);
    const image = await sharp(await readFile(join(output, 'ak47.png'))).metadata();
    assert.equal(image.format, 'png');
    assert.ok(image.width <= 256 && image.height <= 64 && image.hasAlpha);
    const provenance = JSON.parse(await readFile(join(output, 'provenance.json')));
    assert.match(provenance.items.ak47.sourceSha256, /^[a-f0-9]{64}$/);
    await assert.rejects(
      prepareEquipment({ input, output, version: 'test', source: 'Synthetic' }),
      /already exists/,
    );
    await symlink(join(input, 'ak47.svg'), join(input, 'awp.svg'));
    await assert.rejects(
      prepareEquipment({
        input,
        output: join(root, 'symlink-output'),
        version: 'test',
        source: 'Synthetic',
      }),
      /Invalid SVG/,
    );
    assert.equal(
      (await readdir(root)).some((name) => name.startsWith('.equipment-')),
      false,
    );
  } finally {
    process.umask(previousUmask);
    await rm(root, { recursive: true, force: true });
  }
});

test('equipment SVG preflight rejects executable content, remote references, entities and oversized input', () => {
  for (const body of [
    '<image href="file:///etc/passwd"/>',
    '<script>alert(1)</script>',
    '<path onload="alert(1)"/>',
    '<style>path{fill:red}</style>',
    '<path style="fill:url(https://example.invalid/image)"/>',
    '<use href="#a"/>',
    '<foreignObject/>',
  ])
    assert.throws(() => equipmentSvg(Buffer.from('<svg>' + body + '</svg>')));
  assert.throws(() =>
    equipmentSvg(Buffer.from('<!DOCTYPE svg [<!ENTITY bad SYSTEM "file:///etc/passwd">]><svg/>')),
  );
  assert.throws(() => equipmentSvg(Buffer.alloc(256 * 1024 + 1)));
  assert.match(
    equipmentSvg(
      Buffer.from(
        '<?xml version="1.0"?><!DOCTYPE svg PUBLIC "svg" "https://example.invalid/dtd">' + drawing,
      ),
    ).toString(),
    /^<svg/,
  );
});
