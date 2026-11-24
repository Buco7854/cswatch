#!/usr/bin/env node
/** Trusted operator preparation of a fixed native sound bank. Audio content is never committed. */
import { readFile, writeFile, mkdir, mkdtemp, rm, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { inspectGameplayAudio, gameplayAudioLimits } from '../../shared/gameplay-sound-files.mjs';
import { localDirectory } from './toolchain-security.mjs';
import { regular, checkFreeReserve, exists } from './asset-storage.mjs';
export const gameplaySoundRegistry = JSON.parse(
  await readFile(new URL('../../shared/gameplay-sounds.json', import.meta.url), 'utf8'),
);
export const soundRegistryIds = Object.freeze(Object.keys(gameplaySoundRegistry.items));
if (
  gameplaySoundRegistry.schemaVersion !== 1 ||
  soundRegistryIds.length < 1 ||
  soundRegistryIds.length > gameplayAudioLimits.bankItems ||
  soundRegistryIds.some(
    (id) =>
      !/^[a-z0-9-]{1,60}$/.test(id) ||
      !/^sounds\/[a-z0-9_/-]{1,200}\.vsnd_c$/.test(gameplaySoundRegistry.items[id].source),
  )
)
  throw Error('Invalid fixed native sound registry.');

/** The pinned exporter omits RIFF's final pad for odd-length 8-bit PCM.
 * Repair only that exact container case; the strict shared validator must then
 * accept it. No sample byte, channel, rate or duration is changed. */
export function canonicalizeNativePCM(input) {
  if (!(input instanceof Uint8Array) || input.byteLength > gameplayAudioLimits.bytes)
    throw Error('Native PCM input exceeds its bound.');
  const data = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  try {
    inspectGameplayAudio(data);
    return { data, normalization: 'native-pcm' };
  } catch (original) {
    if (
      data.length < 44 ||
      data.length > gameplayAudioLimits.bytes ||
      data.toString('ascii', 0, 4) !== 'RIFF' ||
      data.toString('ascii', 8, 12) !== 'WAVE' ||
      data.readUInt32LE(4) !== data.length - 8
    )
      throw original;
    let offset = 12,
      chunks = 0;
    while (offset + 8 <= data.length && ++chunks <= 64) {
      const kind = data.toString('ascii', offset, offset + 4),
        size = data.readUInt32LE(offset + 4),
        end = offset + 8 + size;
      if (end > data.length) throw original;
      if (kind === 'data' && size % 2 === 1 && end === data.length) {
        const padded = Buffer.alloc(data.length + 1);
        data.copy(padded);
        padded.writeUInt32LE(padded.length - 8, 4);
        inspectGameplayAudio(padded);
        return { data: padded, normalization: 'riff-tail-padding' };
      }
      offset = end + (size % 2);
    }
    throw original;
  }
}
/** Publish a new complete bank only; existing runtime banks are immutable. Unsupported inputs are reported. */
export async function prepareGameplaySoundBank(
  { input, output, source, networkDeny, items = soundRegistryIds, beforePublish },
  { reserve = checkFreeReserve } = {},
) {
  input = resolve(input);
  output = resolve(output);
  await localDirectory(input);
  await localDirectory(output);
  if (!networkDeny) throw Error('Required atomic sound-bank publication helper is unavailable.');
  await regular(networkDeny, 512 * 1024 ** 2);
  if (
    !source ||
    source.appId !== 730 ||
    source.depotId !== 2347770 ||
    !/^[1-9]\d{0,19}$/.test(source.manifest) ||
    BigInt(source.manifest) > 18446744073709551615n
  )
    throw Error('Provide explicit fixed official source provenance.');
  if (
    !Array.isArray(items) ||
    !items.length ||
    items.length > soundRegistryIds.length ||
    new Set(items).size !== items.length ||
    items.some((id) => !soundRegistryIds.includes(id))
  )
    throw Error('Unknown native sound selection.');
  const target = join(output, 'sounds');
  if (await exists(target)) throw Error('Sound bank exists; prepare into a new output root.');
  const stage = await mkdtemp(join(output, '.sounds-')),
    prepared = [],
    unsupported = [];
  let total = 0;
  try {
    for (const id of items) {
      let found;
      for (const extension of ['wav']) {
        const path = join(input, `${id}.${extension}`);
        if (await exists(path)) {
          if (found) throw Error('Ambiguous exported sound format.');
          await regular(path, gameplayAudioLimits.bytes);
          found = { path, extension };
        }
      }
      if (!found) {
        unsupported.push({ id, reason: 'native-format-unavailable' });
        continue;
      }
      const native = await readFile(found.path);
      let decoded;
      let data, normalization;
      try {
        ({ data, normalization } = canonicalizeNativePCM(native));
        decoded = inspectGameplayAudio(data);
      } catch {
        unsupported.push({ id, reason: 'native-format-unsupported' });
        continue;
      }
      if (decoded.extension !== found.extension)
        throw Error('Native sound format extension mismatch.');
      total += data.length;
      if (total > gameplayAudioLimits.bankBytes) throw Error('Native sound bank exceeds64MiB.');
      await reserve(output, output, data.length + 16384);
      const folder = join(stage, id);
      await mkdir(folder, { mode: 0o755 });
      const sha256 = createHash('sha256').update(data).digest('hex');
      const manifest = {
        schemaVersion: 1,
        id,
        sha256,
        bytes: data.length,
        extension: decoded.extension,
        durationMs: decoded.durationMs,
        sampleRate: decoded.sampleRate,
        channels: decoded.channels,
      };
      await writeFile(join(folder, `sound.${decoded.extension}`), data, {
        flag: 'wx',
        mode: 0o644,
      });
      await writeFile(join(folder, 'manifest.json'), JSON.stringify(manifest) + '\n', {
        flag: 'wx',
        mode: 0o644,
      });
      prepared.push({
        id,
        ...decoded,
        bytes: data.length,
        sha256,
        normalization,
        nativeSha256: createHash('sha256').update(native).digest('hex'),
      });
    }
    if (!prepared.length) throw Error('No supported native sound samples were prepared.');
    const report = {
      schemaVersion: 1,
      source,
      selection: 'fixed-native-representative-samples',
      prepared,
      unsupported,
      bytes: total,
    };
    await writeFile(join(stage, 'provenance.json'), JSON.stringify(report, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o644,
    });
    // The worker accounts the complete staged bank under its prepared-assets
    // budget before publication. A rejection leaves existing assets untouched.
    await beforePublish?.();
    // Only public game artwork is installed here. Keep the bank stage private
    // until complete, then allow a different host/Docker UID to read the result.
    await chmod(stage, 0o755);
    if (await exists(target)) throw Error('Refusing to replace an installed sound bank.');
    const published = spawnSync(networkDeny, ['--publish-sounds', stage, target], {
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 4096,
    });
    if (published.error || published.status !== 0)
      throw Error('Atomic sound bank publication failed without replacement.');
    return { output: target, report };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: {
      input: { type: 'string' },
      output: { type: 'string' },
      manifest: { type: 'string' },
      'network-deny': { type: 'string' },
    },
  });
  if (!values.input || !values.output || !values.manifest)
    throw Error('Usage: --input decoded-native-directory --output NEW-assets-root --manifest PIN');
  console.log(
    JSON.stringify(
      await prepareGameplaySoundBank({
        ...values,
        networkDeny: values['network-deny'],
        source: { appId: 730, depotId: 2347770, manifest: values.manifest },
      }),
    ),
  );
}
