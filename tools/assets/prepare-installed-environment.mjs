#!/usr/bin/env node
/** Private bounded child of the operator installer, never a public API. */
import { constants } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import sharp from 'sharp';
import { regular } from './asset-storage.mjs';
import { prepareEnvironment } from './prepare-environment.mjs';

const { values } = parseArgs({
  options: { config: { type: 'string' }, result: { type: 'string' } },
});
if (!values.config || !values.result)
  throw new Error('Provide a private environment configuration and result file.');
sharp.cache(false);
sharp.concurrency(1);
await regular(values.config, 34 * 1024 ** 2);
const config = JSON.parse(
  await readFile(values.config, {
    encoding: 'utf8',
    flag: constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  }),
);
const result = JSON.stringify(
  await prepareEnvironment({
    ...config,
    onProgress: (stage) => console.error(`Environment preparation: ${stage}`),
  }),
);
if (Buffer.byteLength(result) > 1024 * 1024)
  throw new Error('Environment preparation result exceeds its limit.');
await writeFile(values.result, result, { flag: 'wx', mode: 0o600 });
