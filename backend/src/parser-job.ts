import { spawn } from 'node:child_process';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { access } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Config } from './config.js';
import { replayLimits } from './replay.js';
import {
  JobFailure,
  parserFailureMessages,
  sandboxFailureReason,
  type ParserFailureCode,
} from './parser-failure.js';

const runtime = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');

function assertSandboxLayout(dataDir: string, modelDir?: string) {
  const data = realpathSync(dataDir);
  for (const path of [
    runtime,
    resolve(runtime, '../node_modules'),
    '/lib',
    '/lib64',
    '/usr/lib',
    ...(modelDir ? [modelDir] : []),
  ]) {
    if (!existsSync(path)) continue;
    const suffix = relative(realpathSync(path), data);
    if (suffix === '' || (suffix !== '..' && !suffix.startsWith('../') && !suffix.startsWith('/')))
      throw new Error('Keep DATA_DIR outside parser code and system library directories');
  }
}

/** Bounded polling limits malicious scratch growth; host quotas remain the hard disk boundary. */
export function inspectParserScratch(folder: string, c: Config) {
  let stored = 0,
    total = 0,
    entries = 0;
  const scan = (directory: string, chunks: boolean) => {
    const handle = opendirSync(directory);
    try {
      for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
        if (++entries > replayLimits.chunks + 8) throw new Error('Parser created too many files');
        const path = join(directory, entry.name),
          info = lstatSync(path);
        if (!chunks && entry.name === 'chunks' && info.isDirectory()) {
          scan(path, true);
          continue;
        }
        if (!info.isFile() || info.nlink !== 1)
          throw new Error('Parser created an invalid artifact');
        let limit: number;
        if (chunks && /^(?:0|[1-9]\d{0,2})\.json\.gz$/.test(entry.name)) {
          limit = replayLimits.chunkBytes;
          stored += info.size;
        } else if (!chunks && /^input\.(?:dem|zst|gz)$/.test(entry.name))
          limit = c.maxUploadMb * 1024 ** 2;
        else if (!chunks && entry.name === 'expanded.dem') limit = c.maxExpandedMb * 1024 ** 2;
        else if (!chunks && entry.name === 'manifest.json.gz') {
          limit = replayLimits.manifestBytes;
          stored += info.size;
        } else if (!chunks && entry.name === 'summary.json') limit = 256 * 1024;
        else if (!chunks && entry.name === 'failure.txt') limit = 1024;
        else throw new Error('Parser created an unexpected artifact');
        total += info.size;
        if (
          info.size > limit ||
          stored > replayLimits.storedBytes ||
          total >
            (c.maxUploadMb + c.maxExpandedMb) * 1024 ** 2 + replayLimits.storedBytes + 256 * 1024
        )
          throw new Error('Parser scratch storage limit');
      }
    } finally {
      handle.closeSync();
    }
  };
  scan(folder, false);
}

