/** Publication validation for the SHA-bound decoded texture plan. */
import { createHash } from 'node:crypto';
import { rgbaMipBytes, textureBudgetLimits, textureBudgetPolicies } from './texture-budget.mjs';
const keys = (value, names) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...names].sort().join(',');
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const digest = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const fields = [
  'schemaVersion',
  'budgetBytes',
  'maxEdge',
  'textures',
  'decodedRGBABytes',
  'residentBaseRGBABytes',
  'gpuMipRGBABytes',
  'sourceDecodedRGBABytes',
  'sourceEncodedImageBytes',
  'encodedImageBytes',
];
export function validateTexturePlan(manifest, bytes, tier) {
  const summary = manifest.textureBudget;
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength > textureBudgetLimits.planBytes ||
    !keys(summary, [...fields, 'planSha256']) ||
    !digest(summary.planSha256) ||
    createHash('sha256').update(bytes).digest('hex') !== summary.planSha256
  )
    throw new Error(
      'Prepared texture plan is missing, oversized or has a mismatched SHA256 binding.',
    );
  const plan = JSON.parse(Buffer.from(bytes).toString('utf8'));
  if (
    !keys(plan, ['schemaVersion', 'policy', 'summary', 'images']) ||
    plan.schemaVersion !== 1 ||
    !keys(plan.policy, ['tier', 'budgetBytes', 'maxEdge']) ||
    plan.policy.tier !== tier ||
    plan.policy.budgetBytes !== summary.budgetBytes ||
    plan.policy.maxEdge !== summary.maxEdge ||
    !keys(plan.summary, fields) ||
    !Array.isArray(plan.images) ||
    plan.images.length !== summary.textures ||
    plan.images.length > textureBudgetLimits.images ||
    fields.some((field) => plan.summary[field] !== summary[field]) ||
    summary.schemaVersion !== 1 ||
    !integer(summary.budgetBytes, 1, textureBudgetLimits.budgetBytes) ||
    !integer(summary.maxEdge, 1, textureBudgetPolicies[tier]?.maxEdge ?? 0)
  )
    throw new Error('Prepared texture budget summary does not match its bounded tier policy.');
  const totals = {
      decodedRGBABytes: 0,
      residentBaseRGBABytes: 0,
      gpuMipRGBABytes: 0,
      sourceDecodedRGBABytes: 0,
      sourceEncodedImageBytes: 0,
      encodedImageBytes: 0,
    },
    ids = new Set();
  for (const row of plan.images) {
    if (
      !keys(row, ['id', 'roles', 'copies', 'source', 'planned', 'actual']) ||
      typeof row.id !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(row.id) ||
      ids.has(row.id) ||
      !integer(row.copies, 1, 64) ||
      !Array.isArray(row.roles) ||
      row.roles.length > 64 ||
      row.roles.some((role) => typeof role !== 'string' || !/^[a-zA-Z0-9_]{1,80}$/.test(role)) ||
      !keys(row.source, ['width', 'height', 'bytes', 'sha256']) ||
      !keys(row.actual, ['width', 'height', 'bytes', 'sha256']) ||
      !keys(row.planned, ['width', 'height', 'halvings']) ||
      !integer(row.planned.halvings, 0, 32)
    )
      throw new Error('Invalid bounded per-image texture provenance.');
    ids.add(row.id);
    for (const image of [row.source, row.actual])
      if (
        !integer(image.width, 1, textureBudgetLimits.edge) ||
        !integer(image.height, 1, textureBudgetLimits.edge) ||
        image.width * image.height > textureBudgetLimits.sourcePixels ||
        !integer(image.bytes, 1, textureBudgetLimits.imageBytes) ||
        !digest(image.sha256)
      )
        throw new Error('Invalid texture image dimensions or hash provenance.');
    if (
      !integer(row.planned.width, 1, summary.maxEdge) ||
      !integer(row.planned.height, 1, summary.maxEdge) ||
      row.actual.width > row.planned.width ||
      row.actual.height > row.planned.height ||
      row.actual.width > row.source.width ||
      row.actual.height > row.source.height
    )
      throw new Error('Actual texture dimensions exceed their decoded plan.');
    const rgba = row.actual.width * row.actual.height * 4;
    totals.decodedRGBABytes += rgba;
    totals.residentBaseRGBABytes += rgba * row.copies;
    totals.gpuMipRGBABytes += rgbaMipBytes(row.actual.width, row.actual.height) * row.copies;
    totals.sourceDecodedRGBABytes += row.source.width * row.source.height * 4;
    totals.sourceEncodedImageBytes += row.source.bytes;
    totals.encodedImageBytes += row.actual.bytes;
  }
  if (
    Object.entries(totals).some(([field, total]) => summary[field] !== total) ||
    summary.decodedRGBABytes > summary.residentBaseRGBABytes ||
    summary.residentBaseRGBABytes > summary.budgetBytes ||
    summary.gpuMipRGBABytes > 2 * summary.residentBaseRGBABytes ||
    summary.sourceEncodedImageBytes > 4 * 1024 ** 3 ||
    summary.encodedImageBytes > 4 * 1024 ** 3
  )
    throw new Error(
      'Prepared decoded texture budget overflows or its exact totals are inconsistent.',
    );
  return plan;
}
