import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store, now } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { reserve } from '../src/ingestion.js';
import { processOne, housekeeping } from '../src/worker.js';
import { validateReplayArtifacts, writeReplay } from '../src/replay.js';
import { inspectParserScratch } from '../src/parser-job.js';

const sandbox = resolve('dist/parser-sandbox');
const fixture = resolve(process.env.DEMO_FIXTURE || '../var/fixture/input.dem');
const supported = process.platform === 'linux' && existsSync(sandbox);

test(
  'sandbox binds the explicitly expected worker parent and rejects missing or changed parents',
  { skip: !supported },
  () => {
    const folder = mkdtempSync(join(tmpdir(), 'cswatch-parent-binding-'));
    try {
      const args = [
        folder,
        resolve('dist'),
        resolve('node_modules'),
        process.execPath,
        '256',
        '2',
        '15',
      ];
      const env = { HOME: folder, TMPDIR: folder, TZ: 'UTC', LANG: 'C.UTF-8' };
      const missing = spawnSync(sandbox, args, { env, encoding: 'utf8' });
      assert.equal(missing.status, 125);
      assert.match(missing.stderr, /missing expected worker parent/);
      const changed = spawnSync(sandbox, args, {
        env: { ...env, CSWATCH_PARENT_PID: String(process.pid === 1 ? 2 : 1) },
        encoding: 'utf8',
      });
      assert.equal(changed.status, 125);
      assert.match(changed.stderr, /worker parent changed/);
      // In particular, expected PID 1 is valid configuration; comparison, not a blanket
      // orphan check, decides whether it matches. The hardened Docker smoke exercises PID 1.
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  },
);

test(
  'native sandbox blocks readonly-file ioctls, asynchronous signal ownership and leases',
  { skip: !supported },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'cswatch-native-control-'));
    try {
      const code = join(dir, 'code'),
        job = join(dir, 'job'),
        model = join(dir, 'model');
      for (const folder of [code, job, model]) mkdirSync(folder, { mode: 0o700 });
      writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
      writeFileSync(join(model, 'weights'), 'test-model-data');
      const source = join(code, 'probe.c'),
        program = join(code, 'probe');
      writeFileSync(
        source,
        `
      #define _GNU_SOURCE
      #include <errno.h>
      #include <fcntl.h>
      #include <linux/fs.h>
      #include <stdio.h>
      #include <stdlib.h>
      #include <sys/ioctl.h>
      #include <unistd.h>
      int main(void) {
        int fd = open(getenv("CSWATCH_TEST_MODEL_FILE"), O_RDONLY);
        if (fd < 0) return 2;
        int flags = 0, count = 0;
        errno = 0; int get = ioctl(fd, FS_IOC_GETFLAGS, &flags), get_error = get < 0 ? errno : 0;
        /* A no-op using existing flags; no persistent metadata change in the control. */
        errno = 0; int set = ioctl(fd, FS_IOC_SETFLAGS, &flags), set_error = set < 0 ? errno : 0;
        errno = 0; int read = ioctl(fd, FIONREAD, &count), read_error = read < 0 ? errno : 0;
        int owner_pipe[2], async_pipe[2];
        if (pipe(owner_pipe) || pipe(async_pipe)) return 3;
        /* Never combine a parent owner with O_ASYNC: the probe sends no signals. */
        errno = 0; int owner = fcntl(owner_pipe[0], F_SETOWN, getppid()), owner_error = owner < 0 ? errno : 0;
        int previous = fcntl(async_pipe[0], F_GETFL);
        errno = 0; int async = fcntl(async_pipe[0], F_SETFL, previous | O_ASYNC), async_error = async < 0 ? errno : 0;
        if (async == 0) fcntl(async_pipe[0], F_SETFL, previous);
        errno = 0; int lease = fcntl(fd, F_SETLEASE, F_RDLCK), lease_error = lease < 0 ? errno : 0;
        close(owner_pipe[0]); close(owner_pipe[1]); close(async_pipe[0]); close(async_pipe[1]); close(fd);
        FILE *output = fopen("result.json", "w");
        if (!output) return 4;
        fprintf(output, "{\\"get\\":%d,\\"set\\":%d,\\"read\\":%d,\\"owner\\":%d,\\"async\\":%d,\\"lease\\":%d}", get_error, set_error, read_error, owner_error, async_error, lease_error);
        return fclose(output) != 0;
      }
    `,
      );
      const compile = spawnSync(
        process.env.CC || 'cc',
        ['-std=c11', '-Wall', '-Wextra', '-Werror', source, '-o', program],
        { encoding: 'utf8' },
      );
      assert.equal(compile.status, 0, compile.stderr);
      const env = {
        HOME: job,
        TMPDIR: job,
        TZ: 'UTC',
        LANG: 'C.UTF-8',
        CSWATCH_PARENT_PID: String(process.pid),
        CSWATCH_TEST_MODEL_FILE: join(model, 'weights'),
      };
      const control = spawnSync(program, [], { cwd: job, env, encoding: 'utf8', timeout: 10000 });
      assert.equal(control.status, 0, control.stderr);
      const baseline = JSON.parse(readFileSync(join(job, 'result.json'), 'utf8'));
      assert.equal(baseline.read, 0);
      assert.equal(baseline.owner, 0);
      assert.equal(baseline.async, 0);
      const confined = spawnSync(
        sandbox,
        [
          job,
          code,
          resolve('node_modules'),
          program,
          '256',
          '2',
          '15',
          'transcription-job.js',
          model,
        ],
        { cwd: job, env, encoding: 'utf8', timeout: 20000 },
      );
      assert.equal(confined.status, 0, confined.stderr);
      assert.deepEqual(JSON.parse(readFileSync(join(job, 'result.json'), 'utf8')), {
        get: 1,
        set: 1,
        read: 1,
        owner: 1,
        async: 1,
        lease: 1,
      });
      assert.equal(readFileSync(join(model, 'weights'), 'utf8'), 'test-model-data');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  'transcription sandbox grants model reads while denying model changes and unrelated private files',
  { skip: !supported },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'cswatch-model-sandbox-'));
    try {
      const code = join(dir, 'code'),
        job = join(dir, 'job'),
        model = join(dir, 'model');
      for (const folder of [code, job, model]) mkdirSync(folder, { mode: 0o700 });
      writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
      writeFileSync(join(model, 'weights'), 'test-model-data');
      const privateFile = join(dir, 'private-db');
      writeFileSync(privateFile, 'private-data');
      writeFileSync(
        join(code, 'transcription-job.js'),
        `import fs from 'node:fs';const model=${JSON.stringify(model)},secret=${JSON.stringify(privateFile)};const denied=(fn)=>{try{fn();return false;}catch(error){return ['EPERM','EACCES'].includes(error.code);}};fs.writeFileSync(process.argv[2]+'/result.json',JSON.stringify({model:fs.readFileSync(model+'/weights','utf8'),write:denied(()=>fs.writeFileSync(model+'/weights','changed')),create:denied(()=>fs.writeFileSync(model+'/new-file','changed')),private:denied(()=>fs.readFileSync(secret)),argc:process.argv.length}));`,
      );
      const result = spawnSync(
        sandbox,
        [
          job,
          code,
          resolve('node_modules'),
          process.execPath,
          '256',
          '2',
          '15',
          'transcription-job.js',
          model,
        ],
        {
          encoding: 'utf8',
          env: {
            HOME: job,
            TMPDIR: job,
            TZ: 'UTC',
            LANG: 'C.UTF-8',
            CSWATCH_PARENT_PID: String(process.pid),
          },
          timeout: 20000,
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(readFileSync(join(job, 'result.json'), 'utf8')), {
        model: 'test-model-data',
        write: true,
        create: true,
        private: true,
        argc: 3,
      });
      assert.equal(readFileSync(join(model, 'weights'), 'utf8'), 'test-model-data');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  'kernel sandbox denies other demos, database, metadata writes, network, signals and subprocesses',
  { skip: !supported },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'cswatch-sandbox-'));
    try {
      const code = join(dir, 'code'),
        job = join(dir, 'job'),
        other = join(dir, 'private');
      for (const folder of [code, job, other]) mkdirSync(folder, { mode: 0o700 });
      writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
      const secret = join(other, 'replay.db');
      writeFileSync(secret, 'private-token');
      writeFileSync(
        join(code, 'parser.js'),
        `
      import fs from 'node:fs';
      import net from 'node:net';
      import { spawnSync } from 'node:child_process';
      const denied = (fn) => { try { fn(); return false; } catch (error) { return ['EACCES','EPERM'].includes(error.code); } };
      const secret = ${JSON.stringify(secret)}, job = process.argv[2];
      const result = {
        read: denied(() => fs.readFileSync(secret)),
        write: denied(() => fs.writeFileSync(secret, 'changed')),
        chmod: denied(() => fs.chmodSync(secret, 0o777)),
        symlink: denied(() => fs.symlinkSync(secret, job + '/escape')),
        signal: denied(() => process.kill(${process.pid}, 0)),
        spawn: Boolean(spawnSync(process.execPath, ['-e', 'process.exit(0)']).error),
        secretEnv: process.env.CSWATCH_TEST_SECRET === undefined,
      };
      result.network = await new Promise((resolve) => { const socket = net.connect({ host: '127.0.0.1', port: 1 }); socket.on('error', (error) => resolve(error.code === 'EPERM')); socket.on('connect', () => { socket.destroy(); resolve(false); }); });
      fs.writeFileSync(job + '/result.json', JSON.stringify(result));
    `,
      );
      const result = spawnSync(
        sandbox,
        [job, code, resolve('node_modules'), process.execPath, '256', '16', '15'],
        {
          encoding: 'utf8',
          env: {
            HOME: job,
            TMPDIR: job,
            TZ: 'UTC',
            LANG: 'C.UTF-8',
            CSWATCH_PARENT_PID: String(process.pid),
          },
          timeout: 20000,
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(readFileSync(join(job, 'result.json'), 'utf8')), {
        read: true,
        write: true,
        chmod: true,
        symlink: true,
        signal: true,
        spawn: true,
        secretEnv: true,
        network: true,
      });
      assert.equal(readFileSync(secret, 'utf8'), 'private-token');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  'durable worker parses a real demo through the required kernel sandbox and publishes only validated chunks',
  { skip: !supported || !existsSync(fixture) },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cswatch-worker-'));
    const config = loadConfig({
      APP_URL: 'http://localhost:8000',
      COOKIE_SECURE: 'false',
      DATA_DIR: dir,
      MAX_UPLOAD_MB: '64',
      PARSER_TIMEOUT_SECONDS: '120',
    });
    const db = new Store(dir);
    try {
      db.run(
        'INSERT INTO users(id,username,password_hash,role,created_at) VALUES(?,?,?,?,?)',
        'sandbox-user',
        'sandbox-user',
        null,
        'member',
        now(),
      );
      const demo = reserve(db, config, 'sandbox-user', 'fixture.dem', 'upload');
      copyFileSync(fixture, join(demo.folder, 'input.dem'));
      db.run("UPDATE demos SET status='queued' WHERE id=?", demo.id);
      assert.equal(await processOne(db, config), true);
      const row = db.one('SELECT * FROM demos WHERE id=?', demo.id)!;
      assert.equal(row.status, 'ready', row.error);
      const output = validateReplayArtifacts(demo.folder);
      assert.equal(output.manifest.map, 'de_mirage');
      assert.equal(JSON.parse(row.metadata).replayVersion, 3);
      assert.equal(existsSync(join(demo.folder, 'expanded.dem')), false);
      assert.equal(existsSync(join(demo.folder, 'summary.json')), false);
      assert.equal(await processOne(db, config), false);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test('required sandbox mode fails a queued job safely when the launcher is missing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cswatch-no-sandbox-'));
  const config = loadConfig({
    APP_URL: 'http://localhost:8000',
    COOKIE_SECURE: 'false',
    DATA_DIR: dir,
    PARSER_SANDBOX_BINARY: join(dir, 'not-installed'),
  });
  const db = new Store(dir);
  try {
    db.run(
      'INSERT INTO users(id,username,password_hash,role,created_at) VALUES(?,?,?,?,?)',
      'safe-user',
      'safe-user',
      null,
      'member',
      now(),
    );
    const demo = reserve(db, config, 'safe-user', 'fixture.dem', 'upload');
    writeFileSync(join(demo.folder, 'input.dem'), Buffer.from('PBDEMS2\0'));
    db.run("UPDATE demos SET status='queued' WHERE id=?", demo.id);
    await processOne(db, config);
    assert.equal(db.one('SELECT status FROM demos WHERE id=?', demo.id)?.status, 'failed');
    assert.match(
      db.one('SELECT error FROM demos WHERE id=?', demo.id)?.error,
      /\[sandbox_unavailable\]/,
    );
    assert.equal(existsSync(join(demo.folder, 'manifest.json.gz')), false);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function workerState(
  overrides: Record<string, string> = {},
  runnerBody = 'setInterval(() => {}, 1000);',
) {
  const dir = mkdtempSync(join(tmpdir(), 'cswatch-job-state-'));
  const runner = join(dir, 'test-runner.cjs');
  writeFileSync(runner, `#!${process.execPath}\n${runnerBody}`, { mode: 0o700 });
  const config = loadConfig({
    APP_URL: 'http://localhost:8000',
    COOKIE_SECURE: 'false',
    DATA_DIR: dir,
    MAX_UPLOAD_MB: '1',
    PARSER_SANDBOX_BINARY: runner,
    ...overrides,
  });
  const db = new Store(dir);
  db.run(
    'INSERT INTO users(id,username,password_hash,role,created_at) VALUES(?,?,?,?,?)',
    'queue-user',
    'queue-user',
    null,
    'member',
    now(),
  );
  const demo = reserve(db, config, 'queue-user', 'fixture.dem', 'upload');
  writeFileSync(join(demo.folder, 'input.dem'), Buffer.from('PBDEMS2\0'));
  db.run("UPDATE demos SET status='queued',size=8 WHERE id=?", demo.id);
  return {
    dir,
    config,
    db,
    demo,
    close() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function preparedRunner(state: ReturnType<typeof workerState>, sample = false) {
  const template = join(state.dir, 'template');
  mkdirSync(template);
  await writeReplay(template, {
    map: 'training',
    tickRate: 64,
    sample,
    players: [{ id: '76561198000000001', name: 'Test', team: 2 }],
    rounds: [{ number: 1, tick: 0 }],
    events: [],
    frames: [
      {
        tick: 0,
        players: [
          {
            id: '76561198000000001',
            x: 0,
            y: 0,
            z: 0,
            yaw: 0,
            pitch: 0,
            health: 100,
            team: 2,
            alive: true,
            weapon: 'ak47',
          },
        ],
      },
    ],
  });
  writeFileSync(
    state.config.parserSandboxBinary,
    `#!${process.execPath}\nconst { cpSync } = require('node:fs'); cpSync(${JSON.stringify(template)}, process.argv[2], { recursive: true });`,
    { mode: 0o700 },
  );
}

test('deleting a processing demo cancels the child and removes disposable scratch', async () => {
  const state = workerState();
  try {
    const work = processOne(state.db, state.config);
    setTimeout(() => state.db.run('DELETE FROM demos WHERE id=?', state.demo.id), 40);
    await work;
    assert.equal(state.db.one('SELECT id FROM demos WHERE id=?', state.demo.id), undefined);
    assert.deepEqual(readdirSync(join(state.dir, 'jobs')), []);
    assert.equal(existsSync(join(state.demo.folder, 'manifest.json.gz')), false);
  } finally {
    state.close();
  }
});

test('a parser exceeding its wall-clock budget fails without publishing output', async () => {
  const state = workerState({ PARSER_TIMEOUT_SECONDS: '1' });
  try {
    const start = Date.now();
    await processOne(state.db, state.config);
    assert.ok(Date.now() - start < 5000);
    assert.equal(
      state.db.one('SELECT status FROM demos WHERE id=?', state.demo.id)?.status,
      'failed',
    );
    assert.deepEqual(readdirSync(join(state.dir, 'jobs')), []);
  } finally {
    state.close();
  }
});

test('database publication failure rolls back metadata and removes already-promoted artifacts', async () => {
  const state = workerState();
  try {
    await preparedRunner(state);
    state.db.db.exec(
      "CREATE TRIGGER test_fail_publish BEFORE UPDATE OF status ON demos WHEN new.status='ready' BEGIN SELECT RAISE(ABORT,'simulated publication failure'); END;",
    );
    await processOne(state.db, state.config);
    assert.equal(
      state.db.one('SELECT status FROM demos WHERE id=?', state.demo.id)?.status,
      'failed',
    );
    assert.equal(existsSync(join(state.demo.folder, 'manifest.json.gz')), false);
    assert.equal(existsSync(join(state.demo.folder, 'chunks')), false);
    assert.deepEqual(readdirSync(state.demo.folder), ['input.dem']);
  } finally {
    state.close();
  }
});

test('prepared output must fit storage quotas atomically before becoming ready', async () => {
  const state = workerState({ USER_STORAGE_MB: '1' });
  try {
    await preparedRunner(state);
    state.db.run('UPDATE demos SET size=? WHERE id=?', 1024 ** 2 - 1, state.demo.id);
    await processOne(state.db, state.config);
    assert.equal(
      state.db.one('SELECT status FROM demos WHERE id=?', state.demo.id)?.status,
      'failed',
    );
    assert.equal(existsSync(join(state.demo.folder, 'chunks')), false);
  } finally {
    state.close();
  }
});

test('native output cannot disguise an uploaded demo as the synthetic training sample', async () => {
  const state = workerState();
  try {
    await preparedRunner(state, true);
    await processOne(state.db, state.config);
    assert.equal(
      state.db.one('SELECT status FROM demos WHERE id=?', state.demo.id)?.status,
      'failed',
    );
    assert.equal(existsSync(join(state.demo.folder, 'manifest.json.gz')), false);
  } finally {
    state.close();
  }
});

test('scratch inspection rejects unexpected files, symlinks and oversized originals', () => {
  const state = workerState();
  try {
    inspectParserScratch(state.demo.folder, state.config);
    writeFileSync(join(state.demo.folder, 'unexpected'), 'x');
    assert.throws(
      () => inspectParserScratch(state.demo.folder, state.config),
      /unexpected artifact/,
    );
    rmSync(join(state.demo.folder, 'unexpected'));
    symlinkSync(join(state.dir, 'replay.db'), join(state.demo.folder, 'summary.json'));
    assert.throws(() => inspectParserScratch(state.demo.folder, state.config), /invalid artifact/);
    rmSync(join(state.demo.folder, 'summary.json'));
    writeFileSync(join(state.demo.folder, 'input.dem'), Buffer.alloc(1024 ** 2 + 1));
    assert.throws(() => inspectParserScratch(state.demo.folder, state.config), /storage limit/);
  } finally {
    state.close();
  }
});

test('housekeeping removes stale orphan scratch without following directory symlinks or live jobs', () => {
  const state = workerState();
  try {
    const jobs = join(state.dir, 'jobs');
    mkdirSync(jobs);
    const old = join(jobs, 'a'.repeat(32) + '-abcdef'),
      live = join(jobs, 'b'.repeat(32) + '-abcdef');
    mkdirSync(old);
    mkdirSync(live);
    symlinkSync(state.demo.folder, join(jobs, 'c'.repeat(32) + '-abcdef'));
    utimesSync(old, 1, 1);
    housekeeping(state.db, state.config);
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(live), true);
    assert.equal(existsSync(join(state.demo.folder, 'input.dem')), true);
  } finally {
    state.close();
  }
});

test('worker failures report the sandbox reason and signal without logging raw child output', async () => {
  const state = workerState(
    {},
    `process.stderr.write('cswatch parser sandbox: Landlock ABI 3 or newer required (Function not implemented)\\nprivate-raw-value');process.exit(125);`,
  );
  const records: string[] = [];
  const original = console.error;
  console.error = (line: string) => {
    records.push(line);
  };
  try {
    await processOne(state.db, state.config);
    const row = state.db.one('SELECT status,error FROM demos WHERE id=?', state.demo.id)!;
    assert.equal(row.status, 'failed');
    assert.match(row.error, /\[sandbox_unavailable\]/);
    const event = JSON.parse(records.at(-1)!);
    assert.equal(event.event, 'demo_processing_failed');
    assert.equal(event.demoId, state.demo.id);
    assert.equal(event.exitCode, 125);
    assert.match(event.sandboxReason, /Landlock ABI 3/);
    assert.equal(records.join('').includes('private-raw-value'), false);
  } finally {
    console.error = original;
    state.close();
  }
});
