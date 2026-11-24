import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual as equal } from 'node:util';
import { createRequire } from 'node:module';
const sharp = createRequire(new URL('../../tools/assets/package.json', import.meta.url))('sharp');

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

export function auditViews(audit, manifest) {
  assert(
    audit.schemaVersion === 1 &&
      audit.coordinateSystem === coordinateSystem &&
      manifest.schemaVersion === 1 &&
      /^[a-zA-Z0-9_-]{1,80}$/.test(audit.map) &&
      audit.map === manifest.map &&
      audit.tier === manifest.tier &&
      ['desktop', 'mobile'].includes(audit.tier),
    'Invalid audit/map tier identity',
  );
  assert(
    sha(audit.modelSha256) &&
      audit.modelSha256 === manifest.outputSha256 &&
      sha(audit.sourceSha256) &&
      audit.sourceSha256 === manifest.sourceSha256 &&
      text(audit.assetVersion, 100) &&
      audit.assetVersion.length &&
      audit.assetVersion === manifest.assetVersion,
    'Audit provenance mismatch',
  );
  assert(
    Array.isArray(audit.materials) && Array.isArray(audit.views) && audit.views.length <= 24,
    'Invalid audit material/view list',
  );
  return audit.views.map((view, index) => {
    const { feature, shader, action, materialName = '', eye, target } = view;
    assert(
      text(feature, 256) &&
        feature.length &&
        text(shader, 128) &&
        text(action, 80) &&
        text(materialName, 1024),
      'Invalid view identity',
    );
    const point = (v) =>
      Array.isArray(v) &&
      v.length === 3 &&
      v.every((x) => Number.isFinite(x) && Math.abs(x) <= 1e6);
    assert(
      point(eye) && point(target) && Math.hypot(...eye.map((v, i) => v - target[i])) > 1e-6,
      'Invalid view pose',
    );
    return { index, feature, shader, action, materialName, eye, target };
  });
}

export async function rgbMetrics(a, b, width, height) {
  async function decode(bytes) {
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
    return raw.data;
  }
  const first = await decode(a),
    second = await decode(b);
  let abs = 0,
    square = 0,
    maxError = 0,
    changedPixels = 0;
  for (let i = 0; i < first.length; i += 4) {
    assert(first[i + 3] === 255 && second[i + 3] === 255, 'Expected opaque HUD-free frame');
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

export async function compareView(report, view, image, reference, file) {
  const empty = (status, reasons = []) => ({ status, reasons, metrics: null });
  if (!reference) return empty('no-reference');
  assert(
    reference.schemaVersion === 1 &&
      [captureKind, externalKind].includes(reference.kind) &&
      Array.isArray(reference.views) &&
      reference.views.length <= 24,
    'Invalid reference manifest',
  );
  const candidates = reference.views.filter((v) => v.index === view.index);
  if (!candidates.length) return empty('missing-view');
  if (candidates.length !== 1) return empty('unverified', ['ambiguous-view']);
  const ref = candidates[0],
    external = reference.kind === externalKind;
  const reasons = [];
  for (const key of [
    'map',
    'assetVersion',
    'sourceSha256',
    'coordinateSystem',
    'projection',
    'colorSpace',
    'hudFree',
  ])
    if (!equal(reference[key], report[key])) reasons.push(key);
  for (const key of ['eye', 'target']) if (!equal(ref[key], view[key])) reasons.push(key);
  if (external) {
    const p = reference.provenance;
    if (
      !['CS2', 'reference'].includes(p?.producer) ||
      !text(p?.version, 200) ||
      !p.version.trim() ||
      !text(p?.captureSource, 500) ||
      !p.captureSource.trim() ||
      !text(p?.renderSettings, 1000) ||
      !p.renderSettings.trim()
    )
      reasons.push('external-provenance');
  } else {
    for (const key of ['tier', 'settings', 'scope'])
      if (!equal(reference[key], report[key])) reasons.push(key);
    for (const key of ['feature', 'shader', 'action', 'materialName'])
      if (ref[key] !== view[key]) reasons.push(key);
    if (!sha(reference.modelSha256)) reasons.push('baseline-model');
    if (!sha(reference.auditSha256) || reference.auditBinding !== 'tier-manifest')
      reasons.push('baseline-audit');
  }
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
  if (
    bytes.length < 24 ||
    bytes.readUInt32BE(16) !== report.projection.width ||
    bytes.readUInt32BE(20) !== report.projection.height
  )
    return empty('unverified', ['image-dimensions']);
  let metrics;
  try {
    metrics = await rgbMetrics(image, bytes, report.projection.width, report.projection.height);
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

export function evaluateLimits(report, view, reference, limits) {
  const { comparison, performance } = view;
  const checks = [];
  if (limits.maxMae !== undefined) {
    const value = comparison.metrics?.mae;
    checks.push({
      metric: 'mae',
      maximum: limits.maxMae,
      value: value ?? null,
      status: value === undefined ? 'unverified' : value > limits.maxMae ? 'fail' : 'pass',
    });
  }
  if (limits.maxP95Ratio !== undefined) {
    const prior = reference?.views.find((v) => v.index === view.index)?.performance;
    const comparable =
      comparison.status === 'matched-baseline' &&
      report.renderer.deviceId &&
      report.renderer.deviceClass !== 'unknown' &&
      equal(reference.renderer, report.renderer) &&
      reference.timing === report.timing &&
      prior?.samples === performance.samples &&
      prior?.warmup === performance.warmup &&
      prior.p95Ms > 0 &&
      Number.isFinite(prior.p95Ms);
    const value = comparable ? performance.p95Ms / prior.p95Ms : null;
    checks.push({
      metric: 'warm-p95-ratio',
      maximum: limits.maxP95Ratio,
      value,
      status: value === null ? 'unverified' : value > limits.maxP95Ratio ? 'fail' : 'pass',
    });
  }
  return checks;
}
