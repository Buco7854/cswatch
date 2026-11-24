import type { FileHandle } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import type { SharedGameplaySoundCatalog } from '../../shared/gameplay-sounds.js';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { bytesFrom, regularFile, withDirectory, fileVersion } from './map-asset-files.js';
import { HttpError } from './security.js';
import {
  gameplayAudioLimits,
  gameplaySoundRegistry,
  inspectGameplayAudio,
} from './gameplay-sound-registry.js';
const { managedSoundDirectory }: { managedSoundDirectory: string } = await import(
  new URL(
    import.meta.url.endsWith('.ts')
      ? '../../shared/gameplay-sound-bank.mjs'
      : './gameplay-sound-bank.mjs',
    import.meta.url,
  ).href
);

const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().min(24).max(gameplayAudioLimits.bytes),
    extension: z.literal('wav'),
    durationMs: z.number().positive().max(10000),
    sampleRate: z.number().int().min(8000).max(48000),
    channels: z.number().int().min(1).max(2),
  })
  .strict();
async function installedBanks(root: string) {
  const banks = [['sounds'], [managedSoundDirectory, 'sounds']];
  const present = await Promise.all(
    banks.map((parts) => withDirectory(root, parts, async () => true)),
  );
  return banks.filter((_, i) => present[i]);
}

/** Prefer operator entries and keep descriptor and payload reads on the same precedence rule.
 * A broken override masks that sample until repaired. */
async function readGameplaySound(
  root: string,
  banks: string[][],
  id: string,
  descriptorOnly = false,
) {
  if (!Object.hasOwn(gameplaySoundRegistry.items, id)) return;
  for (const parts of banks) {
    let found = false;
    const result = await withDirectory(root, [...parts, id], async (directory) => {
      found = true;
      return readBankItem(directory, id, descriptorOnly);
    });
    if (found) return result;
  }
}

async function readBankItem(directory: FileHandle, id: string, descriptorOnly: boolean) {
  const metadata = await regularFile(directory, 'manifest.json', 2, 4096);
  if (!metadata) return;
  let descriptor;
  try {
    const version = await fileVersion(metadata);
    descriptor = manifestSchema.parse(
      JSON.parse((await bytesFrom(metadata, (await metadata.stat()).size, 4096)).toString('utf8')),
    );
    if (version !== (await fileVersion(metadata))) return;
  } finally {
    await metadata.close();
  }
  if (descriptor.id !== id) return;
  const file = await regularFile(
    directory,
    `sound.${descriptor.extension}`,
    24,
    gameplayAudioLimits.bytes,
  );
  if (!file) return;
  try {
    const version = await fileVersion(file),
      info = await file.stat();
    if (info.size !== descriptor.bytes) return;
    if (descriptorOnly)
      return { data: Buffer.alloc(0), descriptor: { ...descriptor, mime: 'audio/wav' as const } };
    const data = await bytesFrom(file, info.size, gameplayAudioLimits.bytes),
      sha256 = createHash('sha256').update(data).digest('hex');
    if (sha256 !== descriptor.sha256 || version !== (await fileVersion(file))) return;
    const decoded = inspectGameplayAudio(data);
    if (
      decoded.extension !== descriptor.extension ||
      decoded.sampleRate !== descriptor.sampleRate ||
      decoded.channels !== descriptor.channels ||
      Math.abs(decoded.durationMs - descriptor.durationMs) > 0.01
    )
      return;
    return { data, descriptor: { ...descriptor, mime: decoded.mime } };
  } finally {
    await file.close();
  }
}
export async function gameplaySoundAssetRoutes(
  app: FastifyInstance,
  _dataRoot: string,
  mapsRoot = join(_dataRoot, 'maps'),
) {
  let activePayloads = 0;
  app.get('/api/sound-assets', async () => {
    const items: SharedGameplaySoundCatalog['items'] = {};
    const banks = await installedBanks(mapsRoot);
    let bytes = 0;
    for (const id of Object.keys(gameplaySoundRegistry.items)) {
      const result = await readGameplaySound(mapsRoot, banks, id, true);
      if (!result) continue;
      const d = result.descriptor;
      bytes += d.bytes;
      if (bytes > gameplayAudioLimits.bankBytes) break;
      items[id] = {
        url: `/api/sound-assets/${id}.${d.extension}`,
        sha256: d.sha256,
        bytes: d.bytes,
        durationMs: d.durationMs,
        sampleRate: d.sampleRate,
        channels: d.channels,
        mime: d.mime,
      };
    }
    return { schemaVersion: 1, items } satisfies SharedGameplaySoundCatalog;
  });
  app.get<{ Params: { filename: string } }>(
    '/api/sound-assets/:filename',
    async (request, reply) => {
      const match = /^([a-z0-9-]{1,60})\.(wav)$/.exec(request.params.filename);
      if (activePayloads >= 2) {
        reply.header('retry-after', '2');
        throw new HttpError(429, 'Gameplay sound loading is busy.');
      }
      activePayloads++;
      let result,
        reading = true,
        closed = false,
        released = false;
      const release = () => {
        closed = true;
        if (!reading && !released) {
          released = true;
          activePayloads--;
        }
      };
      reply.raw.once('finish', release);
      reply.raw.once('close', release);
      try {
        result =
          match && (await readGameplaySound(mapsRoot, await installedBanks(mapsRoot), match[1]));
      } catch (error) {
        reading = false;
        release();
        throw error;
      }
      reading = false;
      if (closed || reply.raw.destroyed) release();
      if (!result || result.descriptor.extension !== match![2]) {
        release();
        throw new HttpError(404, 'Gameplay sound is unavailable.');
      }
      reply
        .header('etag', `"${result.descriptor.sha256}"`)
        .header('cache-control', 'private, no-cache');
      return reply.type(result.descriptor.mime).send(result.data);
    },
  );
}
