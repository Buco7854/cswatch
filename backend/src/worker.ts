import {
  copyFileSync,
  chmodSync,
  constants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  opendirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Store, now, openStoreForStartup } from './db.js';
import { loadConfig, type Config } from './config.js';
import { runParserJob } from './parser-job.js';
import { validateReplayArtifacts } from './replay.js';
import { parserFailureMessages, processingFailure } from './parser-failure.js';
import { cleanupExpiredGuests } from './guest.js';
import {
  initialTranscriptionStatus,
  maintainTranscriptions,
  processTranscriptionOne,
} from './transcription-worker.js';
export { processTranscriptionOne } from './transcription-worker.js';
export async function processOne(db: Store, c: Config) {
  const row = db.transaction(() => {
    const r = db.one("SELECT * FROM demos WHERE status='queued' ORDER BY created_at LIMIT 1");
    if (r) db.run("UPDATE demos SET status='processing',started_at=? WHERE id=?", now(), r.id);
    return r;
  });
  if (!row) return false;
  const folder = join(db.root, 'demos', row.id);
  const jobs = join(db.root, 'jobs');
  let job = '',
    pending = '',
    complete = false,
    chunksPromoted = false,
    manifestPromoted = false;
  let stage = 'input';
  try {
    mkdirSync(jobs, { recursive: true, mode: 0o700 });
    job = mkdtempSync(join(jobs, `${row.id}-`));
    const inputs = ['input.dem', 'input.zst', 'input.gz'].filter((name) => {
      try {
        return lstatSync(join(folder, name)).isFile();
      } catch {
        return false;
      }
    });
    if (inputs.length !== 1) throw new Error('Invalid input');
    const input = lstatSync(join(folder, inputs[0]));
    if (input.nlink !== 1 || input.size > c.maxUploadMb * 1024 ** 2)
      throw new Error('Invalid input size');
    copyFileSync(join(folder, inputs[0]), join(job, inputs[0]), constants.COPYFILE_EXCL);
    chmodSync(join(job, inputs[0]), 0o600);
    stage = 'sandbox';
    await runParserJob(
      job,
      c,
      () => db.one('SELECT status FROM demos WHERE id=?', row.id)?.status !== 'processing',
    );
    stage = 'validation';
    const output = validateReplayArtifacts(job);
    const m = output.manifest;
    if (m.sample) throw new Error('Uploaded demos cannot publish synthetic sample data');
    const score = m.matchState?.samples.findLast(
      (sample) => sample.ctScore !== undefined && sample.tScore !== undefined,
    );
    const summary = {
      recordedScore:
        score?.ctScore !== undefined && score?.tScore !== undefined
          ? [score.ctScore, score.tScore]
          : undefined,
      map: m.map,
      mapIdentity: m.mapIdentity,
      duration: (m.lastTick - m.firstTick) / m.tickRate,
      rounds: m.rounds.length,
      players: m.players,
      firstTick: m.firstTick,
      lastTick: m.lastTick,
      warnings: m.warnings,
      replayVersion: m.version,
      communications: m.communications,
      capabilities: m.capabilities,
    };
    stage = 'publication';
    pending = mkdtempSync(join(folder, '.prepared-'));
    mkdirSync(join(pending, 'chunks'), { mode: 0o700 });
    for (const file of output.files) {
      copyFileSync(join(job, file), join(pending, file), constants.COPYFILE_EXCL);
      chmodSync(join(pending, file), 0o600);
    }
    db.transaction(() => {
      if (db.one('SELECT status FROM demos WHERE id=?', row.id)?.status !== 'processing')
        throw new Error('Job cancelled before publication');
      const user = db.one(
        'SELECT coalesce(sum(size),0) AS bytes FROM demos WHERE owner_id=?',
        row.owner_id,
      )!;
      const global = db.one('SELECT coalesce(sum(size),0) AS bytes FROM demos')!;
      if (
        user.bytes + output.bytes >
          (db.one('SELECT owner_id FROM guest_sessions WHERE owner_id=?', row.owner_id)
            ? c.guestStorageMb
            : c.userStorageMb) *
            1024 ** 2 ||
        global.bytes + output.bytes > c.globalStorageMb * 1024 ** 2
      )
        throw new Error('Prepared output exceeds storage quota');
      renameSync(join(pending, 'chunks'), join(folder, 'chunks'));
      chunksPromoted = true;
      renameSync(join(pending, 'manifest.json.gz'), join(folder, 'manifest.json.gz'));
      manifestPromoted = true;
      db.run(
        "UPDATE demos SET status='ready',map=?,duration=?,rounds=?,metadata=json_patch(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END,?),size=size+?,transcription_status=? WHERE id=? AND status='processing'",
        summary.map,
        summary.duration,
        summary.rounds,
        JSON.stringify(summary),
        output.bytes,
        initialTranscriptionStatus(db, c, m.communications.voice),
        row.id,
      );
    });
    complete = true;
    console.info('Parsed demo', row.id);
  } catch (error) {
    const failure = processingFailure(error, stage);
    db.run(
      "UPDATE demos SET status='failed',error=? WHERE id=? AND status='processing'",
      `[${failure.code}] ${parserFailureMessages[failure.code]}`,
      row.id,
    );
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'demo_processing_failed',
        demoId: row.id,
        stage,
        ...failure,
      }),
    );
  } finally {
    if (!complete) {
      if (chunksPromoted) rmSync(join(folder, 'chunks'), { recursive: true, force: true });
      if (manifestPromoted) rmSync(join(folder, 'manifest.json.gz'), { force: true });
    }
    if (job) rmSync(job, { recursive: true, force: true });
    if (pending) rmSync(pending, { recursive: true, force: true });
  }
  return true;
}
export function housekeeping(db: Store, c: Config) {
  cleanupExpiredGuests(db);
  maintainTranscriptions(db, c);
  // Mark interrupted work failed, rather than retrying a malicious crash input forever.
  db.run(
    "UPDATE demos SET status='failed',error='Processing was interrupted. Upload the demo again.' WHERE status='processing' AND started_at<?",
    now() - c.parserTimeoutSeconds - 60,
  );
  const stale = db.all(
    "SELECT id FROM demos WHERE (status='uploading' AND created_at<?) OR (created_at<? AND ?>0)",
    now() - 3600,
    now() - c.retentionDays * 86400,
    c.retentionDays,
  );
  for (const r of stale) {
    db.run('DELETE FROM demos WHERE id=?', r.id);
    rmSync(join(db.root, 'demos', r.id), { recursive: true, force: true });
  }
  // Jobs use independent copies. Recover scratch left by a killed worker without
  // following symlinks or touching another worker's live, bounded job.
  const jobs = join(db.root, 'jobs');
  mkdirSync(jobs, { recursive: true, mode: 0o700 });
  const handle = opendirSync(jobs);
  try {
    for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
      if (!/^[a-f0-9]{32}-[A-Za-z0-9]{6}$/.test(entry.name)) continue;
      const path = join(jobs, entry.name);
      try {
        const info = lstatSync(path);
        if (info.isDirectory() && info.mtimeMs < Date.now() - (c.parserTimeoutSeconds + 60) * 1000)
          rmSync(path, { recursive: true, force: true });
      } catch {
        /* Another worker may have completed cleanup. */
      }
    }
  } finally {
    handle.closeSync();
  }
  for (const table of ['sessions', 'auth_states', 'steam_nonces', 'rate_limits'])
    db.run(`DELETE FROM ${table} WHERE expires_at<?`, now());
  db.run('DELETE FROM audit WHERE created_at<?', now() - 90 * 86400);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  const c = loadConfig(),
    db = openStoreForStartup(c.dataDir);
  if (c.parserSandbox === 'off')
    console.warn(
      'Parser filesystem sandbox is disabled. Only process trusted demos in this development mode.',
    );
  let stop = false,
    lastClean = 0;
  const termination = new AbortController();
  process.on('SIGTERM', () => {
    stop = true;
    termination.abort();
  });
  process.on('SIGINT', () => {
    stop = true;
    termination.abort();
  });
  while (!stop) {
    if (Date.now() - lastClean > 60000) {
      housekeeping(db, c);
      lastClean = Date.now();
    }
    let worked = c.workerRole !== 'transcription' && (await processOne(db, c));
    if (!worked && !stop && c.workerRole !== 'parse')
      worked = await processTranscriptionOne(db, c, termination.signal);
    if (!worked && !stop) await new Promise((r) => setTimeout(r, 2000));
  }
  db.close();
}
