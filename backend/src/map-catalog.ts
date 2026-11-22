import { lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname } from 'node:path';
import { z } from 'zod';
import type {
  ApprovedMapEntry,
  MapCatalog,
  MapIdentity,
  MapResolution,
  OfficialMapInventory,
  LatestOfficialSelection,
  OfficialMapSource,
} from '../../shared/map-acquisition.js';
import { mapIdentitySchema, officialMapName } from './map-identity.js';
import { bytesFrom, fileVersion, regularFile, withDirectory } from './map-asset-files.js';
export const mapCatalogLimits = { bytes: 256 * 1024, entries: 512 } as const;
const decimal64 = z
  .string()
  .regex(/^[1-9][0-9]{0,19}$/)
  .refine((v) => BigInt(v) <= 18446744073709551615n);
const approvedIdentitySchema = mapIdentitySchema
  .required()
  .omit({ conflicted: true })
  .extend({ map: officialMapName, addonPresence: z.literal('none') });
export const officialMapSourceSchema = z
  .object({
    appId: z.literal(730),
    depotId: z.literal(2347770),
    manifest: decimal64,
    mapSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const officialMapInventoryLimits = {
  bytes: 128 * 1024,
  maps: 256,
  maxAgeSeconds: 24 * 60 * 60,
} as const;
const officialMapInventoryItemSchema = z
  .object({
    map: officialMapName,
    sha1: z.string().regex(/^[a-f0-9]{40}$/),
    bytes: z
      .number()
      .int()
      .min(1)
      .max(2 * 1024 ** 3),
  })
  .strict();
export const officialMapInventorySchema = z
  .object({
    schemaVersion: z.literal(1),
    appId: z.literal(730),
    depotId: z.literal(2347770),
    manifest: decimal64,
    updatedAt: z.number().int().min(0).max(8640000000000),
    maps: z.array(officialMapInventoryItemSchema).min(1).max(officialMapInventoryLimits.maps),
  })
  .strict()
  .refine((value) => new Set(value.maps.map((item) => item.map)).size === value.maps.length);
export const latestOfficialSelectionSchema = officialMapInventoryItemSchema
  .extend({
    appId: z.literal(730),
    depotId: z.literal(2347770),
    manifest: decimal64,
  })
  .strict();
export function latestMapRequestId(value: LatestOfficialSelection): string {
  const item = latestOfficialSelectionSchema.parse(value);
  return createHash('sha256')
    .update(
      JSON.stringify({
        kind: 'latest-official',
        map: item.map,
        appId: item.appId,
        depotId: item.depotId,
        manifest: item.manifest,
        sha1: item.sha1,
        bytes: item.bytes,
      }),
    )
    .digest('hex');
}
export function latestMapPackId(map: string, value: OfficialMapSource): string {
  officialMapName.parse(map);
  const source = officialMapSourceSchema.parse(value);
  return createHash('sha256')
    .update(
      JSON.stringify({
        kind: 'latest-official-content',
        map,
        appId: source.appId,
        depotId: source.depotId,
        manifest: source.manifest,
        mapSha256: source.mapSha256,
      }),
    )
    .digest('hex');
}
export function latestOfficialSelection(
  inventory: OfficialMapInventory,
  map: string,
): LatestOfficialSelection | undefined {
  const checked = officialMapInventorySchema.parse(inventory);
  const item = checked.maps.find((item) => item.map === map);
  if (!item) return;
  return { ...item, appId: 730, depotId: 2347770, manifest: checked.manifest };
}
export const latestMapPackMarkerSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('latest-official'),
    packId: z.string().regex(/^[a-f0-9]{64}$/),
    requestId: z.string().regex(/^[a-f0-9]{64}$/),
    selection: latestOfficialSelectionSchema,
    source: officialMapSourceSchema,
    preparedAt: z.number().int().min(0).max(8640000000000),
  })
  .strict()
  .refine(
    (value) =>
      value.requestId === latestMapRequestId(value.selection) &&
      value.packId === latestMapPackId(value.selection.map, value.source) &&
      value.source.manifest === value.selection.manifest,
  );
export const approvedMapEntrySchema = z
  .object({
    identity: approvedIdentitySchema,
    source: officialMapSourceSchema,
    assetVersion: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,100}$/)
      .optional(),
  })
  .strict();
export const mapCatalogSchema = z
  .object({
    schemaVersion: z.literal(1),
    entries: z.array(approvedMapEntrySchema).max(mapCatalogLimits.entries),
  })
  .strict();
export function canonicalMapApproval(value: ApprovedMapEntry): string {
  const entry = approvedMapEntrySchema.parse(value),
    i = entry.identity,
    s = entry.source;
  return JSON.stringify({
    identity: {
      map: i.map,
      buildNum: i.buildNum,
      patchVersion: i.patchVersion,
      demoVersionGuid: i.demoVersionGuid,
      addonPresence: i.addonPresence,
    },
    source: { appId: s.appId, depotId: s.depotId, manifest: s.manifest, mapSha256: s.mapSha256 },
    ...(entry.assetVersion === undefined ? {} : { assetVersion: entry.assetVersion }),
  });
}
export const mapPackId = (entry: ApprovedMapEntry) =>
  createHash('sha256').update(canonicalMapApproval(entry)).digest('hex');
