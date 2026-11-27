import { z } from 'zod';

/** Bump to invalidate incompatible worker output without touching operator assets. */
export const preparerRevision = 4 as const;
export const mapPreparerRevision = 11 as const;
export const presentationDirectory = `presentation-v${preparerRevision}`;

const MiB = 1024 ** 2;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const viewmodelActionSeconds = {
  draw: 2.5,
  fire: 4,
  reload: 6,
  throw: 2,
  underhand: 2,
  slash: 2,
  // Recorded-evidence actions: the inspect key, a knife's secondary attack,
  // a grenade's pin and the C4 plant.
  inspect: 10,
  heavy: 3,
  pullpin: 3,
  plant: 6,
  // The recorded silencer state of an M4A1-S or USP-S changing (the official clips last 4.83 s).
  silencerOn: 5,
  silencerOff: 5,
} as const;
const action = (maximum: number) =>
  z
    .object({
      seconds: z.number().positive().max(maximum),
      frames: z.number().int().min(2).max(181),
      targets: z.number().int().min(1).max(96),
    })
    .strict();
export const viewmodelManifest = z
  .object({
    schemaVersion: z.literal(preparerRevision),
    id: z.string().regex(/^[a-z0-9]{1,40}$/),
    manifest: z
      .string()
      .regex(/^[1-9]\d{0,19}$/)
      .refine((value) => BigInt(value) <= 18446744073709551615n),
    sha256: hash,
    bytes: z
      .number()
      .int()
      .min(24)
      .max(8 * MiB),
    decodedGeometryBytes: z
      .number()
      .int()
      .positive()
      .max(8 * MiB),
    decodedTextureBytes: z
      .number()
      .int()
      .min(0)
      .max(16 * MiB),
    actions: z
      .object({
        draw: action(viewmodelActionSeconds.draw),
        fire: action(viewmodelActionSeconds.fire).optional(),
        reload: action(viewmodelActionSeconds.reload).optional(),
        throw: action(viewmodelActionSeconds.throw).optional(),
        underhand: action(viewmodelActionSeconds.underhand).optional(),
        slash: action(viewmodelActionSeconds.slash).optional(),
        inspect: action(viewmodelActionSeconds.inspect).optional(),
        heavy: action(viewmodelActionSeconds.heavy).optional(),
        pullpin: action(viewmodelActionSeconds.pullpin).optional(),
        plant: action(viewmodelActionSeconds.plant).optional(),
        silencerOn: action(viewmodelActionSeconds.silencerOn).optional(),
        silencerOff: action(viewmodelActionSeconds.silencerOff).optional(),
      })
      .strict(),
  })
  .strict();
