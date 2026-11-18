#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
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
