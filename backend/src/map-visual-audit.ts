import { createHash } from 'node:crypto';
import { z } from 'zod';

import { readFileSync } from 'node:fs';
const limits = JSON.parse(
  readFileSync(
    new URL(
      import.meta.url.endsWith('.ts') ? '../../shared/map-graphics.json' : './map-graphics.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as typeof import('../../shared/map-graphics.json');
export const visualAuditBytes = limits.bytes;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const feature = z.enum([
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
const shader = z.string().regex(/^(?:gltf|[a-z0-9_]{1,100}\.vfx)$/);
const action = z.string().regex(/^[a-z][a-z_]{0,63}$/);
const coordinate = z.number().min(-limits.maxAbsCoordinate).max(limits.maxAbsCoordinate);
const point = z.tuple([coordinate, coordinate, coordinate]);
export const visualAuditSchema = z
  .object({
    schemaVersion: z.literal(1),
    map: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
    tier: z.enum(['desktop', 'mobile']),
    assetVersion: z.string().min(1).max(100),
    sourceSha256: hash,
    modelSha256: hash,
    coordinateSystem: z.literal('gltf-meters-y-up'),
    materials: z
      .array(
        z
          .object({
            shader,
            action,
            feature,
            coverage: z.enum([
              'source_backed',
              'approximated',
              'omitted',
              'intentionally_hidden',
              'unknown',
            ]),
            primitives: z.number().int().positive().max(2147483647),
          })
          .strict(),
      )
      .max(limits.materials),
    views: z
      .array(
        z
          .object({
            feature,
            shader,
            action,
            materialName: z
              .string()
              .max(256)
              .regex(/^[^\u0000-\u001f\u007f]*$/),
            eye: point,
            target: point,
          })
          .strict(),
      )
      .max(limits.views),
  })
  .strict()
  .refine((audit) => {
    const keys = new Set(audit.materials.map((r) => [r.feature, r.shader, r.action].join(':')));
    return audit.views.every(
      (v) =>
        keys.has([v.feature, v.shader, v.action].join(':')) &&
        v.eye.some((n, i) => n !== v.target[i]),
    );
  }, 'Graphics probe must address an inventoried feature from a distinct camera position.');

export function readBoundVisualAudit(
  bytes: Buffer,
  manifest: {
    map: string;
    tier: string;
    assetVersion: string;
    outputSha256: string;
    sourceSha256: string;
    visualAuditSha256: string;
  },
) {
  if (
    bytes.length > visualAuditBytes ||
    createHash('sha256').update(bytes).digest('hex') !== manifest.visualAuditSha256
  )
    throw Error('Graphics audit hash mismatch.');
  const audit = visualAuditSchema.parse(JSON.parse(bytes.toString('utf8')));
  if (
    audit.modelSha256 !== manifest.outputSha256 ||
    audit.sourceSha256 !== manifest.sourceSha256 ||
    audit.map !== manifest.map ||
    audit.tier !== manifest.tier ||
    audit.assetVersion !== manifest.assetVersion
  )
    throw Error('Graphics audit does not match the prepared map tier.');
  return audit;
}
