import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeBuildInfo } from './build-info.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(resolve(root, 'dist'), { recursive: true });
writeBuildInfo(resolve(root, 'dist/build-info.json'));
for (const name of [
  'equipment-icons',
  'recorded-equipment',
  'equipment-models',
  'map-previews',
  'gameplay-sounds',
])
  copyFileSync(resolve(root, `../shared/${name}.json`), resolve(root, `dist/${name}.json`));
for (const name of [
  'gameplay-sound-files',
  'gameplay-sound-bank',
  'auth-navigation',
  'passkey-name',
  'roles',
  'smoke-state',
  'inferno-state',
  'stride-distance',
  'aim-track',
  'agent-deaths',
  'agent-gait-history',
  'equipment-key',
  'map-breakables',
  'native-world-format',
])
  copyFileSync(resolve(root, `../shared/${name}.mjs`), resolve(root, `dist/${name}.mjs`));
if (process.platform !== 'linux') {
  console.warn('Parser sandbox requires Linux. Use Docker for untrusted demos.');
  process.exit(0);
}
const result = spawnSync(
  process.env.CC || 'cc',
  [
    '-std=c11',
    '-O2',
    '-Wall',
    '-Wextra',
    '-Werror',
    '-fstack-protector-strong',
    '-D_FORTIFY_SOURCE=2',
    '-Wl,-z,relro,-z,now',
    resolve(root, 'native/parser-sandbox.c'),
    '-o',
    resolve(root, 'dist/parser-sandbox'),
  ],
  { stdio: 'inherit' },
);
if (result.error) console.error('A C compiler is required to build the Linux parser sandbox.');
process.exit(result.status ?? 1);
