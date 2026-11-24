/** Offline operator inventory for the current preparer and an observed Steam manifest. */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { mapPreparerRevision } from '../../backend/dist/asset-preparer.js';
import { officialMapInventoryLimits, latestMapRequestId } from '../../backend/dist/map-catalog.js';
import {
  readMapRequest,
  readMapResult,
  readOfficialMapInventory,
} from '../../backend/dist/map-jobs.js';
import { inspectManagedPack, mapQueueIds } from '../../backend/dist/map-removals.js';
import { withDirectory, regularFile, bytesFrom } from '../../backend/dist/map-asset-files.js';
import { graphicsLimits, readBoundVisualAudit } from './map-graphics-contract.mjs';

async function readBytes(dir, name, limit) {
  const file = await regularFile(dir, name, 2, limit);
  if (!file) throw Error('Invalid graphics record');
  try {
    return await bytesFrom(file, (await file.stat()).size, limit);
  } finally {
    await file.close();
  }
}

const visibilityStatuses = new Set(['visible', 'no-pixel-change', 'unavailable', 'ambiguous']);
const comparisons = new Set([
  'matched-external',
  'matched-baseline',
  'missing-view',
  'unverified',
  'no-reference',
]);

// Capture reports are local operator evidence. The complete set of planned poses
// must belong to this exact published tier before counting comparisons.
export function captureSummary(report, audit, sha256) {
  const invalid = { status: 'invalid_capture' };
  if (
    report?.schemaVersion !== 1 ||
    report.kind !== 'cswatch-graphics-capture' ||
    report.auditSha256 !== sha256 ||
    report.auditBinding !== 'tier-manifest' ||
    !['map', 'tier', 'assetVersion', 'sourceSha256', 'modelSha256', 'coordinateSystem'].every(
      (key) => report[key] === audit[key],
    ) ||
    !['pass', 'fail', 'unverified', 'not-evaluated'].includes(report.verdict) ||
    !Array.isArray(report.views) ||
    report.views.length !== audit.views.length
  )
    return invalid;
  const visibility = {},
    comparison = {},
    visibleComparisons = {};
  for (const [index, view] of audit.views.entries()) {
    const actual = report.views[index];
    if (
      actual?.index !== index ||
      !Object.keys(view).every((key) => isDeepStrictEqual(view[key], actual[key])) ||
      !visibilityStatuses.has(actual.visibility?.status) ||
      !comparisons.has(actual.comparison?.status)
    )
      return invalid;
    visibility[actual.visibility.status] = (visibility[actual.visibility.status] ?? 0) + 1;
    comparison[actual.comparison.status] = (comparison[actual.comparison.status] ?? 0) + 1;
    if (actual.visibility.status === 'visible' && actual.comparison.status.startsWith('matched-'))
      visibleComparisons[actual.comparison.status] =
        (visibleComparisons[actual.comparison.status] ?? 0) + 1;
  }
  return {
    status: 'captured',
    visibility,
    comparison,
    visibleComparisons,
    verdict: report.verdict,
  };
}

async function tierReport(assets, captures, pack, tier) {
  const parts = ['packs', pack.packId, 'maps', pack.map, tier];
  return (
    (await withDirectory(assets, parts, async (dir) => {
      const manifest = JSON.parse(await readBytes(dir, 'manifest.json', 16384));
      if (
        manifest.schemaVersion !== 1 ||
        manifest.map !== pack.map ||
        manifest.tier !== tier ||
        manifest.assetVersion !== pack.assetVersion
      )
        return;
      if (
        !Number.isSafeInteger(manifest.bytes) ||
        manifest.bytes < 24 ||
        manifest.bytes > 2 * 1024 ** 3
      )
        return;
      const model = await regularFile(dir, 'scene.glb', manifest.bytes, manifest.bytes);
      if (!model) return;
      await model.close();
      const audit = readBoundVisualAudit(
        await readBytes(dir, 'visual-audit.json', graphicsLimits.bytes),
        manifest,
      );
      let capture;
      if (captures) {
        capture = await withDirectory(captures, [pack.packId, tier], async (captureDir) => {
          try {
            const report = JSON.parse(await readBytes(captureDir, 'capture.json', 1024 * 1024));
            return captureSummary(report, audit, manifest.visualAuditSha256);
          } catch (error) {
            return { status: error.code === 'ENOENT' ? 'no_capture' : 'invalid_capture' };
          }
        });
      }
      return {
        status: 'audited',
        auditPath: [...parts, 'visual-audit.json'].join('/'),
        sourceSha256: audit.sourceSha256,
        modelSha256: audit.modelSha256,
        materialFamilies: audit.materials,
        plannedViews: audit.views.length,
        bakedPrimitives: manifest.bakedLighting?.primitives ?? 0,
        vertexLitPrimitives: manifest.vertexLighting ?? 0,
        lightingFallback: manifest.lightingFallback ?? null,
        capture: capture ?? { status: captures ? 'no_capture' : 'not_checked' },
      };
    })) ?? { status: 'audit_unavailable' }
  );
}

