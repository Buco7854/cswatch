/** Private operator bootstrap primitives. Never expose these through an HTTP route. */
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MAX_FILES = 30000;

export function archivePath(value) {
  const path = value.replace(/^\.\//, '').replace(/\/$/, '');
  if (path === '' || path === '.') return '';
  if (
    path.length > 1024 ||
    /[\x00-\x1f\x7f\\]/.test(path) ||
    path.startsWith('/') ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('Tool archive contains an unsafe path.');
  return path;
}

/** The only redirects permitted are the official artifact CDN paths. */
export function artifactUrl(artifact, value) {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== '443')
  )
    throw new Error('Tool download requires an official HTTPS URL.');
  const initial = new URL(artifact.url);
  let allowed = url.origin === initial.origin && url.pathname === initial.pathname;
  if (initial.hostname === 'github.com')
    allowed ||=
      url.hostname === 'release-assets.githubusercontent.com' &&
      url.pathname.startsWith('/github-production-release-asset/');
  if (initial.hostname === 'builds.dotnet.microsoft.com')
    allowed ||=
      url.hostname === 'dotnetcli.blob.core.windows.net' && url.pathname === initial.pathname;
  if (initial.hostname === 'api.nuget.org')
    allowed ||=
      url.hostname === 'globalcdn.nuget.org' &&
      url.pathname === '/packages/' + initial.pathname.split('/').at(-1);
  if (
    !['github.com', 'codeload.github.com', 'builds.dotnet.microsoft.com', 'api.nuget.org'].includes(
      initial.hostname,
    ) ||
    !allowed
  )
    throw new Error('Tool download left its fixed official artifact origin.');
  return url;
}

export async function localDirectory(path, create = false) {
  const absolute = resolve(path);
  const parts = absolute.split('/').filter(Boolean);
  let current = '/';
  for (const part of parts) {
    current = join(current, part);
    if (create) {
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Tool cache paths must contain only real directories.');
  }
  const stat = await lstat(absolute);
  if ((stat.mode & 0o022) !== 0 || (process.getuid && stat.uid !== process.getuid()))
    throw new Error('Tool cache must be owned by the operator and not writable by other users.');
  return absolute;
}

export async function regularFile(path, maxBytes) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > maxBytes ||
      (stat.mode & 0o022) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error('Tool cache contains an unsafe or oversized regular file.');
    return { handle, stat };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function fileHash(path, maxBytes = 1024 ** 3) {
  const { handle, stat } = await regularFile(path, maxBytes);
  try {
    const hash = createHash('sha256');
    for await (const bytes of handle.createReadStream({ autoClose: false })) hash.update(bytes);
    const after = await handle.stat();
    if (
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs
    )
      throw new Error('Tool file changed while it was being verified.');
    return { sha256: hash.digest('hex'), bytes: stat.size, executable: Boolean(stat.mode & 0o111) };
  } finally {
    await handle.close();
  }
}

export async function inventoryTree(root, normalize = false) {
  const files = Object.create(null);
  let count = 0;
  let total = 0;
  async function walk(path) {
    for (const name of (await readdir(path)).sort()) {
      const absolute = join(path, name);
      const rel = archivePath(relative(root, absolute));
      if (++count > MAX_FILES) throw new Error('Tool cache has too many entries.');
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error('Tool cache must not contain symbolic links.');
      if (stat.isDirectory()) {
        if (normalize) await chmod(absolute, 0o700);
        await localDirectory(absolute);
        await walk(absolute);
      } else {
        if (!stat.isFile() || stat.nlink !== 1)
          throw new Error('Tool cache must contain only regular files and directories.');
        total += stat.size;
        if (total > 512 * 1024 ** 2) throw new Error('Prepared tool cache exceeds its size bound.');
        if (normalize) await chmod(absolute, stat.mode & 0o111 ? 0o700 : 0o600);
        if (rel !== 'provenance.json') files[rel] = await fileHash(absolute);
      }
    }
  }
  await walk(root);
  return files;
}

export async function downloadArtifact(artifact, destination, { signal, onProgress } = {}) {
  const timeout = AbortSignal.timeout(5 * 60 * 1000);
  const boundedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let url = artifactUrl(artifact, artifact.url);
  let response;
  for (let redirects = 0; redirects <= 3; redirects++) {
    response = await fetch(url, {
      redirect: 'manual',
      signal: boundedSignal,
      credentials: 'omit',
      headers: { Accept: 'application/octet-stream', 'Accept-Encoding': 'identity' },
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    await response.body?.cancel();
    if (redirects === 3) throw new Error('Tool download exceeded its redirect limit.');
    const location = response.headers.get('location');
    if (!location) throw new Error('Tool download returned a redirect without a destination.');
    url = artifactUrl(artifact, new URL(location, url));
  }
  if (!response.ok || !response.body) throw new Error('Official tool download failed.');
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > artifact.maxBytes)) {
    await response.body.cancel();
    throw new Error('Tool download exceeds its byte limit.');
  }
  const handle = await open(
    destination,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  const hash = createHash(artifact.algorithm);
  let bytes = 0;
  try {
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > artifact.maxBytes)
          return callback(new Error('Tool download exceeds its byte limit.'));
        hash.update(chunk);
        onProgress?.({
          stage: 'download',
          artifact: artifact.version,
          bytes,
          total: length ? Number(length) : null,
        });
        callback(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body),
      limiter,
      handle.createWriteStream({ autoClose: true }),
      {
        signal: boundedSignal,
      },
    );
    if (hash.digest(artifact.encoding || 'hex') !== artifact.hash)
      throw new Error('Official tool archive checksum does not match the pinned release.');
  } finally {
    await handle.close().catch(() => {});
  }
  return bytes;
}

