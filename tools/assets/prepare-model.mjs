#!/usr/bin/env node
/** Convert a trusted S2V agent export to a self-contained runtime GLB. */
import { parseArgs } from 'node:util';
import { resolve, dirname } from 'node:path';
import { access, mkdir, writeFile, stat } from 'node:fs/promises';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, resample, textureCompress } from '@gltf-transform/functions';
import sharp from 'sharp';
const { values: v } = parseArgs({
  options: { input: { type: 'string' }, output: { type: 'string' } },
});
if (!v.input || !v.output)
  throw new Error(
    'Usage: node prepare-model.mjs --input S2V_AGENT.gltf --output DATA_DIR/maps/agents/ct.glb',
  );
const out = resolve(v.output);
if (await stat(out).catch(() => false)) throw new Error('Refusing to overwrite an existing asset.');
await mkdir(dirname(out), { recursive: true });
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS),
  doc = await io.read(resolve(v.input));
await doc.transform(
  dedup(),
  prune(),
  resample(),
  textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [1024, 1024] }),
);
await io.write(out, doc);
await writeFile(
  out + '.animations.json',
  JSON.stringify(
    doc
      .getRoot()
      .listAnimations()
      .map((a) => a.getName()),
    null,
    2,
  ),
);
console.log('Prepared agent and animation inventory:', out);