export async function readMapCatalog(filename: string): Promise<MapCatalog | undefined> {
  try {
    await lstat(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { schemaVersion: 1, entries: [] };
    return;
  }
  return withDirectory(dirname(filename), [], async (directory) => {
    const file = await regularFile(directory, basename(filename), 2, mapCatalogLimits.bytes);
    if (!file) return;
    try {
      const stat = await file.stat();
      if (stat.mode & 0o022) return;
      const before = await fileVersion(file),
        bytes = await bytesFrom(file, stat.size, mapCatalogLimits.bytes);
      if (before !== (await fileVersion(file))) return;
      return mapCatalogSchema.parse(JSON.parse(bytes.toString('utf8')));
    } finally {
      await file.close();
    }
  });
}
export function resolveMap(
  identity: MapIdentity | undefined,
  catalog: MapCatalog | undefined,
): MapResolution {
  if (!identity || identity.conflicted || !mapIdentitySchema.safeParse(identity).success)
    return { status: 'unknown' };
  if (identity.addonPresence === 'present') return { status: 'addon' };
  const complete = approvedIdentitySchema.safeParse(identity);
  if (!complete.success) return { status: 'unknown' };
  if (!catalog) return { status: 'catalog_invalid' };
  const checked = mapCatalogSchema.safeParse(catalog);
  if (!checked.success) return { status: 'catalog_invalid' };
  const matches = checked.data.entries.filter((entry) =>
    Object.entries(complete.data).every(
      ([key, value]) => entry.identity[key as keyof typeof entry.identity] === value,
    ),
  );
  const unique = new Map(matches.map((entry) => [canonicalMapApproval(entry), entry]));
  if (!unique.size) return { status: 'unmapped' };
  if (unique.size !== 1) return { status: 'ambiguous' };
  const approval = unique.values().next().value!;
  return { status: 'approved', approval, packId: mapPackId(approval) };
}

const identityFields = [
  'map',
  'buildNum',
  'patchVersion',
  'demoVersionGuid',
  'addonPresence',
] as const;

/** Operator diagnostics only. A matched unsigned header tuple selects an
 * approval; it cannot establish the map bytes originally used by the server.
 * Keep this projection free of replay actors, server addresses and local paths. */
export function diagnoseMapIdentity(value: unknown, catalog?: unknown, expectedMap?: string) {
  const parsed = mapIdentitySchema.safeParse(value);
  const identity = parsed.success ? parsed.data : undefined;
  const checked = catalog === undefined ? undefined : mapCatalogSchema.safeParse(catalog);
  const missingFields = identityFields.filter((field) => identity?.[field] === undefined);
  const issues: string[] = [];
  if (value === undefined || value === null) issues.push('identity_missing');
  else if (!identity) issues.push('identity_invalid');
  const mapMismatch =
    expectedMap !== undefined && identity !== undefined && identity.map !== expectedMap;
  if (mapMismatch) issues.push('replay_map_mismatch');
  if (identity?.conflicted) issues.push('recorded_fields_conflict');
  if (identity?.addonPresence === 'present') issues.push('addon_content');
  if (missingFields.length) issues.push('identity_incomplete');
  if (checked && !checked.success) issues.push('catalog_invalid');
  const complete =
    identity &&
    !identity.conflicted &&
    !mapMismatch &&
    approvedIdentitySchema.safeParse(identity).success;
  const resolution =
    complete && !checked
      ? { status: 'not_evaluated' as const }
      : resolveMap(mapMismatch ? undefined : identity, checked?.success ? checked.data : undefined);
  if (resolution.status === 'unmapped') issues.push('no_approved_source');
  if (resolution.status === 'ambiguous') issues.push('multiple_approved_sources');
  const candidates = new Map<string, ApprovedMapEntry>();
  if (complete && checked?.success)
    for (const entry of checked.data.entries)
      if (identityFields.every((field) => entry.identity[field] === identity[field]))
        candidates.set(canonicalMapApproval(entry), entry);
  const project = (entry: ApprovedMapEntry) => ({
    packId: mapPackId(entry),
    source: entry.source,
    ...(entry.assetVersion === undefined ? {} : { assetVersion: entry.assetVersion }),
  });
  return {
    schemaVersion: 1 as const,
    recordedIdentity: identity ?? null,
    missingFields,
    issues,
    resolution: resolution.status,
    catalog: {
      status: !checked ? 'not_provided' : checked.success ? 'valid' : 'invalid',
      entries: checked?.success ? checked.data.entries.length : 0,
      distinctMatchingApprovals: candidates.size,
    },
    candidates: [...candidates.values()].map(project),
    selected: resolution.status === 'approved' ? project(resolution.approval) : null,
    evidence: {
      recording: 'unsigned-header-metadata',
      selection: resolution.status === 'approved' ? 'operator-approval' : 'none',
      originalMapContent: 'not-verified',
      sourceAvailability: 'not-checked',
    },
  };
}
