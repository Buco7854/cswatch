#!/usr/bin/env node
/** Private operator child, protected by installer storage/time/process guards. */
import { constants } from 'node:fs';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { regular } from './asset-storage.mjs';
import { prepareAtmosphericMaterial, patchAtmosphericGlb } from './prepare-atmosphere.mjs';

const { values } = parseArgs({
  options: { config: { type: 'string' }, result: { type: 'string' } },
});
if (!values.config || !values.result)
  throw new Error('Provide a private atmosphere configuration and result file.');
await regular(values.config, 1024 * 1024);
const config = JSON.parse(
  await readFile(values.config, {
    encoding: 'utf8',
    flag: constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  }),
);
if (!Array.isArray(config.jobs) || !config.jobs.length || config.jobs.length > 16)
  throw new Error('Invalid bounded atmosphere job list.');
const reports = [];
let input = config.input;
for (const [index, job] of config.jobs.entries()) {
  const baked = await prepareAtmosphericMaterial(job);
  const output =
    index === config.jobs.length - 1
      ? config.output
      : join(config.stage, `atmosphere-patch-${index}.glb`);
  const patched = await patchAtmosphericGlb({
    input,
    output,
    materialName: job.material.Name,
    imagePath: baked.imagePath,
    textureScale: baked.textureScale,
  });
  reports.push({ bake: baked.report, patch: patched.report });
  if (index > 0 && resolve(input).startsWith(resolve(config.stage) + '/atmosphere-patch-'))
    await unlink(input);
  input = patched.path;
}
const result = JSON.stringify({
  path: input,
  report: {
    materials: reports,
    approximation:
      'Static phase0 opacity masks; native panning, Fresnel and depth feather are not reconstructed.',
  },
});
if (Buffer.byteLength(result) > 1024 * 1024)
  throw new Error('Atmosphere result exceeds its bound.');
await writeFile(values.result, result, { flag: 'wx', mode: 0o600 });
