import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  opendirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.js';
import { type Store, type Row, now } from './db.js';
import { HttpError } from './errors.js';
import { captionArtifactName, captionLimits, validateCaptionArtifact } from './captions.js';
import { runIsolatedJob } from './parser-job.js';
import { replayLimits, validateReplayArtifacts } from './replay.js';

const enabled = (db: Store, c: Config) =>
  db.flag(c, 'transcription_enabled') && Boolean(c.transcriptionModelDir);
export function initialTranscriptionStatus(db: Store, c: Config, voice: unknown) {
  if (!enabled(db, c)) return 'disabled';
  return voice === 'available' || voice === 'partial' ? 'queued' : 'unavailable';
}

/** HTTP callers enforce ownership, CSRF and rate limits before invoking this transition. */
export function requeueTranscription(
  db: Store,
  c: Config,
  row: Row,
): { status: 'queued' | 'processing' | 'ready' } {
  return db.transaction(() => {
    if (!db.flag(c, 'transcription_enabled'))
      throw new HttpError(403, 'Automatic subtitles are disabled.');
    if (!c.transcriptionModelDir)
      throw new HttpError(503, 'The administrator must configure an offline transcription model.');
    const current = db.one('SELECT * FROM demos WHERE id=?', row.id);
    if (!current) throw new HttpError(404, 'Demo not found.');
    if (current.status !== 'ready') throw new HttpError(409, 'This demo is not ready.');
    if (['queued', 'processing', 'ready'].includes(current.transcription_status))
      return { status: current.transcription_status };
    let voice: unknown;
    try {
      voice = JSON.parse(current.metadata || '{}').communications?.voice;
    } catch {
      /* Legacy replay has no recorded voice contract. */
    }
    if (voice !== 'available' && voice !== 'partial')
      throw new HttpError(409, 'No supported recorded voice is available for transcription.');
    db.run(
      "UPDATE demos SET transcription_status='queued',transcription_job_id=NULL,transcription_started_at=NULL WHERE id=?",
      row.id,
    );
    return { status: 'queued' };
  });
}

/** Caption jobs accept only copied replay slices and one bounded output file. */
export function inspectTranscriptionScratch(folder: string) {
  let count = 0,
    total = 0;
  const scan = (path: string, chunks: boolean) => {
    const directory = opendirSync(path);
    try {
      for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
        if (++count > replayLimits.chunks + 3) throw new Error('Too many transcription files');
        const file = join(path, entry.name),
          info = lstatSync(file);
        if (!chunks && entry.name === 'chunks' && info.isDirectory()) {
          scan(file, true);
          continue;
        }
        if (!info.isFile() || info.nlink !== 1) throw new Error('Invalid transcription artifact');
        const limit =
          chunks && /^(?:0|[1-9]\d{0,2})\.json\.gz$/.test(entry.name)
            ? replayLimits.chunkBytes
            : !chunks && entry.name === 'manifest.json.gz'
              ? replayLimits.manifestBytes
              : !chunks && entry.name === 'captions.json.gz'
                ? captionLimits.bytes
                : 0;
        total += info.size;
        if (!limit || info.size > limit || total > replayLimits.storedBytes + captionLimits.bytes)
          throw new Error('Transcription storage limit');
      }
    } finally {
      directory.closeSync();
    }
  };
  scan(folder, false);
}

