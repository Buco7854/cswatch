#!/usr/bin/env node
/** Read-only operator diagnostics. Never parses demos or creates source approvals. */
import { resolve, basename, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { diagnoseMapIdentity, mapCatalogLimits } from '../../backend/dist/map-catalog.js';
import {
  bytesFrom,
  fileVersion,
  regularFile,
  withDirectory,
} from '../../backend/dist/map-asset-files.js';

export const inspectionLimits = Object.freeze({
  replayBytes: 16 * 1024 ** 2,
  reportBytes: 512 * 1024,
});
const json = (bytes) => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));

async function fileJSON(filename, maximum, control = false) {
  if (typeof filename !== 'string' || !filename || filename.length > 4096)
    throw Error('Provide a bounded local JSON filename.');
  const path = resolve(filename);
  const value = await withDirectory(
    '/',
    dirname(path).split('/').filter(Boolean),
    async (directory) => {
      const file = await regularFile(directory, basename(path), 2, maximum);
      if (!file) return;
      try {
        const before = await fileVersion(file),
          info = await file.stat();
        if (control && info.mode & 0o022)
          throw Error('Catalog control must not be writable by other users.');
        const bytes = await bytesFrom(file, info.size, maximum);
        if (before !== (await fileVersion(file))) throw Error('Input changed during inspection.');
        return json(bytes);
      } finally {
        await file.close();
      }
    },
  );
  if (value === undefined)
    throw Error('JSON input is missing, invalid, linked or outside its byte bound.');
  return value;
}

async function stdinJSON(input) {
  const chunks = [];
  let length = 0;
  for await (const chunk of input) {
    const size = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk?.byteLength;
    if (!Number.isSafeInteger(size) || size < 0 || size > inspectionLimits.replayBytes - length)
      throw Error('Replay metadata exceeds its byte bound.');
    const bytes =
      typeof chunk === 'string'
        ? Buffer.from(chunk)
        : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    chunks.push(bytes);
    length += bytes.length;
  }
  if (length < 2) throw Error('Provide a complete version 2 replay manifest.');
  return json(Buffer.concat(chunks, length));
}

/** The replay must already have passed normal ingestion validation. This tool
 * deliberately projects only map evidence, even if the input contains private
 * actor names, account identifiers, communications or local provenance. */
export async function inspectMapIdentity({ replay, catalog, input = process.stdin } = {}) {
  const manifest =
    replay === undefined
      ? await stdinJSON(input)
      : await fileJSON(replay, inspectionLimits.replayBytes);
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    Array.isArray(manifest) ||
    manifest.version !== 2 ||
    typeof manifest.map !== 'string' ||
    !/^[A-Za-z0-9_-]{1,80}$/.test(manifest.map)
  )
    throw Error('Inspect only a validated version 2 replay manifest.');
  const approvals =
    catalog === undefined ? undefined : await fileJSON(catalog, mapCatalogLimits.bytes, true);
  const result = diagnoseMapIdentity(manifest.mapIdentity, approvals, manifest.map);
  // No name normalization, Steam lookup or map-version inference is performed.
  const report = { ...result, recordedMap: manifest.map };
  if (Buffer.byteLength(JSON.stringify(report, null, 2)) > inspectionLimits.reportBytes)
    throw Error('Map inspection report exceeds its byte bound.');
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({
      options: {
        replay: { type: 'string' },
        catalog: { type: 'string' },
        help: { type: 'boolean' },
      },
    });
    if (values.help)
      console.log(
        'Usage: node tools/assets/inspect-map-identity.mjs [--replay /local/validated/manifest.json] [--catalog /local/catalog.json]\nWithout --replay, reads bounded replay metadata from stdin. Read-only diagnostics, no demo parsing, network requests or source approvals.',
      );
    else console.log(JSON.stringify(await inspectMapIdentity(values), null, 2));
  } catch {
    console.error(
      'Map identity inspection refused. Use --help and a bounded local version 2 replay manifest or stdin.',
    );
    process.exitCode = 1;
  }
}
