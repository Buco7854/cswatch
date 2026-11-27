/** Fixed official weapon/HUD SVG resources, rasterized only inside conversion confinement. */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { retainStageLogs } from './presentation-diagnostics.mjs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { checkedBatch, parseSteamListing, selectedSteamManifest } from './steam-assets-plan.mjs';
import { prepareToolchain } from './prepare-toolchain.mjs';
import { localDirectory } from './toolchain-security.mjs';
import { checkFreeReserve, checkStorage, fileHash, regular } from './asset-storage.mjs';
import { readVpkDirectory } from './source2-dependencies.mjs';
import { runAssetProcess } from './install-steam-assets.mjs';
import { markSteamRateLimit } from './official-map-inventory.mjs';

const registry = JSON.parse(
  await readFile(new URL('../../shared/equipment-icons.json', import.meta.url), 'utf8'),
);
const MiB = 1024 ** 2;
export const equipmentIconSources = Object.freeze(
  Object.fromEntries(
    Object.entries(registry.items).map(([id, filename]) => [
      id,
      {
        filename,
        resource:
          `panorama/images/${filename.includes('/') ? filename : 'icons/equipment/' + filename}`.replace(
            /\.svg$/,
            '.vsvg_c',
          ),
      },
    ]),
  ),
);
if (
  registry.schema !== 1 ||
  Object.keys(equipmentIconSources).length > 128 ||
  Object.entries(equipmentIconSources).some(
    ([id, row]) =>
      !/^[a-z0-9]{1,40}$/.test(id) ||
      !/^panorama\/images\/(?:(?:icons\/equipment|icons\/ui|hud\/teamcounter|hud\/deathnotice|map_icons)\/)[a-z0-9_-]{1,80}\.vsvg_c$/.test(
        row.resource,
      ),
  )
)
  throw Error('Invalid fixed equipment icon sources.');