/** Optional CPU speech recognition never changes the primary replay's ready state. */
export async function processTranscriptionOne(db: Store, c: Config, signal?: AbortSignal) {
  if (!enabled(db, c) || signal?.aborted) return false;
  const lease = randomBytes(16).toString('hex');
  const row = db.transaction(() => {
    const next = db.one(
      "SELECT * FROM demos WHERE status='ready' AND transcription_status='queued' ORDER BY created_at LIMIT 1",
    );
    if (next)
      db.run(
        "UPDATE demos SET transcription_status='processing',transcription_started_at=?,transcription_job_id=? WHERE id=?",
        now(),
        lease,
        next.id,
      );
    return next;
  });
  if (!row) return false;
  const folder = join(db.root, 'demos', row.id),
    artifact = `captions-${lease}.json.gz`;
  let job = '',
    pending = '',
    promoted = false,
    complete = false;
  const stillOwned = () => {
    const current = db.one(
      'SELECT status,transcription_status,transcription_job_id FROM demos WHERE id=?',
      row.id,
    );
    return (
      current?.status === 'ready' &&
      current.transcription_status === 'processing' &&
      current.transcription_job_id === lease
    );
  };
  try {
    const prepared = validateReplayArtifacts(folder);
    const jobs = join(db.root, 'transcription-jobs');
    mkdirSync(jobs, { recursive: true, mode: 0o700 });
    job = mkdtempSync(join(jobs, `${row.id}-`));
    mkdirSync(join(job, 'chunks'), { mode: 0o700 });
    for (const file of prepared.files) {
      copyFileSync(join(folder, file), join(job, file), constants.COPYFILE_EXCL);
      chmodSync(join(job, file), 0o600);
    }
    await runIsolatedJob(
      job,
      c,
      () => !stillOwned() || !enabled(db, c) || Boolean(signal?.aborted),
      {
        entry: 'transcription-job.js',
        timeoutSeconds: c.transcriptionTimeoutSeconds,
        fileLimitMb: 2,
        modelDir: c.transcriptionModelDir,
        inspect: () => inspectTranscriptionScratch(job),
        environment: {
          CSWATCH_TRANSCRIPTION_MODEL_DIR: c.transcriptionModelDir,
          CSWATCH_TRANSCRIPTION_MAX_AUDIO_SECONDS: String(c.transcriptionMaxAudioSeconds),
          CSWATCH_TRANSCRIPTION_TIMEOUT_MS: String(c.transcriptionTimeoutSeconds * 1000),
          CSWATCH_TRANSCRIPTION_LANGUAGE: c.transcriptionLanguage,
        },
      },
    );
    const output = validateCaptionArtifact(job, prepared.manifest);
    if (signal?.aborted || !enabled(db, c)) throw new Error('Transcription cancelled');
    if (output.result.status === 'unavailable') {
      db.run(
        "UPDATE demos SET transcription_status='unavailable',transcription_job_id=NULL WHERE id=? AND status='ready' AND transcription_status='processing' AND transcription_job_id=?",
        row.id,
        lease,
      );
      complete = true;
      return true;
    }
    pending = join(folder, `.captions-${lease}.tmp`);
    copyFileSync(join(job, 'captions.json.gz'), pending, constants.COPYFILE_EXCL);
    chmodSync(pending, 0o600);
    let previous: string | null = null;
    db.transaction(() => {
      if (!stillOwned()) throw new Error('Transcription lease was revoked');
      const current = db.one(
        'SELECT transcription_bytes,transcription_artifact FROM demos WHERE id=?',
        row.id,
      )!;
      const delta = output.bytes - Number(current.transcription_bytes || 0);
      const user = db.one(
        'SELECT coalesce(sum(size),0) AS bytes FROM demos WHERE owner_id=?',
        row.owner_id,
      )!;
      const global = db.one('SELECT coalesce(sum(size),0) AS bytes FROM demos')!;
      if (
        delta > 0 &&
        (user.bytes + delta > c.userStorageMb * 1024 ** 2 ||
          global.bytes + delta > c.globalStorageMb * 1024 ** 2)
      )
        throw new Error('Caption storage quota');
      renameSync(pending, join(folder, artifact));
      promoted = true;
      db.run(
        "UPDATE demos SET transcription_status='ready',transcription_job_id=NULL,transcription_artifact=?,transcription_bytes=?,size=size+? WHERE id=? AND transcription_job_id=?",
        artifact,
        output.bytes,
        delta,
        row.id,
        lease,
      );
      previous = current.transcription_artifact || null;
    });
    complete = true;
    if (previous) {
      try {
        rmSync(join(folder, captionArtifactName(previous)), { force: true });
      } catch {
        /* Retention also removes the enclosing demo. */
      }
    }
  } catch {
    const status = !enabled(db, c) ? 'disabled' : signal?.aborted ? 'queued' : 'failed';
    db.run(
      "UPDATE demos SET transcription_status=?,transcription_job_id=NULL WHERE id=? AND status='ready' AND transcription_status='processing' AND transcription_job_id=?",
      status,
      row.id,
      lease,
    );
    console.warn('Transcription did not complete', row.id);
  } finally {
    if (!complete && promoted) rmSync(join(folder, artifact), { force: true });
    if (pending) rmSync(pending, { force: true });
    if (job) rmSync(job, { recursive: true, force: true });
  }
  return true;
}