async function mapState(jobs, assets, captures, request, id) {
  const result = await readMapResult(jobs, id);
  if (!request) return { status: result ? 'unavailable' : 'not_requested' };
  if (!result) return { status: 'queued' };
  if (result.status !== 'ready')
    return { status: result.status, ...(result.code ? { code: result.code } : {}) };
  const pack = await inspectManagedPack(assets, request, result);
  if (!pack) return { status: 'unavailable' };
  pack.assetVersion = request.approval?.assetVersion ?? `steam-2347770-${pack.manifest}`;
  const environment = await withDirectory(
    assets,
    ['packs', pack.packId, 'maps', 'environments', pack.map],
    async (dir) => {
      const env = JSON.parse(await readBytes(dir, 'environment.json', 16384));
      if (env.schemaVersion === 2 && env.map === pack.map && env.assetVersion === pack.assetVersion)
        return {
          sky: !!env.sky,
          landscape: env.landscape,
          fog: !!(env.fog || env.gradientFog),
          grade: !!env.grade,
        };
    },
  );
  const tiers = {};
  for (const tier of ['desktop', 'mobile'])
    tiers[tier] = await tierReport(assets, captures, pack, tier);
  return { status: 'ready', packId: pack.packId, environment: environment ?? null, tiers };
}

export async function graphicsInventory({
  jobs,
  assets,
  captures,
  at = Math.floor(Date.now() / 1000),
}) {
  const inventory = await readOfficialMapInventory(jobs, at, { allowStale: true });
  const metadata = {
    schemaVersion: 1,
    kind: 'cswatch-official-graphics-inventory',
    mapPreparerRevision,
    at,
  };
  // Historical approvals and the currently observed depot manifest have different
  // identities. A successful comparison for one must never cover the other.
  const approved = [],
    requests = new Map();
  for (const id of await mapQueueIds(jobs, 'requests')) {
    const request = await readMapRequest(jobs, id);
    requests.set(id, request);
    if (request?.approval)
      approved.push({
        map: request.approval.identity.map,
        manifest: request.approval.source.manifest,
        requestId: id,
        ...(await mapState(jobs, assets, captures, request, id)),
      });
  }
  if (!inventory) return { ...metadata, status: 'inventory_unavailable', maps: null, approved };
  const maps = [];
  for (const entry of [...inventory.maps].sort((a, b) => a.map.localeCompare(b.map))) {
    const selection = {
      ...entry,
      appId: inventory.appId,
      depotId: inventory.depotId,
      manifest: inventory.manifest,
    };
    const id = latestMapRequestId(selection);
    maps.push({
      ...entry,
      ...(requests.has(id) && !requests.get(id)
        ? { status: 'unavailable' }
        : await mapState(jobs, assets, captures, requests.get(id), id)),
    });
  }
  return {
    ...metadata,
    status:
      at - inventory.updatedAt > officialMapInventoryLimits.maxAgeSeconds ? 'stale' : 'current',
    appId: inventory.appId,
    depotId: inventory.depotId,
    manifest: inventory.manifest,
    updatedAt: inventory.updatedAt,
    maps,
    approved,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: {
      jobs: { type: 'string' },
      assets: { type: 'string' },
      captures: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  const jobs = values.jobs ?? process.env.MAP_JOBS_DIR,
    assets = values.assets ?? process.env.MAP_ASSETS_DIR;
  if (values.help || !jobs || !assets) {
    console.log(
      'node tools/assets/map-graphics-inventory.mjs --jobs MAP_JOBS_DIR --assets MAP_ASSETS_DIR [--captures DIR]',
    );
    process.exitCode = values.help ? 0 : 1;
  } else {
    const report = await graphicsInventory({ jobs, assets, captures: values.captures });
    console.log(JSON.stringify(report, null, 2));
    if (report.status === 'inventory_unavailable') process.exitCode = 1;
  }
}
