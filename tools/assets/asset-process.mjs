import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { readFile, writeFile } from 'node:fs/promises';
import { steamAssetLimits } from './steam-assets-plan.mjs';
/** Trusted local executables only. Bounded diagnostics remain in private cache logs.
 * Output callbacks are trusted, cooperative work: onOutputAbort must cancel their
 * pending mutations. A deadline requests cancellation; safe cleanup still awaits
 * their drain rather than allowing a late callback to write into removed scratch.
 */
export async function runAssetProcess(
  command,
  args,
  {
    cwd,
    home,
    temporary,
    signal,
    log,
    storageGuard,
    maxRss,
    onOutputLine,
    onOutputAbort,
    allowFailure = false,
    timeoutMs = 30 * 60 * 1000,
  },
) {
  signal?.throwIfAborted();
  await storageGuard?.();
  signal?.throwIfAborted();
  return await new Promise((resolveJob, rejectJob) => {
    const child = spawn(command, args, {
      cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH || '/usr/bin:/bin',
        HOME: home,
        TMPDIR: temporary,
        LANG: 'C.UTF-8',
        TZ: 'UTC',
        NO_COLOR: '1',
        DOTNET_CLI_TELEMETRY_OPTOUT: '1',
        DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
        DOTNET_EnableDiagnostics: '0',
        // Keep native texture allocations and the parent worker inside the host budget.
        // .NET interprets this managed heap size as hexadecimal (4 GiB).
        DOTNET_GCHeapHardLimit: '100000000',
        DOTNET_GCConserveMemory: '9',
        DOTNET_PROCESSOR_COUNT: '2',
        // The exporter's pinned lightmap block encoder, when not at its image path.
        ...(process.env.CS2EXPORT_BCENC ? { CS2EXPORT_BCENC: process.env.CS2EXPORT_BCENC } : {}),
      },
    });
    let stdout = '',
      stderr = '',
      bytes = 0,
      failure,
      ended = false,
      guardPending;
    const lineBuffers = { stdout: '', stderr: '' },
      outputPending = new Set();
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    const kill = () => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
    };
    const stop = () => {
      failure ||= new Error('Operator asset installation was cancelled.');
      onOutputAbort?.();
      if (!ended) kill();
    };
    const timer = setTimeout(() => {
      failure ||= new Error('Operator asset stage timed out.');
      onOutputAbort?.();
      if (!ended) kill();
    }, timeoutMs);
    signal?.addEventListener('abort', stop, { once: true });
    const guardTimer = storageGuard
      ? setInterval(() => {
          if (guardPending || ended) return;
          guardPending = Promise.resolve()
            .then(async () => {
              if (maxRss) {
                const status = await readFile('/proc/' + child.pid + '/status', 'utf8').catch(
                  (error) => {
                    // The child can exit between the timer and the read.
                    if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error;
                    return '';
                  },
                );
                if (Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0) * 1024 > maxRss)
                  throw Error('Asset stage RSS limit exceeded.');
              }
              await storageGuard();
            })
            .catch((error) => {
              failure ||=
                error instanceof Error ? error : new Error('Operator asset storage guard failed.');
              onOutputAbort?.();
              if (!ended) kill();
            })
            .finally(() => {
              guardPending = undefined;
            });
        }, 250)
      : undefined;
    const dispatchLine = (line, kind) => {
      if (!onOutputLine || failure) return;
      try {
        const work = onOutputLine(line, kind);
        if (work && typeof work.then === 'function') {
          const tracked = Promise.resolve(work)
            .catch((error) => {
              failure ||=
                error instanceof Error ? error : new Error('Operator output processing failed.');
              onOutputAbort?.();
              if (!ended) kill();
            })
            .finally(() => outputPending.delete(tracked));
          outputPending.add(tracked);
        }
      } catch (error) {
        failure ||=
          error instanceof Error ? error : new Error('Operator output processing failed.');
        onOutputAbort?.();
        if (!ended) kill();
      }
    };
    const appendDecoded = (kind, decoded) => {
      if (kind === 'stdout') stdout += decoded;
      else stderr += decoded;
      if (onOutputLine) {
        lineBuffers[kind] += decoded;
        let newline;
        while ((newline = lineBuffers[kind].indexOf('\n')) !== -1) {
          dispatchLine(lineBuffers[kind].slice(0, newline).replace(/\r$/, ''), kind);
          lineBuffers[kind] = lineBuffers[kind].slice(newline + 1);
        }
      }
    };
    const append = (kind, chunk) => {
      bytes += chunk.length;
      if (bytes > steamAssetLimits.logBytes) {
        failure ||= Object.assign(
          new Error('Operator asset diagnostics exceeded the output limit.'),
          {
            code: 'ASSET_OUTPUT_LIMIT',
          },
        );
        onOutputAbort?.();
        kill();
        return;
      }
      appendDecoded(kind, decoders[kind].write(chunk));
    };
    child.stdout.on('data', (chunk) => append('stdout', chunk));
    child.stderr.on('data', (chunk) => append('stderr', chunk));
    child.once('error', (error) => {
      failure ||= error;
    });
    child.once('close', async (code, exitSignal) => {
      ended = true;
      clearInterval(guardTimer);
      kill();
      try {
        // Finish the one in-flight check before deciding whether this stage can
        // succeed. No late guard can mutate the result or kill another stage.
        await guardPending;
        for (const kind of ['stdout', 'stderr']) {
          appendDecoded(kind, decoders[kind].end());
          if (lineBuffers[kind]) dispatchLine(lineBuffers[kind], kind);
        }
        await Promise.all([...outputPending]);
        if (log)
          await writeFile(
            log,
            stdout +
              stderr +
              `\nOperator process exit: ${code ?? 'none'}, signal: ${exitSignal ?? 'none'}\n`,
            { mode: 0o600, flag: 'wx' },
          );
        if (failure) throw failure;
        if (code !== 0 && !allowFailure)
          throw Object.assign(
            new Error(
              `Operator asset stage failed with exit ${code ?? 'none'}, signal ${exitSignal ?? 'none'}. See ${log || 'the private cache log'}.`,
            ),
            { exitCode: code },
          );
        resolveJob({ code, signal: exitSignal, stdout, stderr });
      } catch (error) {
        rejectJob(error);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', stop);
      }
    });
    if (signal?.aborted) stop();
  });
}