export function maintainTranscriptions(db: Store, c: Config) {
  if (!enabled(db, c))
    db.run(
      "UPDATE demos SET transcription_status='disabled',transcription_job_id=NULL WHERE transcription_status IN ('queued','processing')",
    );
  else
    db.run(
      "UPDATE demos SET transcription_status='queued',transcription_job_id=NULL WHERE status='ready' AND transcription_status='disabled' AND (CASE WHEN json_valid(metadata) THEN json_extract(metadata,'$.communications.voice') END) IN ('available','partial')",
    );
  db.run(
    "UPDATE demos SET transcription_status='failed',transcription_job_id=NULL WHERE transcription_status='processing' AND transcription_started_at<?",
    now() - c.transcriptionTimeoutSeconds - 60,
  );
  const jobs = join(db.root, 'transcription-jobs');
  mkdirSync(jobs, { recursive: true, mode: 0o700 });
  const directory = opendirSync(jobs);
  try {
    for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
      if (!/^[a-f0-9]{32}-[A-Za-z0-9]{6}$/.test(entry.name)) continue;
      const path = join(jobs, entry.name);
      try {
        const info = lstatSync(path);
        if (
          info.isDirectory() &&
          info.mtimeMs < Date.now() - (c.transcriptionTimeoutSeconds + 60) * 1000
        )
          rmSync(path, { recursive: true, force: true });
      } catch {
        /* Concurrent completion. */
      }
    }
  } finally {
    directory.closeSync();
  }
  // A hard crash can occur after a unique file rename but before its DB pointer commits.
  // Only old, unreferenced files are collected; current pointers and live leases win.
  for (const row of db.all('SELECT id FROM demos WHERE transcription_started_at IS NOT NULL')) {
    const folder = join(db.root, 'demos', row.id);
    let contents;
    try {
      contents = opendirSync(folder);
    } catch {
      continue;
    }
    try {
      let count = 0;
      for (let entry = contents.readSync(); entry && count++ < 128; entry = contents.readSync()) {
        const match = /^(?:captions-([a-f0-9]{32})\.json\.gz|\.captions-([a-f0-9]{32})\.tmp)$/.exec(
          entry.name,
        );
        if (!match) continue;
        const artifactLease = match[1] || match[2];
        const path = join(folder, entry.name);
        try {
          const info = lstatSync(path);
          if (
            !info.isFile() ||
            info.nlink !== 1 ||
            info.mtimeMs >= Date.now() - (c.transcriptionTimeoutSeconds + 60) * 1000
          )
            continue;
          db.transaction(() => {
            const current = db.one(
              'SELECT transcription_artifact,transcription_job_id FROM demos WHERE id=?',
              row.id,
            );
            if (
              current &&
              entry!.name !== current.transcription_artifact &&
              artifactLease !== current.transcription_job_id
            )
              rmSync(path, { force: true });
          });
        } catch {
          /* Owner deletion or another collector won. */
        }
      }
    } finally {
      contents.closeSync();
    }
  }
}