export async function installEquipmentIcons(options, adapters = {}) {
  const manifest = selectedSteamManifest(options.manifest);
  if (
    !options.cache ||
    !options.output ||
    !options.networkDeny ||
    Boolean(options.s2v) !== Boolean(options.downloader)
  )
    throw Error('Fixed source/cache/output and required icon confinement are needed.');
  const cache = resolve(options.cache),
    output = resolve(options.output);
  if (cache === output || cache.startsWith(output + '/') || output.startsWith(cache + '/'))
    throw Error('Keep private icon sources separate from output.');
  await localDirectory(cache, true);
  await localDirectory(output);
  await regular(options.networkDeny, MiB);
  const probe = spawnSync(options.networkDeny, ['--check'], { stdio: 'ignore', timeout: 5000 });
  if (probe.error || probe.status !== 0)
    throw Error('Required icon conversion confinement is unavailable.');
  const storage = adapters.storage || checkStorage,
    reserve = adapters.reserve || checkFreeReserve;
  await storage(cache, output);
  const tools = options.s2v
    ? { s2v: resolve(options.s2v), downloader: resolve(options.downloader) }
    : await (adapters.prepareToolchain || prepareToolchain)({
        cache: options.toolchainCache || join(cache, 'tools'),
        signal: options.signal,
      });
  for (const tool of [tools.s2v, tools.downloader]) await regular(tool, 512 * MiB);
  const root = await mkdtemp(join(cache, 'icon-install-')),
    game = join(cache, 'steam'),
    home = join(root, 'home'),
    tmp = join(root, 'tmp'),
    pins = join(root, 'manifests'),
    conversion = join(root, 'conversion'),
    decoded = join(conversion, 'decoded'),
    nativeHome = join(conversion, 'home'),
    nativeTmp = join(conversion, 'tmp'),
    svg = join(conversion, 'svg');
  await options.registerStage?.(root);
  for (const path of [game, home, tmp, pins, conversion, decoded, nativeHome, nativeTmp, svg])
    await localDirectory(path, true);
  let sequence = 0,
    step = 'start',
    conversionStarted = false;
  const run = async (command, args, label, native = false) => {
    step = label;
    if (native && !conversionStarted) {
      conversionStarted = true;
      await options.onConverting?.();
    }
    return (adapters.run || runAssetProcess)(
      native ? options.networkDeny : command,
      native ? ['--write-root', conversion, '--write-root', output, '--', command, ...args] : args,
      {
        cwd: root,
        home: native ? nativeHome : home,
        temporary: native ? nativeTmp : tmp,
        conversionWriteRoots: native ? [conversion, output] : undefined,
        signal: options.signal,
        timeoutMs: 120000,
        log: join(root, `${++sequence}-${label}.log`),
        storageGuard: () => reserve(cache, output),
      },
    );
  };
  const steam = async (args, label) => {
    try {
      return await run(tools.downloader, args, label);
    } catch (error) {
      markSteamRateLimit(error);
      throw error;
    }
  };
  const download = async (rows) => {
    const records = checkedBatch(rows),
      bytes = records.reduce((sum, row) => sum + row.bytes, 0);
    if (!records.length) return;
    if (bytes > 48 * MiB) throw Error('Fixed icon selection exceeds48MiB.');
    await storage(cache, output, bytes + 64 * MiB);
    await writeFile(
      join(root, 'files.json'),
      JSON.stringify({ 2347770: records.map((row) => row.selector) }),
      { mode: 0o600 },
    );
    await steam(
      ['track', '730', '--anonymous', '--output', game, '--manifests', pins, '--save-manifest'],
      'icon-download',
    );
  };
  try {
    await writeFile(
      join(pins, 'manifest_2347770.txt'),
      `Content Manifest for Depot 2347770\n\nManifest ID / date     : ${manifest} / fixed native equipment artwork\n`,
      { flag: 'wx', mode: 0o600 },
    );
    const packageFile = 'game/csgo/pak01_dir.vpk';
    const listing = await steam(
      ['ls', '730', `2347770:${manifest}`, '--anonymous', '--', packageFile],
      'icon-index-list',
    );
    const plan = parseSteamListing(listing.stdout, [packageFile]);
    if (plan.manifest !== manifest)
      throw Object.assign(Error('Icon source manifest differs.'), { code: 'SOURCE_MAP_MISMATCH' });
    await download(plan.files.map((row) => ({ selector: row.file, bytes: row.bytes })));
    for (const row of plan.files)
      if ((await fileHash(join(game, row.file), 'sha1', row.bytes)) !== row.sha1)
        throw Object.assign(Error('Icon index hash differs.'), { code: 'SOURCE_MAP_MISMATCH' });
    const index = await (adapters.index || readVpkDirectory)(join(game, packageFile));
    const supported = Object.entries(equipmentIconSources).filter(([, source]) => {
      const row = index.entries.get(source.resource);
      return row && row.length + row.preloadBytes <= 256 * 1024;
    });
    if (!supported.length) throw Error('No fixed icon resources are available.');
    await download(
      supported.map(([, source]) => {
        const row = index.entries.get(source.resource);
        return {
          selector: `${packageFile}:${source.resource}`,
          bytes: row.length + row.preloadBytes,
        };
      }),
    );
    const resources = [];
    for (const [id, source] of supported) {
      options.onProgress?.({ stage: 'icons', item: id });
      const bytes = await index.readEntry(source.resource);
      if (!bytes || bytes.length > 256 * 1024)
        throw Object.assign(Error('Native icon CRC/size validation failed.'), {
          code: 'SOURCE_MAP_MISMATCH',
        });
      const input = join(conversion, `${id}.vsvg_c`);
      await writeFile(input, bytes, { flag: 'wx', mode: 0o600 });
      await run(
        tools.s2v,
        ['-i', input, '--decompile', '--output', decoded, '--quiet'],
        'icon-decode',
        true,
      );
      const produced = join(decoded, `${id}.svg`);
      await regular(produced, 256 * 1024);
      const destination = join(svg, source.filename);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, await readFile(produced), { flag: 'wx', mode: 0o600 });
      resources.push({
        id,
        resource: source.resource,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bytes: bytes.length,
      });
    }
    await run(
      process.execPath,
      [
        fileURLToPath(new URL('./prepare-equipment.mjs', import.meta.url)),
        '--input',
        svg,
        '--output',
        join(output, 'equipment'),
        '--version',
        `steam-2347770-${manifest}`,
        '--source',
        `Fixed official app730/depot2347770 manifest${manifest}`,
        '--confined',
        'true',
      ],
      'icon-rasterize',
      true,
    );
    const proof = join(output, 'equipment', 'provenance.json');
    await regular(proof, MiB, 2);
    const prepared = JSON.parse(await readFile(proof, 'utf8'));
    const ready = Object.keys(prepared.items);
    const provenance = {
      schemaVersion: 1,
      appId: 730,
      depotId: 2347770,
      manifest,
      index: plan.files,
      resources,
      unsupported: Object.keys(equipmentIconSources).filter((id) => !ready.includes(id)),
    };
    await writeFile(
      join(output, 'equipment', 'source.provenance.json'),
      JSON.stringify(provenance) + '\n',
      { flag: 'wx', mode: 0o644 },
    );
    return { count: ready.length, unsupported: provenance.unsupported };
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : Error(String(error)), { step });
  } finally {
    // A journaled caller removes the stage itself, after keeping a failure's logs.
    if (options.keepLogs) await retainStageLogs(root);
    else await rm(root, { recursive: true, force: true });
  }
}
