#!/usr/bin/env node
/** Pinned Linux operator tools. No Steam connections, accounts or application runtime dependencies. */
import { lstat, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { toolchainPins } from './toolchain-pins.mjs';
import {
  downloadArtifact,
  extractArchive,
  inventoryTree,
  localDirectory,
  regularFile,
  runTool,
} from './toolchain-security.mjs';

export const toolchainLock = createHash('sha256')
  .update(JSON.stringify(toolchainPins))
  .digest('hex');
export const toolchainDirectory = `linux-x64-${toolchainLock.slice(0, 20)}`;
export const toolchainPreparationLimits = Object.freeze({ timeoutMs: 20 * 60 * 1000 });
const sourceName = 'SteamFileDownloader-' + toolchainPins.source.version;
const required = [
  's2v/Source2Viewer-CLI',
  's2v/libSkiaSharp.so',
  's2v/libspirv-cross.so',
  'runtime/dotnet',
  `source/${sourceName}/bin/SteamFileDownloader`,
  `source/${sourceName}/bin/SteamFileDownloader.dll`,
  'SteamFileDownloader',
];
const executable = new Set([required[0], required[3], required[4], required[6]]);

/** NuGet's normalized content hash differs from the signed archive's raw byte hash. */
export function assertPackageLock(libraries) {
  if (!libraries || typeof libraries !== 'object' || Array.isArray(libraries))
    throw new Error('Restored tool dependencies have no valid package inventory.');
  const packages = Object.entries(libraries).filter(([, value]) => value?.type === 'package');
  if (packages.length !== toolchainPins.packages.length)
    throw new Error('Restored tool dependencies differ from the locked packages.');
  for (const [name, value] of packages) {
    const pin = toolchainPins.packages.find(
      (item) => `${item.name}/${item.version}` === name.toLowerCase(),
    );
    if (!pin || value.sha512 !== pin.contentHash)
      throw new Error('Restored tool package content differs from its verified lock.');
  }
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function result(directory, provenance) {
  return {
    s2v: join(directory, 's2v/Source2Viewer-CLI'),
    downloader: join(directory, 'SteamFileDownloader'),
    provenance,
  };
}

export async function verifyToolchain(directory) {
  await localDirectory(directory);
  const { handle } = await regularFile(join(directory, 'provenance.json'), 4 * 1024 ** 2);
  let provenance;
  try {
    provenance = JSON.parse(await handle.readFile('utf8'));
  } finally {
    await handle.close();
  }
  if (
    provenance?.format !== 1 ||
    provenance.platform !== 'linux' ||
    provenance.arch !== 'x64' ||
    provenance.lock !== toolchainLock ||
    JSON.stringify(provenance.pins) !== JSON.stringify(toolchainPins) ||
    !provenance.files ||
    Array.isArray(provenance.files)
  )
    throw new Error('Tool cache provenance does not match the locked releases.');
  const files = await inventoryTree(directory);
  if (JSON.stringify(files) !== JSON.stringify(provenance.files))
    throw new Error('Tool cache is corrupt or changed. Refusing to execute cached tools.');
  for (const path of required)
    if (!files[path] || (executable.has(path) && !files[path].executable))
      throw new Error('Tool cache is missing a required executable or library.');
  return result(directory, provenance);
}

/** Only cache location, cancellation and progress are configurable; upstream URLs are fixed. */
export async function prepareToolchain({ cache, signal, onProgress } = {}) {
  if (process.platform !== 'linux' || process.arch !== 'x64')
    throw new Error('Automatic operator tools currently support Linux x64 only.');
  if (typeof cache !== 'string' || !cache || cache.includes('\0') || cache.length > 4096)
    throw new Error('A dedicated operator tool cache directory is required.');
  if (signal !== undefined && !(signal instanceof AbortSignal))
    throw new Error('Invalid cancellation signal.');
  if (onProgress !== undefined && typeof onProgress !== 'function')
    throw new Error('Invalid progress callback.');
  signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(toolchainPreparationLimits.timeoutMs);
  signal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const root = await localDirectory(cache, true);
  const destination = join(root, toolchainDirectory);
  if (await exists(destination)) {
    const cached = await verifyToolchain(destination);
    onProgress?.({ stage: 'cached' });
    return cached;
  }
  const lock = join(root, '.' + toolchainDirectory + '.lock');
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if (error.code === 'EEXIST')
      throw new Error(
        'Tool cache is locked by another preparation. Inspect the operator cache before removing a stale lock.',
      );
    throw error;
  }
  let staging;
  try {
    if (await exists(destination)) return await verifyToolchain(destination);
    staging = await mkdtemp(join(root, '.toolchain-'));
    const archives = join(staging, 'archives');
    await mkdir(archives, { mode: 0o700 });
    const tmp = join(staging, 'tmp');
    await mkdir(tmp, { mode: 0o700 });
    // SDK/NuGet and single-file tools also consult HOME independently of CLI_HOME.
    // Never let their first-run writes fall back to the image's read-only user home.
    const toolHome = join(staging, 'dotnet-home');
    await mkdir(toolHome, { mode: 0o700 });
    const environment = {
      PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
      LANG: 'C.UTF-8',
      LC_ALL: 'C',
      TZ: 'UTC',
      TMPDIR: tmp,
      HOME: toolHome,
      DOTNET_ROOT: join(staging, 'runtime'),
      DOTNET_CLI_HOME: toolHome,
      DOTNET_BUNDLE_EXTRACT_BASE_DIR: join(toolHome, 'bundles'),
      DOTNET_CLI_TELEMETRY_OPTOUT: '1',
      DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
      DOTNET_NOLOGO: '1',
      DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE: 'true',
      DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: '1',
      NUGET_PACKAGES: join(staging, 'nuget'),
      NUGET_XMLDOC_MODE: 'skip',
    };
    const options = { signal, onProgress };
    const command = { signal, env: environment, timeout: 180000 };
    for (const [name, artifact, target] of [
      ['s2v', toolchainPins.s2v, 's2v'],
      ['sdk', toolchainPins.sdk, 'runtime'],
      ['source', toolchainPins.source, 'source'],
    ]) {
      const archive = join(archives, name + (artifact.format === 'zip' ? '.zip' : '.tar.gz'));
      await downloadArtifact(artifact, archive, options);
      onProgress?.({ stage: 'extract', artifact: name });
      await extractArchive(artifact, archive, join(staging, target), command);
      await rm(archive);
    }
    const feed = join(staging, 'feed');
    await mkdir(feed, { mode: 0o700 });
    for (const artifact of toolchainPins.packages)
      await downloadArtifact(
        artifact,
        join(feed, `${artifact.name}.${artifact.version}.nupkg`),
        options,
      );
    const nugetConfig = join(staging, 'NuGet.Config');
    const escape = (value) =>
      value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
    await writeFile(
      nugetConfig,
      `<configuration><packageSources><clear/><add key="verified-local" value="${escape(feed)}"/></packageSources><auditSources><clear/></auditSources></configuration>`,
      { mode: 0o600, flag: 'wx' },
    );
    const sdk = join(staging, 'runtime/dotnet');
    const source = join(staging, 'source', sourceName);
    const project = join(source, 'SteamFileDownloader.csproj');
    onProgress?.({ stage: 'build', artifact: 'restore' });
    await runTool(
      sdk,
      [
        'restore',
        project,
        '--configfile',
        nugetConfig,
        '--disable-parallel',
        '-p:PublishAot=false',
        '-p:NuGetAudit=false',
      ],
      { ...command, cwd: source },
    );
    const restored = await regularFile(join(source, 'obj/project.assets.json'), 8 * 1024 ** 2);
    try {
      assertPackageLock(JSON.parse(await restored.handle.readFile('utf8')).libraries);
    } finally {
      await restored.handle.close();
    }
    onProgress?.({ stage: 'build', artifact: 'compile' });
    await runTool(
      sdk,
      [
        'build',
        project,
        '--configuration',
        'Release',
        '--no-restore',
        '--disable-build-servers',
        '-m:1',
        '-p:PublishAot=false',
        '-p:ContinuousIntegrationBuild=true',
        '-p:UseSharedCompilation=false',
        '-p:SourceRevisionId=' + toolchainPins.source.version,
      ],
      { ...command, cwd: source, timeout: 10 * 60000 },
    );
    const wrapper = `#!/bin/sh\nTOOLCHAIN_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexport DOTNET_ROOT="$TOOLCHAIN_DIR/runtime"\nexport DOTNET_CLI_TELEMETRY_OPTOUT=1\nexec "$TOOLCHAIN_DIR/source/${sourceName}/bin/SteamFileDownloader" "$@"\n`;
    await writeFile(join(staging, 'SteamFileDownloader'), wrapper, { mode: 0o700, flag: 'wx' });
    onProgress?.({ stage: 'build', artifact: 'versions' });
    const versions = {
      s2v: (await runTool(join(staging, required[0]), ['--version'], command)).trim(),
      downloader: (
        await runTool(join(staging, 'SteamFileDownloader'), ['--version'], command)
      ).trim(),
    };
    if (!versions.s2v.includes('21.1') || !versions.downloader.includes('aeaae99'))
      throw new Error('Prepared tools do not report their pinned versions.');
    for (const name of [
      'archives',
      'feed',
      'nuget',
      'dotnet-home',
      'tmp',
      'NuGet.Config',
      `source/${sourceName}/obj`,
      'runtime/sdk',
      'runtime/packs',
      'runtime/templates',
      'runtime/sdk-manifests',
      'runtime/metadata',
      'runtime/shared/Microsoft.AspNetCore.App',
    ])
      await rm(join(staging, name), { recursive: true, force: true });
    const provenance = {
      format: 1,
      platform: 'linux',
      arch: 'x64',
      lock: toolchainLock,
      pins: toolchainPins,
      versions,
      build: {
        configuration: 'Release',
        publishAot: false,
        steamContacted: false,
        localVerifiedNugetFeed: true,
        dependencyContentHashesVerified: true,
      },
      files: await inventoryTree(staging, true),
    };
    await writeFile(join(staging, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n', {
      mode: 0o600,
      flag: 'wx',
    });
    signal?.throwIfAborted();
    await localDirectory(root);
    if (await exists(destination))
      throw new Error('Tool cache appeared during preparation. Refusing to replace it.');
    await rename(staging, destination);
    staging = undefined;
    const prepared = await verifyToolchain(destination);
    onProgress?.({ stage: 'ready' });
    return prepared;
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
    await rm(lock, { recursive: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { cache: { type: 'string' } }, strict: true });
    const tools = await prepareToolchain({ cache: values.cache });
    console.log(
      JSON.stringify({
        s2v: tools.s2v,
        downloader: tools.downloader,
        provenance: join(resolve(values.cache), toolchainDirectory, 'provenance.json'),
      }),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
