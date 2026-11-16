#!/usr/bin/env node
/** Trusted operator-only S2V pipeline. Never runs on uploaded demos or public requests. */
import { parseArgs } from 'node:util';
import { resolve, join, dirname, basename } from 'node:path';
import { mkdir, readFile, writeFile, stat, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, weld, resample, textureCompress, simplify } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
const { values: v } = parseArgs({
  options: {
    s2v: { type: 'string' },
    game: { type: 'string' },
    map: { type: 'string' },
    input: { type: 'string' },
    output: { type: 'string' },
    'asset-version': { type: 'string' },
    help: { type: 'boolean' },
  },
});
if (v.help || !v.output || !v.map || (!v.input && (!v.game || !v.s2v))) {
  console.log(
    'Usage: npm run prepare-map -- --map de_mirage --output ../../var/maps --s2v /path/Source2Viewer-CLI --game /path/CS2/game/csgo --asset-version BUILD\nOr: --input /path/export.gltf (existing S2V glTF export)',
  );
  process.exit(v.help ? 0 : 1);
}
if (!/^[a-zA-Z0-9_-]{1,80}$/.test(v.map)) throw new Error('Invalid map name');
const root = resolve(v.output, v.map);
await mkdir(root, { recursive: true });
let input = v.input ? resolve(v.input) : join(root, 'source', 'scene.gltf');
let toolVersion = 'operator-export';
if (!v.input) {
  await access(resolve(v.s2v));
  const version = spawnSync(resolve(v.s2v), ['--version'], { encoding: 'utf8', timeout: 30000 });
  if (version.status !== 0) throw new Error('S2V executable is unavailable');
  toolVersion = version.stdout.trim();
  await mkdir(dirname(input), { recursive: true });
  const result = spawnSync(
    resolve(v.s2v),
    [
      '--input',
      join(resolve(v.game), 'maps', v.map + '.vpk'),
      '--game',
      resolve(v.game),
      '--vpk_filepath',
      `maps/${v.map}.vmap_c`,
      '--output',
      input,
      '--gltf_export_format',
      'gltf',
      '--gltf_textures_adapt',
    ],
    { stdio: 'inherit', timeout: 30 * 60 * 1000 },
  );
  if (result.status !== 0)
    throw new Error(
      'S2V export failed. Check your S2V version, installed map, and game search paths.',
    );
}
const inputBytes = await readFile(input);
const hash = createHash('sha256').update(inputBytes).digest('hex');
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
await MeshoptSimplifier.ready;
for (const tier of ['desktop', 'mobile']) {
  const target = join(root, tier);
  await mkdir(target, { recursive: true });
  if (await stat(join(target, 'scene.glb')).catch(() => false))
    throw new Error(
      `Output already exists: ${target}. Use a new asset directory/version; do not overwrite live assets.`,
    );
  const document = await io.read(input);
  await document.transform(dedup(), prune(), resample(), weld());
  if (tier === 'mobile')
    await document.transform(
      simplify({ simplifier: MeshoptSimplifier, ratio: 0.65, error: 0.005 }),
    );
  await document.transform(
    textureCompress({
      encoder: sharp,
      targetFormat: 'webp',
      resize: tier === 'mobile' ? [1024, 1024] : [2048, 2048],
    }),
  );
  await io.write(join(target, 'scene.glb'), document);
  const size = (await stat(join(target, 'scene.glb'))).size;
  await writeFile(
    join(target, 'manifest.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        map: v.map,
        tier,
        bytes: size,
        sourceFile: basename(input),
        sourceSha256: hash,
        s2v: toolVersion,
        assetVersion: v['asset-version'] || 'unspecified',
        coordinateSystem: 'S2V glTF meters Y-up; viewer rotates +90deg about Y',
        preparedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log(`${tier}: ${(size / 1024 ** 2).toFixed(1)} MB`);
}
console.log(
  'Prepared map. Install the resulting map directory into DATA_DIR/maps. Source exports may be removed after archiving.',
);
