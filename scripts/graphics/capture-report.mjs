import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual as equal } from 'node:util';
import { createRequire } from 'node:module';
const sharp = createRequire(new URL('../../tools/assets/package.json', import.meta.url))('sharp');

const maxViews = 24;
export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sha = (s) => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
export const captureKind = 'cswatch-graphics-capture';
export const externalKind = 'external-graphics-reference';
export const coordinateSystem = 'gltf-meters-y-up';
const text = (s, max) => typeof s === 'string' && s.length <= max && !/[\x00-\x1f]/.test(s);

export async function boundedFile(path, max) {
  const file = await open(path, constants.O_NOFOLLOW | constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    assert(stat.isFile() && stat.size > 0 && stat.size <= max, 'Invalid input file size or type');
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      assert(bytesRead, 'Truncated input file');
      offset += bytesRead;
    }
    assert.equal((await file.stat()).size, stat.size, 'Input size changed');
    return bytes;
  } finally {
    await file.close();
  }
}

export async function decodeOpaqueFrame(bytes, width, height) {
  assert(
    bytes.length >= 33 &&
      bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) &&
      bytes.readUInt32BE(16) === width &&
      bytes.readUInt32BE(20) === height,
    'Reference PNG dimensions/format mismatch',
  );
  const raw = await sharp(bytes, { limitInputPixels: width * height, failOn: 'warning' })
    .toColourspace('srgb')
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert(
    raw.info.channels === 4 && raw.info.width === width && raw.info.height === height,
    'Invalid PNG',
  );
  for (let i = 3; i < raw.data.length; i += 4)
    assert(raw.data[i] === 255, 'Expected opaque HUD-free frame');
  return raw.data;
}

export async function rgbMetrics(a, b, width, height) {
  const first = await decodeOpaqueFrame(a, width, height),
    second = await decodeOpaqueFrame(b, width, height);
  let abs = 0,
    square = 0,
    maxError = 0,
    changedPixels = 0;
  for (let i = 0; i < first.length; i += 4) {
    let localMax = 0;
    for (let c = i; c < i + 3; c++) {
      const d = Math.abs(first[c] - second[c]);
      abs += d;
      square += d * d;
      localMax = Math.max(localMax, d);
    }
    if (localMax) changedPixels++;
    maxError = Math.max(maxError, localMax);
  }
  const pixels = width * height;
  return {
    pixels,
    changedPixels,
    maxError,
    mae: abs / (pixels * 3),
    rmse: Math.sqrt(square / (pixels * 3)),
  };
}

export async function compareReferenceImage({
  image,
  ref,
  file,
  width,
  height,
  external,
  reasons,
}) {
  const empty = (status, reasons) => ({ status, reasons, metrics: null });
  if (
    !sha(ref.sha256) ||
    typeof ref.png !== 'string' ||
    !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,120}\.png$/.test(ref.png)
  )
    reasons.push('image-identity');
  if (reasons.length) return empty('unverified', reasons);
  let bytes;
  try {
    bytes = await boundedFile(join(dirname(file), ref.png), 16 * 1024 ** 2);
  } catch {
    return empty('unverified', ['unreadable-reference-png']);
  }
  if (digest(bytes) !== ref.sha256) return empty('unverified', ['image-digest']);
  if (bytes.length < 24 || bytes.readUInt32BE(16) !== width || bytes.readUInt32BE(20) !== height)
    return empty('unverified', ['image-dimensions']);
  let metrics;
  try {
    metrics = await rgbMetrics(image, bytes, width, height);
  } catch {
    return empty('unverified', ['invalid-reference-png']);
  }
  return {
    status: external ? 'matched-external' : 'matched-baseline',
    reasons: [],
    referenceSha256: ref.sha256,
    metrics,
  };
}
