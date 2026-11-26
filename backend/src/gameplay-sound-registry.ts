import { readFileSync } from 'node:fs';
import { z } from 'zod';
export const { inspectGameplayAudio, gameplayAudioLimits } = (await import(
  new URL(
    import.meta.url.endsWith('.ts')
      ? '../../shared/gameplay-sound-files.mjs'
      : './gameplay-sound-files.mjs',
    import.meta.url,
  ).href
)) as typeof import('../../shared/gameplay-sound-files.mjs');
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
          /** The official event's distance (inches) to volume curve. */
          distance: z
            .array(
              z.tuple([z.number().finite().min(0).max(20000), z.number().finite().min(0).max(1)]),
            )
            .min(1)
            .max(16)
            .optional(),
          /** The item holding the official distant layer of this sound. */
          distant: z
            .string()
            .regex(/^[a-z0-9-]{1,60}$/)
            .optional(),
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
            /** Valve's authored variations, chosen by the recorded sound seed. */
            variants: z
              .array(z.string().regex(/^[a-z0-9-]{1,60}$/))
              .min(2)
              .max(64)
              .optional(),
            /** Valve's distance-to-gain curve: [Source inches, gain] in ascending distance. */
            distance: z
              .array(
                z.tuple([z.number().finite().min(0).max(20000), z.number().finite().min(0).max(1)]),
              )
              .min(2)
              .max(16)
              .optional(),
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
if (Object.keys(gameplaySoundRegistry.items).length > gameplayAudioLimits.bankItems)
  throw Error('Sound registry exceeds its fixed bound.');
for (const item of Object.values(gameplaySoundRegistry.items))
  if (
    item.distant !== undefined &&
    (!gameplaySoundRegistry.items[item.distant] ||
      gameplaySoundRegistry.items[item.distant].distant !== undefined)
  )
    throw Error('A distant sound layer must name a fixed single-layer item.');
