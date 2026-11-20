#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { link, mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import viewmodels from '../../shared/viewmodels.json' with { type: 'json' };
import { readableDirectory } from './asset-storage.mjs';
import { localDirectory, regularFile } from './toolchain-security.mjs';

async function pinnedBytes(path, pin) {
  await localDirectory(resolve(path, '..'));
  const { handle, stat } = await regularFile(path, pin.bytes);
  try {
    if (stat.size !== pin.bytes) throw Error('The input does not match the pinned viewmodel.');
    const data = await handle.readFile();
    if (data.length !== pin.bytes || createHash('sha256').update(data).digest('hex') !== pin.sha256)
      throw Error('The input does not match the pinned viewmodel.');
    return data;
  } finally {
    await handle.close();
  }
}
export async function installViewmodel({ equipment, input, maps }) {
  if (!Object.hasOwn(viewmodels, equipment)) throw Error('Unsupported fixed first-person model.');
  const pin = viewmodels[equipment];
  const data = await pinnedBytes(resolve(input), pin);
  const root = resolve(maps);
  await localDirectory(root);
  const directory = join(root, 'viewmodels', equipment);
  await readableDirectory(directory);
  const stage = await mkdtemp(join(directory, '.stage-'));
  const staged = join(stage, 'viewmodel.glb');
  const target = join(directory, pin.sha256 + '.glb');
  try {
    await writeFile(staged, data, { flag: 'wx', mode: 0o644 });
    try {
      await link(staged, target);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await pinnedBytes(target, pin);
    }
  } finally {
    await unlink(staged).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    await rmdir(stage);
  }
  console.log(
    'Installed the verified ' + equipment + ' viewmodel from Steam manifest ' + pin.sourceManifest,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [equipment, input, maps, ...extra] = process.argv.slice(2);
  if (!equipment || !input || !maps || extra.length)
    throw Error(
      'Usage: node tools/assets/install-viewmodel.mjs <equipment> <verified GLB> <MAP_ASSETS_DIR>',
    );
  await installViewmodel({ equipment, input, maps });
}
