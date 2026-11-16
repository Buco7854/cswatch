import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'linux') {
  console.warn('Parser sandbox requires Linux. Use Docker for untrusted demos.');
  process.exit(0);
}
mkdirSync(resolve(root, 'dist'), { recursive: true });
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
