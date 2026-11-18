import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const sandbox = fileURLToPath(new URL('../dist/parser-sandbox', import.meta.url));
const supported =
  process.platform === 'linux' &&
  existsSync(sandbox) &&
  spawnSync(sandbox, ['--check']).status === 0;

test(
  'required confinement permits trusted stderr diagnostics and builtin imports without allowing ioctl',
  {
    skip: !supported && 'Build the required Linux sandbox and use Landlock ABI 3 or newer.',
  },
  () => {
    const root = mkdtempSync(join(tmpdir(), 'cswatch-confined-stdio-'));
    try {
      const code = join(root, 'code'),
        job = join(root, 'job');
      mkdirSync(code);
      mkdirSync(job);
      writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
      const preload = join(code, 'job-stdio.js');
      copyFileSync(fileURLToPath(new URL('../dist/job-stdio.js', import.meta.url)), preload);
      writeFileSync(
        join(code, 'parser.js'),
        `
      import assert from 'node:assert/strict';
      import { writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      assert.equal(process.stderr.fd, 2);
      assert.equal(process.stderr.isTTY, false);
      console.error('confined job stderr probe');
      writeFileSync(join(process.argv[2], 'result.json'), JSON.stringify({ imported: true }));
    `,
      );
      const result = spawnSync(
        sandbox,
        [
          job,
          code,
          fileURLToPath(new URL('../node_modules', import.meta.url)),
          process.execPath,
          '256',
          '2',
          '15',
        ],
        {
          env: {
            HOME: job,
            TMPDIR: job,
            LANG: 'C.UTF-8',
            TZ: 'UTC',
            CSWATCH_PARENT_PID: String(process.pid),
            NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
          },
          stdio: ['ignore', 'ignore', 'pipe'],
          encoding: 'utf8',
          timeout: 20000,
          maxBuffer: 16384,
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr.trim(), 'confined job stderr probe');
      assert.deepEqual(JSON.parse(readFileSync(join(job, 'result.json'), 'utf8')), {
        imported: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
