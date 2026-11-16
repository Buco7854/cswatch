import { spawn } from 'node:child_process';
import { readFileSync, rmSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, now } from './db.js';
import { loadConfig, type Config } from './config.js';
export async function processOne(db: Store, c: Config) {
  const row = db.transaction(() => {
    const r = db.one("SELECT * FROM demos WHERE status='queued' ORDER BY created_at LIMIT 1");
    if (r) db.run("UPDATE demos SET status='processing',started_at=? WHERE id=?", now(), r.id);
    return r;
  });
  if (!row) return false;
  const folder = join(db.root, 'demos', row.id);
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          `--max-old-space-size=${Math.max(256, Math.floor(c.parserMemoryMb / 2))}`,
          join(dirname(fileURLToPath(import.meta.url)), 'parser.js'),
          folder,
          String(c.maxExpandedMb),
        ],
        {
          env: {
            PATH: process.env.PATH,
            HOME: folder,
            RAYON_NUM_THREADS: '2',
            UV_THREADPOOL_SIZE: '2',
          },
          stdio: 'ignore',
          detached: true,
        },
      );
      const timer = setTimeout(() => {
        if (child.pid) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            /* Already exited. */
          }
        }
        reject(new Error('Timeout'));
      }, c.parserTimeoutSeconds * 1000);
      child.once('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        code === 0 ? resolve() : reject(new Error('Parser failed'));
      });
    });
    const s = JSON.parse(readFileSync(join(folder, 'summary.json'), 'utf8'));
    const outputSize = statSync(join(folder, 'playback.json.gz')).size;
    db.run(
      "UPDATE demos SET status='ready',map=?,duration=?,rounds=?,metadata=?,size=size+? WHERE id=? AND status='processing'",
      s.map,
      s.duration,
      s.rounds,
      JSON.stringify(s),
      outputSize,
      row.id,
    );
    console.info('Parsed demo', row.id);
  } catch {
    db.run(
      "UPDATE demos SET status='failed',error=? WHERE id=? AND status='processing'",
      'Demo could not be parsed within the processing limits. It may be incomplete, unsupported, or too large.',
      row.id,
    );
    console.warn('Failed demo', row.id);
  } finally {
    for (const name of ['expanded.dem', 'playback.tmp', 'failure.txt'])
      rmSync(join(folder, name), { force: true });
  }
  return true;
}
export function housekeeping(db: Store, c: Config) {
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
  for (const table of ['sessions', 'auth_states', 'rate_limits'])
    db.run(`DELETE FROM ${table} WHERE expires_at<?`, now());
  db.run('DELETE FROM audit WHERE created_at<?', now() - 90 * 86400);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  const c = loadConfig(),
    db = new Store(c.dataDir);
  let stop = false,
    lastClean = 0;
  process.on('SIGTERM', () => {
    stop = true;
  });
  process.on('SIGINT', () => {
    stop = true;
  });
  while (!stop) {
    if (Date.now() - lastClean > 60000) {
      housekeeping(db, c);
      lastClean = Date.now();
    }
    if (!(await processOne(db, c))) await new Promise((r) => setTimeout(r, 2000));
  }
  db.close();
}
