#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
const previewRegistry = JSON.parse(
  readFileSync(new URL('../../shared/map-previews.json', import.meta.url), 'utf8'),
);
if (
  previewRegistry.schemaVersion !== 1 ||
  !Array.isArray(previewRegistry.maps) ||
  !previewRegistry.maps.length ||
  previewRegistry.maps.length > 8 ||
  new Set(previewRegistry.maps).size !== previewRegistry.maps.length ||
  previewRegistry.maps.some(
    (name) => typeof name !== 'string' || !/^de_[a-z0-9_]{1,76}$/.test(name),
  )
)
  throw Error('Invalid fixed preview publication registry.');
const previewNames = previewRegistry.maps.map((name) => JSON.stringify(name)).join(',');
const modelRegistry = JSON.parse(
  readFileSync(new URL('../../shared/equipment-models.json', import.meta.url), 'utf8'),
);
const equipmentNames = Object.keys(modelRegistry.items || {});
if (
  modelRegistry.schemaVersion !== 1 ||
  !equipmentNames.length ||
  equipmentNames.length > 96 ||
  equipmentNames.some((name) => !/^[a-z0-9]{1,40}$/.test(name))
)
  throw Error('Invalid fixed equipment publication registry.');
const source = fileURLToPath(new URL('./native/asset-network-deny.c', import.meta.url));
export function buildNetworkDeny(output) {
  if (process.platform !== 'linux' || process.arch !== 'x64')
    throw Error('Asset conversion boundary requires Linux x86-64.');
  const target = resolve(output),
    temporary = target + '.' + randomBytes(8).toString('hex') + '.tmp';
  if (existsSync(target)) throw Error('Refusing to overwrite asset conversion boundary.');
  mkdirSync(dirname(target), { recursive: true });
  try {
    const result = spawnSync(
      'cc',
      [
        '-std=c11',
        `-DCSWATCH_PREVIEW_NAMES=${previewNames}`,
        `-DCSWATCH_EQUIPMENT_NAMES=${equipmentNames.map((name) => JSON.stringify(name)).join(',')}`,
        '-O2',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-fstack-protector-strong',
        '-D_FORTIFY_SOURCE=2',
        '-Wl,-z,relro,-z,now',
        source,
        '-o',
        temporary,
      ],
      { encoding: 'utf8', timeout: 30000, maxBuffer: 32768 },
    );
    if (result.error || result.status !== 0)
      throw Error(
        'A Linux x86-64 C compiler and libc headers are required for asset conversion confinement.',
      );
    const checked = spawnSync(temporary, ['--check'], {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 4096,
    });
    if (checked.error || checked.status !== 0)
      throw Error('Required asset conversion Landlock/seccomp is unavailable.');
    chmodSync(temporary, 0o755);
    renameSync(temporary, target);
    return target;
  } finally {
    rmSync(temporary, { force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 4 || process.argv[2] !== '--output')
    throw Error('Usage: node tools/assets/build-network-deny.mjs --output /absolute/new/binary');
  console.log(buildNetworkDeny(process.argv[3]));
}
