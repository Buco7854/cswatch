import { resolve } from 'node:path';
import { steamAssetLimits } from './steam-assets-plan.mjs';

/** Split single-threaded S2V diagnostics by the exact staged input paths. */
export function nativeResourceBatch(text, files) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > steamAssetLimits.logBytes)
    throw new Error('Native resource batch exceeds its bound.');
  const headers = [...text.matchAll(/^\[(\d+)\/(\d+)\] ([^\r\n]+)\r?$/gm)];
  if (headers.length !== files.length)
    throw new Error('Native resource batch did not cover every selected source.');
  const wanted = new Set(files.map((path) => resolve(path))),
    seen = new Set(),
    results = [];
  for (const [index, header] of headers.entries()) {
    const path = resolve(header[3]);
    if (
      Number(header[1]) !== index + 1 ||
      Number(header[2]) !== files.length ||
      !wanted.has(path) ||
      seen.has(path)
    )
      throw new Error('Native resource batch contains an unexpected source.');
    seen.add(path);
    const body = text.slice(
      header.index + header[0].length,
      headers[index + 1]?.index ?? text.length,
    );
    results.push({ path, body });
  }
  return results;
}
