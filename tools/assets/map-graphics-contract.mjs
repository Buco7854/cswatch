import { createHash } from 'node:crypto';

export const graphicsLimits = Object.freeze({
  bytes: 128 * 1024,
  materials: 256,
  views: 24,
  maxAbsCoordinate: 1e6,
});
export const graphicsFeatures = Object.freeze([
  'unknown',
  'water',
  'glass',
  'foliage',
  'layered_surface',
  'lighting',
  'atmosphere',
  'decal',
  'unlit',
  'helper',
]);
const coverage = new Set([
  'source_backed',
  'approximated',
  'omitted',
  'intentionally_hidden',
  'unknown',
]);
const sha = (s) => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
const point = (v) =>
  Array.isArray(v) &&
  v.length === 3 &&
  v.every((n) => Number.isFinite(n) && Math.abs(n) <= graphicsLimits.maxAbsCoordinate);
const exact = (value, keys) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const keyOf = ({ feature, shader, action }) => [feature, shader, action].join(':');

// Every reader uses the same binding, material vocabulary and pose bounds. The
// publication supervisor independently verifies manifest.outputSha256 against the GLB.
export function readBoundVisualAudit(bytes, manifest) {
  if (
    bytes.length > graphicsLimits.bytes ||
    createHash('sha256').update(bytes).digest('hex') !== manifest.visualAuditSha256
  )
    throw Error('Graphics audit hash mismatch.');
  const audit = JSON.parse(bytes.toString('utf8'));
  if (
    !exact(audit, [
      'schemaVersion',
      'map',
      'tier',
      'assetVersion',
      'sourceSha256',
      'modelSha256',
      'coordinateSystem',
      'materials',
      'views',
    ]) ||
    manifest.schemaVersion !== 1 ||
    audit.schemaVersion !== 1 ||
    audit.coordinateSystem !== 'gltf-meters-y-up' ||
    typeof audit.map !== 'string' ||
    !/^[A-Za-z0-9_-]{1,80}$/.test(audit.map) ||
    !['mobile', 'desktop'].includes(audit.tier) ||
    typeof audit.assetVersion !== 'string' ||
    !audit.assetVersion.trim() ||
    audit.assetVersion.length > 100 ||
    !sha(audit.modelSha256) ||
    !sha(audit.sourceSha256) ||
    audit.modelSha256 !== manifest.outputSha256 ||
    audit.sourceSha256 !== manifest.sourceSha256 ||
    audit.map !== manifest.map ||
    audit.tier !== manifest.tier ||
    audit.assetVersion !== manifest.assetVersion
  )
    throw Error('Graphics audit does not match the prepared map tier.');
  if (
    !Array.isArray(audit.materials) ||
    audit.materials.length > graphicsLimits.materials ||
    !Array.isArray(audit.views) ||
    audit.views.length > graphicsLimits.views
  )
    throw Error('Graphics audit exceeds material or view limits.');
  const keys = new Set();
  for (const row of audit.materials) {
    if (
      !exact(row, ['shader', 'action', 'feature', 'coverage', 'primitives']) ||
      typeof row.shader !== 'string' ||
      !/^(?:gltf|[a-z0-9_]{1,100}\.vfx)$/.test(row.shader) ||
      typeof row.action !== 'string' ||
      !/^[a-z][a-z_]{0,63}$/.test(row.action) ||
      !graphicsFeatures.includes(row.feature) ||
      !coverage.has(row.coverage) ||
      !Number.isSafeInteger(row.primitives) ||
      row.primitives < 1 ||
      row.primitives > 2147483647
    )
      throw Error('Invalid graphics audit material.');
    keys.add(keyOf(row));
  }
  for (const view of audit.views) {
    if (
      !exact(view, ['feature', 'shader', 'action', 'materialName', 'eye', 'target']) ||
      !['feature', 'shader', 'action'].every((k) => typeof view[k] === 'string') ||
      !keys.has(keyOf(view)) ||
      typeof view.materialName !== 'string' ||
      view.materialName.length > 256 ||
      /[\x00-\x1f\x7f]/.test(view.materialName) ||
      !point(view.eye) ||
      !point(view.target) ||
      Math.hypot(...view.eye.map((n, i) => n - view.target[i])) <= 1e-6
    )
      throw Error('Invalid graphics audit view or material identity.');
  }
  return audit;
}