export async function runTool(
  file,
  args,
  { cwd, env, signal, timeout = 180000, maxOutput = 8 * 1024 ** 2 } = {},
) {
  const boundedSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeout)])
    : AbortSignal.timeout(timeout);
  boundedSignal.throwIfAborted();
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, args, {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = [],
      errors = [];
    let size = 0,
      failure;
    const stop = (reason) => {
      failure ||= reason;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
    };
    const abort = () =>
      stop(new Error('Toolchain command was cancelled or exceeded its time limit.'));
    boundedSignal.addEventListener('abort', abort, { once: true });
    if (boundedSignal.aborted) abort();
    const receive = (target, bytes) => {
      size += bytes.length;
      if (size > maxOutput) stop(new Error('Toolchain command exceeded its output limit.'));
      else target.push(bytes);
    };
    child.stdout.on('data', (bytes) => receive(output, bytes));
    child.stderr.on('data', (bytes) => receive(errors, bytes));
    child.once('error', (error) => {
      failure = error;
    });
    child.once('close', (code) => {
      boundedSignal.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code !== 0)
        reject(
          new Error(
            `Pinned toolchain command failed with exit ${code}. ${Buffer.concat(errors).toString('utf8').slice(-1200)}`,
          ),
        );
      else resolvePromise(Buffer.concat(output).toString('utf8'));
    });
  });
}

/** Archives reach this function only after their complete pinned checksum passed. */
export async function extractArchive(artifact, archive, target, options = {}) {
  await mkdir(target, { mode: 0o700 });
  if (artifact.format === 'tar') {
    const listing = await runTool(
      'tar',
      [
        '--list',
        '--verbose',
        '--numeric-owner',
        '--gzip',
        '--file',
        archive,
        '--quoting-style=escape',
      ],
      options,
    );
    let expanded = 0,
      count = 0;
    for (const line of listing.trimEnd().split('\n')) {
      const entry =
        /^([d-])[rwxStTs-]{9}\s+\d+\/\d+\s+(\d+)\s+\d{4}-\d\d-\d\d\s+\d\d:\d\d\s+(.+)$/.exec(line);
      if (!entry || ++count > MAX_FILES)
        throw new Error('Tool archive contains an unsupported entry.');
      archivePath(entry[3]);
      expanded += Number(entry[2]);
      if (expanded > artifact.maxExpanded)
        throw new Error('Tool archive expands beyond its size limit.');
    }
    await runTool(
      'tar',
      [
        '--extract',
        '--gzip',
        '--file',
        archive,
        '--directory',
        target,
        '--no-same-owner',
        '--no-same-permissions',
        '--keep-old-files',
      ],
      options,
    );
  } else {
    const listing = await runTool('unzip', ['-Z', '-l', archive], options);
    const expected = [
      'Source2Viewer-CLI',
      'THIRD_PARTY_NOTICES.txt',
      'libSkiaSharp.so',
      'libspirv-cross.so',
    ];
    const entries = listing
      .split('\n')
      .map((line) =>
        /^-[rwxStTs-]{9}\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\d+\s+\S+\s+\S+\s+\S+\s+(.+)$/.exec(line),
      )
      .filter(Boolean);
    const names = entries.map((entry) => archivePath(entry[2]));
    if (names.length !== expected.length || expected.some((name) => !names.includes(name)))
      throw new Error('S2V archive does not contain its fixed release files.');
    if (entries.reduce((sum, entry) => sum + Number(entry[1]), 0) > artifact.maxExpanded)
      throw new Error('S2V archive expands beyond its size limit.');
    await runTool('unzip', ['-q', archive, '-d', target], options);
    let expanded = 0;
    for (const name of expected) {
      const stat = await lstat(join(target, name));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
        throw new Error('S2V archive contains an unsafe file type.');
      expanded += stat.size;
    }
    if (expanded > artifact.maxExpanded)
      throw new Error('S2V archive expands beyond its size limit.');
  }
}
