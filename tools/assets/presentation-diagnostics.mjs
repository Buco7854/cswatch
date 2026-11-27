/** The last failed attempt of each presentation category, kept for the operator in the private
 * cache: the failing step, the reason and the tails of the newest stage logs. A later success of
 * the same category removes it. Paths derive only from the fixed cache root and category. */
import { constants } from 'node:fs';
import { lstat, mkdtemp, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { localDirectory } from './toolchain-security.mjs';

export const presentationDiagnosticLimits = Object.freeze({
  logs: 32,
  logBytes: 256 * 1024,
  messageBytes: 4096,
  scanned: 4096,
});
const limits = presentationDiagnosticLimits;
const logName = /^(\d{1,5})-[A-Za-z0-9._-]{1,160}\.log$/;
const safeLabel = /^[a-z0-9][a-z0-9_-]{0,159}$/;

export const presentationDiagnosticsPath = (cacheRoot, kind) =>
  join(cacheRoot, 'diagnostics', `presentation-${kind}`);

/** A fixed step label or reason code, never native output. */
export const safePresentationLabel = (value) =>
  typeof value === 'string' && safeLabel.test(value) ? value : undefined;

/** Classify a failure by the bound or stage that stopped it. */
export function presentationFailureDetail(error) {
  const messages = [];
  for (let cause = error, depth = 0; cause && depth < 8; cause = cause.cause, depth++) {
    if (cause.code === 'ASSET_OUTPUT_LIMIT') return 'output_limit';
    if (cause.code === 'ASSET_RSS_LIMIT') return 'rss_limit';
    if (cause.code === 'ASSET_STAGE_TIMEOUT') return 'stage_timeout';
    if (Number.isInteger(cause.exitCode)) return 'native_exit';
    messages.push(String(cause.message ?? ''));
  }
  const text = messages.join('\n');
  if (/could not be exported|export failed/i.test(text)) return 'native_export';
  if (/\bbound|exceeds?\b|limit/i.test(text)) return 'bound_exceeded';
  return 'other';
}

async function tail(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid()))
      return;
    const length = Math.min(stat.size, limits.logBytes),
      buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, stat.size - length);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function newestLogs(stages) {
  const found = [];
  for (const [index, stage] of stages.entries()) {
    let entries;
    try {
      await localDirectory(stage);
      entries = await readdir(stage, { withFileTypes: true });
    } catch {
      continue;
    }
    if (entries.length > limits.scanned) entries = entries.slice(0, limits.scanned);
    for (const entry of entries) {
      const match = logName.exec(entry.name);
      if (match && entry.isFile())
        found.push({ stage, index, sequence: Number(match[1]), name: entry.name });
    }
  }
  found.sort((a, b) => a.index - b.index || a.sequence - b.sequence);
  return found.slice(-limits.logs);
}

/** Reduce a finished stage to its own private logs, so the journal can remove what remains. */
export async function retainStageLogs(stage) {
  for (const entry of await readdir(stage, { withFileTypes: true })) {
    const path = join(stage, entry.name);
    if (logName.test(entry.name)) {
      const stat = await lstat(path);
      if (
        stat.isFile() &&
        stat.nlink === 1 &&
        !(stat.mode & 0o022) &&
        (!process.getuid || stat.uid === process.getuid())
      )
        continue;
    }
    await rm(path, { recursive: true, force: true });
  }
}

async function diagnosticsRoot(cacheRoot, kind) {
  const root = join(cacheRoot, 'diagnostics');
  await localDirectory(root, true);
  // A crash between writing and renaming leaves only our own fixed-pattern scratch.
  for (const entry of await readdir(root, { withFileTypes: true }))
    if (entry.isDirectory() && entry.name.startsWith(`.presentation-${kind}-`))
      await rm(join(root, entry.name), { recursive: true, force: true });
  return root;
}

/** Replace the category's kept failure. Never throws: diagnostics cannot mask the failure. */
export async function keepPresentationFailure(cacheRoot, kind, stages, failure) {
  try {
    const root = await diagnosticsRoot(cacheRoot, kind),
      scratch = await mkdtemp(join(root, `.presentation-${kind}-`));
    const logs = [];
    for (const log of await newestLogs(stages)) {
      const bytes = await tail(join(log.stage, log.name)).catch(() => undefined);
      if (!bytes) continue;
      await writeFile(join(scratch, log.name), bytes, { flag: 'wx', mode: 0o600 });
      logs.push(log.name);
    }
    const messages = [];
    for (let cause = failure.error, depth = 0; cause && depth < 8; cause = cause.cause, depth++)
      messages.push(String(cause.message ?? cause));
    const record = {
      schemaVersion: 1,
      kind,
      manifest: failure.manifest,
      attempt: failure.attempt,
      ...(failure.item ? { item: failure.item } : {}),
      step: failure.step,
      code: failure.code,
      detail: failure.detail,
      failedAt: new Date().toISOString(),
      reason: Buffer.from(messages.join('\n'))
        .subarray(0, limits.messageBytes)
        .toString('utf8')
        .replace(/�+$/, ''),
      logs,
    };
    await writeFile(join(scratch, 'failure.json'), JSON.stringify(record, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    const target = presentationDiagnosticsPath(cacheRoot, kind);
    await rm(target, { recursive: true, force: true });
    await rename(scratch, target);
    return target;
  } catch {
    return undefined;
  }
}

/** A successful preparation of the category retires its kept failure. Never throws. */
export async function clearPresentationFailure(cacheRoot, kind) {
  const target = presentationDiagnosticsPath(cacheRoot, kind);
  try {
    const stat = await lstat(target);
    if (stat.isDirectory() && !stat.isSymbolicLink())
      await rm(target, { recursive: true, force: true });
  } catch {
    // Nothing kept, or the next failure replaces it.
  }
}
