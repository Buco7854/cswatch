import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { expandBzip2 } from '../src/bzip2.js';
import { validateMagic } from '../src/demo-format.js';
import { parse } from '../src/parser.js';

// A single BZip2 stream holding the demo signature followed by 128 KiB of 'x'.
const archive = Buffer.from(
  'QlpoOTFBWSZTWcpvTW0AAANOgMAAEAAWAkgAAEAACCAAMQAwCqIGJNVzvrucQAzQgB8XckU4UJDKb01t',
  'base64',
);
const expanded = Buffer.concat([Buffer.from('PBDEMS2\0'), Buffer.alloc(128 * 1024, 'x')]);

test('BZip2 expansion enforces the output budget before each write', async (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'cswatch-bzip2-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const source = join(folder, 'input.bz2');
  writeFileSync(source, archive);
  await expandBzip2(source, join(folder, 'exact.dem'), expanded.length);
  assert.deepEqual(readFileSync(join(folder, 'exact.dem')), expanded);
  const limited = join(folder, 'limited.dem');
  await assert.rejects(expandBzip2(source, limited, expanded.length - 1), /Expanded limit/);
  assert.ok(statSync(limited).size < expanded.length);
});

test('Steam archives require the BZip2 header, complete checksums and CS2 demo content', async (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'cswatch-bzip2-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const source = join(folder, 'input.bz2');
  for (const header of [Buffer.from('BZh0'), Buffer.from([0xc2, 0x5a, 0x68, 0x39])]) {
    writeFileSync(source, header);
    assert.throws(() => validateMagic(source, '.bz2'), /Invalid compressed demo/);
  }
  const badChecksum = Buffer.from(archive);
  badChecksum[10] ^= 1;
  for (const data of [
    badChecksum,
    archive.subarray(0, 4),
    archive.subarray(0, -1),
    Buffer.concat([archive, Buffer.from([0])]),
  ]) {
    writeFileSync(source, data);
    const output = join(folder, 'expanded.dem');
    await assert.rejects(expandBzip2(source, output, expanded.length), /CRC|Truncated|Trailing/);
    rmSync(output);
  }
  writeFileSync(
    source,
    Buffer.from('QlpoOTFBWSZTWTe1YGYAAAMRgEAAJgOEACAAIg9QeoQwIQi8eTxdyRThQkDe1YGY', 'base64'),
  );
  await assert.rejects(parse(folder, expanded.length), /not a CS2 demo/);
});
