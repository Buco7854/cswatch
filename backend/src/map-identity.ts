import { z } from 'zod';
import type { MapIdentity } from '../../shared/map-acquisition.js';

export const officialMapName = z.string().regex(/^[a-z][a-z0-9_]{1,79}$/);
const recordedMapName = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const build = z.number().int().min(1).max(2147483647);
export const mapIdentitySchema = z
  .object({
    map: recordedMapName,
    buildNum: build.optional(),
    patchVersion: build.optional(),
    demoVersionGuid: z
      .string()
      .regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/)
      .optional(),
    addonPresence: z.enum(['none', 'present']).optional(),
    conflicted: z.literal(true).optional(),
  })
  .strict();

/** Raw header fields only. No coercion from game paths, protocol guesses or
 * Steam metadata. The recording is evidence supplied by its uploader. */
export function recordedMapIdentity(header: unknown): MapIdentity | undefined {
  if (!header || typeof header !== 'object') return;
  const value = header as Record<string, unknown>;
  if (!recordedMapName.safeParse(value.map_name).success) return;
  const identity: MapIdentity = { map: value.map_name as string };
  if (build.safeParse(value.build_num).success) identity.buildNum = value.build_num as number;
  if (build.safeParse(value.patch_version).success)
    identity.patchVersion = value.patch_version as number;
  if (typeof value.demo_version_guid === 'string') {
    const guid = value.demo_version_guid.toLowerCase();
    if (mapIdentitySchema.shape.demoVersionGuid.safeParse(guid).success)
      identity.demoVersionGuid = guid;
  }
  if (typeof value.addons === 'string')
    identity.addonPresence = value.addons.length > 4096 || value.addons.trim() ? 'present' : 'none';
  return identity;
}

export function observeMapIdentity(reader: Pick<import('cs2parser').DemoReader, 'on'>) {
  let identity: MapIdentity | undefined;
  let seenHeader = false;
  let conflict = false;
  reader.on('header', (header: unknown) => {
    const next = recordedMapIdentity(header);
    if (seenHeader && JSON.stringify(next) !== JSON.stringify(identity)) conflict = true;
    if (!seenHeader) identity = next;
    seenHeader = true;
  });
  reader.on('serverinfo', (message) => {
    if (!identity) return;
    if (
      (typeof message.map_name === 'string' && message.map_name !== identity.map) ||
      (typeof message.protocol === 'number' &&
        identity.patchVersion !== undefined &&
        message.protocol !== identity.patchVersion)
    )
      conflict = true;
    if (typeof message.addon_name === 'string') {
      const presence = message.addon_name.trim() ? 'present' : 'none';
      if (identity.addonPresence && identity.addonPresence !== presence) conflict = true;
      // The network field can establish absence/presence when the header omits it.
      identity.addonPresence ??= presence;
    }
  });
  return (): MapIdentity | undefined =>
    identity ? { ...identity, ...(conflict ? { conflicted: true } : {}) } : undefined;
}
