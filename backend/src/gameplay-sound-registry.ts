import { readFileSync } from 'node:fs';
import { z } from 'zod';
export const gameplaySoundRegistry = z
  .object({
    schemaVersion: z.literal(1),
    items: z.record(
      z.string().regex(/^[a-z0-9-]{1,60}$/),
      z
        .object({
          source: z.string().regex(/^sounds\/[a-z0-9_/-]{1,200}\.vsnd_c$/),
          category: z.enum(['weapon', 'footstep', 'reload', 'utility', 'objective', 'round']),
          weapon: z
            .string()
            .regex(/^[a-z0-9]{1,40}$/)
            .optional(),
          tokens: z.array(z.string().min(1).max(128)).max(16).optional(),
        })
        .strict(),
    ),
    events: z
      .record(
        z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/),
        z
          .object({
            soundId: z.string().regex(/^[a-z0-9-]{1,60}$/),
            channel: z.enum(['sos', 'weapon-sound']),
            hash: z.number().int().min(0).max(0xffffffff).optional(),
            volume: z.number().finite().min(0).max(1).optional(),
            pitch: z.number().finite().min(0.25).max(4).optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict()
  .parse(
    JSON.parse(
      readFileSync(
        new URL(
          import.meta.url.endsWith('.ts')
            ? '../../shared/gameplay-sounds.json'
            : './gameplay-sounds.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  );
if (Object.keys(gameplaySoundRegistry.items).length > 128)
  throw Error('Sound registry exceeds its fixed bound.');