type IsolatedJobOptions = {
  entry: 'parser.js' | 'transcription-job.js';
  timeoutSeconds: number;
  fileLimitMb: number;
  inspect: () => void;
  modelDir?: string;
  environment?: Record<string, string>;
};
/** Native parser and speech inference share the same inherited kernel boundary. */
export async function runIsolatedJob(
  folder: string,
  c: Config,
  cancelled: () => boolean,
  options: IsolatedJobOptions,
) {
  if (options.entry === 'transcription-job.js' && !options.modelDir)
    throw new Error('Transcription requires a local model');
  const heap = String(Math.max(256, Math.floor(c.parserMemoryMb / 2)));
  const sandbox = c.parserSandboxBinary || join(runtime, 'parser-sandbox');
  const args =
    c.parserSandbox === 'off'
      ? [
          `--max-old-space-size=${heap}`,
          join(runtime, options.entry),
          folder,
          ...(options.entry === 'parser.js' ? [String(options.fileLimitMb)] : []),
        ]
      : [
          folder,
          runtime,
          resolve(runtime, '../node_modules'),
          process.execPath,
          heap,
          String(options.fileLimitMb),
          String(options.timeoutSeconds),
          ...(options.modelDir ? [options.entry, realpathSync(options.modelDir)] : []),
        ];
  if (!existsSync(join(runtime, options.entry)) || !existsSync(join(runtime, 'job-stdio.js')))
    throw new Error('Build the job entry before running jobs');
  if (c.parserSandbox !== 'off') {
    if (process.platform !== 'linux')
      throw new Error('Untrusted parsing requires the Linux sandbox');
    assertSandboxLayout(c.dataDir, options.modelDir);
    await access(sandbox, constants.X_OK);
  }
  await new Promise<void>((resolveJob, rejectJob) => {
    const child = spawn(c.parserSandbox === 'off' ? process.execPath : sandbox, args, {
      cwd: folder,
      env: {
        NODE_OPTIONS: `--import=${pathToFileURL(join(runtime, 'job-stdio.js')).href}`,
        HOME: folder,
        TMPDIR: folder,
        RAYON_NUM_THREADS: '2',
        UV_THREADPOOL_SIZE: '2',
        TZ: 'UTC',
        LANG: 'C.UTF-8',
        CSWATCH_PARENT_PID: String(process.pid),
        ...Object.fromEntries(
          Object.entries(options.environment || {}).filter(([key]) =>
            [
              'CSWATCH_TRANSCRIPTION_MODEL_DIR',
              'CSWATCH_TRANSCRIPTION_TIMEOUT_MS',
              'CSWATCH_TRANSCRIPTION_MAX_AUDIO_SECONDS',
              'CSWATCH_TRANSCRIPTION_LANGUAGE',
            ].includes(key),
          ),
        ),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: true,
    });
    const killGroup = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* Already reaped. */
        }
      }
    };
    let failure: Error | undefined;
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      // Always drain the pipe so hostile output cannot block the child, but
      // retain at most 4096 bytes. Raw output is never logged or published.
      if (stderr.length < 4096) stderr += chunk.toString('utf8').slice(0, 4096 - stderr.length);
    });
    const timer = setTimeout(() => {
      failure = new JobFailure('timeout');
      killGroup();
    }, options.timeoutSeconds * 1000);
    const cancel = setInterval(() => {
      try {
        options.inspect();
        if (cancelled()) {
          failure = new JobFailure('cancelled');
          killGroup();
        }
      } catch (error) {
        failure = error instanceof Error ? error : new Error('Parser state unavailable');
        killGroup();
      }
    }, 500);
    child.once('error', (error) => {
      failure = error;
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      clearInterval(cancel);
      // Kill any surviving descendants before reading output. The required sandbox also
      // denies process forks/group escape, so native threads die with their process.
      killGroup();
      if (failure) rejectJob(failure);
      else if (code === 0) resolveJob();
      else {
        const sandboxReason = sandboxFailureReason(stderr);
        let reason: ParserFailureCode =
          code === 125 || sandboxReason
            ? 'sandbox_unavailable'
            : signal
              ? 'parser_crash'
              : 'processing_failed';
        if (/heap out of memory|allocation failed/i.test(stderr)) reason = 'memory_limit';
        if (signal === 'SIGXCPU') reason = 'timeout';
        if (signal === 'SIGXFSZ') reason = 'storage_limit';
        if (!sandboxReason && !signal) {
          let fd: number | undefined;
          try {
            fd = openSync(
              join(folder, 'failure.txt'),
              constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
            );
            const info = fstatSync(fd);
            if (info.isFile() && info.nlink === 1 && info.size <= 1024) {
              const record = JSON.parse(readFileSync(fd, 'utf8'));
              if (
                record &&
                typeof record.code === 'string' &&
                Object.hasOwn(parserFailureMessages, record.code)
              )
                reason = record.code;
            }
          } catch {
            /* Missing or invalid failure metadata never becomes a trusted reason. */
          } finally {
            if (fd !== undefined) closeSync(fd);
          }
        }
        rejectJob(
          new JobFailure(reason, {
            exitCode: code,
            signal,
            ...(sandboxReason ? { sandboxReason } : {}),
          }),
        );
      }
    });
  });
  options.inspect();
}

export function runParserJob(folder: string, c: Config, cancelled: () => boolean) {
  return runIsolatedJob(folder, c, cancelled, {
    entry: 'parser.js',
    timeoutSeconds: c.parserTimeoutSeconds,
    fileLimitMb: c.maxExpandedMb,
    inspect: () => inspectParserScratch(folder, c),
  });
}
