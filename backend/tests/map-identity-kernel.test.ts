import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('../../', import.meta.url));
const fixture = resolve(process.env.DEMO_FIXTURE || join(root, 'var/fixture/input.dem'));

test(
  'raw recorded map identity survives a required offline kernel sandbox without a full entity/frame parse',
  { skip: !existsSync(fixture) },
  () => {
    const stage = mkdtempSync(join(tmpdir(), 'cswatch-map-header-')),
      code = join(stage, 'code'),
      job = join(stage, 'job');
    try {
      mkdirSync(code);
      mkdirSync(job);
      writeFileSync(join(stage, 'package.json'), '{"type":"module"}');
      copyFileSync(fixture, join(job, 'input.dem'), constants.COPYFILE_FICLONE);
      copyFileSync(join(root, 'backend/dist/job-stdio.js'), join(code, 'job-stdio.js'));
      // The sandbox fixture isolates the production observer. Its only runtime
      // dependency is the same installed Zod package, allowed read-only by the kernel.
      const observer = readFileSync(join(root, 'backend/dist/map-identity.js'), 'utf8').replace(
        "from 'zod'",
        `from ${JSON.stringify(pathToFileURL(join(root, 'backend/node_modules/zod/index.js')).href)}`,
      );
      writeFileSync(join(code, 'map-identity.js'), observer);
      writeFileSync(
        join(code, 'parser.js'),
        `
 import {DemoReader,EntityMode} from ${JSON.stringify(pathToFileURL(join(root, 'backend/node_modules/cs2parser/dist/index.mjs')).href)};
 import {observeMapIdentity} from './map-identity.js';
 import {writeFileSync} from 'node:fs';
 import {join} from 'node:path';
 const reader=new DemoReader(),finish=observeMapIdentity(reader);
 reader.on('serverinfo',()=>reader.cancel());
 const result=await reader.parseDemo(join(process.argv[2],'input.dem'),{entities:EntityMode.NONE});
 writeFileSync(join(process.argv[2],'identity.json'),JSON.stringify({identity:finish(),status:result.status}));
 `,
      );
      const result = spawnSync(
        join(root, 'backend/dist/parser-sandbox'),
        [job, code, join(root, 'backend/node_modules'), process.execPath, '512', '128', '20'],
        {
          cwd: job,
          encoding: 'utf8',
          timeout: 25000,
          maxBuffer: 8192,
          env: {
            NODE_OPTIONS: '--import=' + pathToFileURL(join(code, 'job-stdio.js')).href,
            HOME: job,
            TMPDIR: job,
            UV_THREADPOOL_SIZE: '2',
            RAYON_NUM_THREADS: '2',
            TZ: 'UTC',
            LANG: 'C.UTF-8',
            CSWATCH_PARENT_PID: String(process.pid),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr.slice(0, 1000));
      const report = JSON.parse(readFileSync(join(job, 'identity.json'), 'utf8'));
      assert.deepEqual(report.identity, {
        map: 'de_mirage',
        buildNum: 9842,
        patchVersion: 13984,
        demoVersionGuid: '8e9d71ab-04a1-4c01-bb61-acfede27c046',
        addonPresence: 'none',
      });
      assert.equal(report.status, 'cancelled');
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  },
);
