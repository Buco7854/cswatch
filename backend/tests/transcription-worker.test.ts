import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { Store, now } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { reserve } from '../src/ingestion.js';
import { writeReplay, validateReplayArtifacts } from '../src/replay.js';
import {
  maintainTranscriptions,
  processTranscriptionOne,
  requeueTranscription,
} from '../src/transcription-worker.js';

const speaker = '76561198000000001';
const envelope = {
  status: 'ready',
  cues: [
    {
      id: 'cue-1',
      startTick: 8,
      endTick: 32,
      speaker,
      text: 'Disposable test transcript.',
      source: 'local-transcription',
    },
  ],
};
const outputRunner = `const {writeFileSync}=require('node:fs');const{gzipSync}=require('node:zlib');writeFileSync(process.argv[2]+'/captions.json.gz',gzipSync(JSON.stringify(${JSON.stringify(envelope)})));`;
async function state(body = outputRunner, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cswatch-transcription-queue-'));
  const runner = join(dir, 'test-runner.cjs'),
    model = join(dir, 'model');
  mkdirSync(model);
  writeFileSync(runner, `#!${process.execPath}\n${body}`, { mode: 0o700 });
  const config = loadConfig({
    APP_URL: 'http://localhost:8000',
    COOKIE_SECURE: 'false',
    DATA_DIR: dir,
    MAX_UPLOAD_MB: '1',
    TRANSCRIPTION_ENABLED: 'true',
    TRANSCRIPTION_MODEL_DIR: model,
    PARSER_SANDBOX_BINARY: runner,
    ...env,
  });
  const db = new Store(dir);
  db.run(
    'INSERT INTO users(id,username,password_hash,role,created_at) VALUES(?,?,?,?,?)',
    'caption-user',
    'caption-user',
    null,
    'member',
    now(),
  );
  const demo = reserve(db, config, 'caption-user', 'fixture.dem', 'upload');
  await writeReplay(demo.folder, {
    map: 'training',
    tickRate: 64,
    sample: false,
    players: [{ id: speaker, name: 'Fixture', team: 2 }],
    events: [],
    rounds: [{ number: 1, tick: 4 }],
    frames: [4, 64].map((tick) => ({
      tick,
      players: [
        {
          id: speaker,
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
    })),
    voice: [
      {
        id: 'voice-1',
        speaker,
        tick: 4,
        opus: Buffer.from([120, 1, 2]).toString('base64'),
        channels: 1,
        sampleRate: 48000,
        durationMs: 20,
      },
    ],
    communications: {
      voice: 'available',
      chat: 'absent',
      captions: 'disabled',
      unsupportedPackets: 0,
    },
  });
  const replay = validateReplayArtifacts(demo.folder);
  const size = replay.bytes + 8;
  db.run(
    "UPDATE demos SET status='ready',size=?,transcription_status='queued',metadata=? WHERE id=?",
    size,
    JSON.stringify({
      firstTick: 4,
      lastTick: 64,
      players: replay.manifest.players,
      communications: replay.manifest.communications,
    }),
    demo.id,
  );
  return {
    dir,
    config,
    db,
    demo,
    size,
    runner,
    row: () => db.one('SELECT * FROM demos WHERE id=?', demo.id),
    close: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('durable caption stage publishes validated unique artifacts without changing the ready replay', async () => {
  const s = await state();
  try {
    const before = readFileSync(join(s.demo.folder, 'manifest.json.gz'));
    assert.equal(await processTranscriptionOne(s.db, s.config), true);
    const row = s.row()!;
    assert.equal(row.status, 'ready');
    assert.equal(row.transcription_status, 'ready');
    assert.match(row.transcription_artifact, /^captions-[a-f0-9]{32}\.json\.gz$/);
    assert.equal(existsSync(join(s.demo.folder, row.transcription_artifact)), true);
    assert.equal(row.size, s.size + row.transcription_bytes);
    assert.deepEqual(readFileSync(join(s.demo.folder, 'manifest.json.gz')), before);
    assert.equal(await processTranscriptionOne(s.db, s.config), false);
    assert.deepEqual(readdirSync(join(s.dir, 'transcription-jobs')), []);
  } finally {
    s.close();
  }
});
test('failed speech inference and quota failures leave primary playback ready and intact', async () => {
  for (const quota of [false, true]) {
    const s = await state(
      quota ? outputRunner : 'process.exit(1);',
      quota ? { USER_STORAGE_MB: '1' } : {},
    );
    try {
      if (quota) s.db.run('UPDATE demos SET size=? WHERE id=?', 1024 ** 2 - 1, s.demo.id);
      await processTranscriptionOne(s.db, s.config);
      assert.equal(s.row()!.status, 'ready');
      assert.equal(s.row()!.transcription_status, 'failed');
      assert.equal(s.row()!.transcription_artifact, null);
      assert.equal(validateReplayArtifacts(s.demo.folder).manifest.map, 'training');
    } finally {
      s.close();
    }
  }
});
test('graceful shutdown requeues optional inference; deletion and revoked leases cancel safely', async () => {
  for (const reason of ['shutdown', 'delete', 'lease'] as const) {
    const s = await state('setInterval(()=>{},1000);');
    const controller = new AbortController();
    try {
      const work = processTranscriptionOne(s.db, s.config, controller.signal);
      setTimeout(() => {
        if (reason === 'shutdown') controller.abort();
        else if (reason === 'delete') s.db.run('DELETE FROM demos WHERE id=?', s.demo.id);
        else s.db.run("UPDATE demos SET transcription_job_id='new-lease' WHERE id=?", s.demo.id);
      }, 40);
      await work;
      if (reason === 'delete') assert.equal(s.row(), undefined);
      else {
        assert.equal(s.row()!.status, 'ready');
        assert.equal(
          s.row()!.transcription_status,
          reason === 'shutdown' ? 'queued' : 'processing',
        );
        if (reason === 'lease') assert.equal(s.row()!.transcription_job_id, 'new-lease');
      }
      assert.deepEqual(readdirSync(join(s.dir, 'transcription-jobs')), []);
    } finally {
      s.close();
    }
  }
});
test('caption publication rollback preserves the previous artifact and its storage accounting', async () => {
  const s = await state();
  try {
    const old = `captions-${'a'.repeat(32)}.json.gz`,
      bytes = gzipSync(
        JSON.stringify({
          ...envelope,
          cues: [{ ...envelope.cues[0], text: 'Previous captions.' }],
        }),
      );
    writeFileSync(join(s.demo.folder, old), bytes);
    s.db.run(
      'UPDATE demos SET transcription_artifact=?,transcription_bytes=?,size=size+? WHERE id=?',
      old,
      bytes.length,
      bytes.length,
      s.demo.id,
    );
    s.db.db.exec(
      "CREATE TRIGGER test_caption_publish BEFORE UPDATE OF transcription_status ON demos WHEN new.transcription_status='ready' BEGIN SELECT RAISE(ABORT,'simulated caption commit failure'); END;",
    );
    await processTranscriptionOne(s.db, s.config);
    assert.equal(s.row()!.status, 'ready');
    assert.equal(s.row()!.transcription_status, 'failed');
    assert.equal(s.row()!.transcription_artifact, old);
    assert.deepEqual(readFileSync(join(s.demo.folder, old)), bytes);
    assert.equal(s.row()!.size, s.size + bytes.length);
    assert.deepEqual(
      readdirSync(s.demo.folder).filter((name) => name.startsWith('captions-')),
      [old],
    );
  } finally {
    s.close();
  }
});
test('environment policy wins, enabling queues existing voice replays, stale leases fail without changing playback', async () => {
  const s = await state(outputRunner, { TRANSCRIPTION_ENABLED: 'false' });
  try {
    s.db.run("INSERT INTO settings VALUES('transcription_enabled',1)");
    maintainTranscriptions(s.db, s.config);
    assert.equal(s.row()!.transcription_status, 'disabled');
    assert.equal(await processTranscriptionOne(s.db, s.config), false);
    const enabled = { ...s.config, flags: { ...s.config.flags, transcription_enabled: undefined } };
    maintainTranscriptions(s.db, enabled);
    assert.equal(s.row()!.transcription_status, 'queued');
    s.db.run(
      "UPDATE demos SET transcription_status='processing',transcription_job_id='stale',transcription_started_at=? WHERE id=?",
      now() - enabled.transcriptionTimeoutSeconds - 61,
      s.demo.id,
    );
    maintainTranscriptions(s.db, enabled);
    assert.equal(s.row()!.transcription_status, 'failed');
    assert.equal(s.row()!.status, 'ready');
    assert.equal(s.row()!.transcription_job_id, null);
  } finally {
    s.close();
  }
});
test('a readonly model grant cannot include private application data', async () => {
  const s = await state();
  try {
    await processTranscriptionOne(s.db, { ...s.config, transcriptionModelDir: s.dir });
    assert.equal(s.row()!.status, 'ready');
    assert.equal(s.row()!.transcription_status, 'failed');
    assert.equal(s.row()!.transcription_artifact, null);
  } finally {
    s.close();
  }
});

test('caption retries preserve live leases, respect policy/model/voice requirements and recover failed jobs', async () => {
  const s = await state();
  try {
    const previousStart = now();
    s.db.run(
      "UPDATE demos SET transcription_status='failed',transcription_job_id='old',transcription_started_at=? WHERE id=?",
      previousStart,
      s.demo.id,
    );
    assert.deepEqual(requeueTranscription(s.db, s.config, s.row()!), { status: 'queued' });
    assert.equal(s.row()!.transcription_job_id, null);
    assert.equal(s.row()!.transcription_started_at, previousStart);
    s.db.run(
      "UPDATE demos SET transcription_status='processing',transcription_job_id='current' WHERE id=?",
      s.demo.id,
    );
    assert.deepEqual(requeueTranscription(s.db, s.config, s.row()!), { status: 'processing' });
    assert.equal(s.row()!.transcription_job_id, 'current');
    assert.throws(() =>
      requeueTranscription(
        s.db,
        { ...s.config, flags: { ...s.config.flags, transcription_enabled: false } },
        s.row()!,
      ),
    );
    assert.throws(() =>
      requeueTranscription(s.db, { ...s.config, transcriptionModelDir: '' }, s.row()!),
    );
    s.db.run(
      "UPDATE demos SET transcription_status='unavailable',metadata='{}' WHERE id=?",
      s.demo.id,
    );
    assert.throws(() => requeueTranscription(s.db, s.config, s.row()!));
    assert.equal(s.row()!.transcription_status, 'unavailable');
  } finally {
    s.close();
  }
});

test('caption recovery removes old uncommitted artifacts while preserving current pointers and live leases', async () => {
  const s = await state();
  try {
    const current = `captions-${'a'.repeat(32)}.json.gz`,
      orphan = `captions-${'b'.repeat(32)}.json.gz`,
      live = `captions-${'c'.repeat(32)}.json.gz`,
      fresh = `captions-${'d'.repeat(32)}.json.gz`,
      pending = `.captions-${'e'.repeat(32)}.tmp`,
      livePending = `.captions-${'c'.repeat(32)}.tmp`;
    for (const name of [current, orphan, live, fresh, pending, livePending])
      writeFileSync(join(s.demo.folder, name), 'fixture');
    for (const name of [current, orphan, live, pending, livePending])
      utimesSync(join(s.demo.folder, name), 1, 1);
    s.db.run(
      "UPDATE demos SET transcription_artifact=?,transcription_status='processing',transcription_job_id=?,transcription_started_at=? WHERE id=?",
      current,
      'c'.repeat(32),
      now(),
      s.demo.id,
    );
    maintainTranscriptions(s.db, s.config);
    assert.equal(existsSync(join(s.demo.folder, orphan)), false);
    assert.equal(existsSync(join(s.demo.folder, pending)), false);
    for (const name of [current, live, fresh, livePending])
      assert.equal(existsSync(join(s.demo.folder, name)), true);
  } finally {
    s.close();
  }
});
