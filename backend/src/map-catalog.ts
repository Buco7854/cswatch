import { lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname } from 'node:path';
import { z } from 'zod';
import type {
  ApprovedMapEntry,
  MapCatalog,
  MapIdentity,
  MapResolution,
} from '../../shared/map-acquisition.js';
import { mapIdentitySchema, officialMapName } from './map-identity.js';
import { bytesFrom, fileVersion, regularFile, withDirectory } from './map-asset-files.js';
export const mapCatalogLimits = { bytes: 256 * 1024, entries: 512 } as const;
const decimal64 = z
  .string()
  .regex(/^[1-9][0-9]{0,19}$/)
  .refine((v) => BigInt(v) <= 18446744073709551615n);
export const approvedIdentitySchema = mapIdentitySchema
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
