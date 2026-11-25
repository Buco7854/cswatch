import { cp, mkdir, mkdtemp, readFile, readdir, rm, statfs } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { brotliDecompressSync, inflateSync } from 'node:zlib';
import { validate } from '../../shared/native-world-format.mjs';
import { fileHashes, regular, readableDirectory, allocatedStorage } from './asset-storage.mjs';
import { prepareOverview } from './prepare-overview.mjs';
import { localDirectory } from './toolchain-security.mjs';
import { selectedMaps, selectedSteamManifest } from './steam-assets-plan.mjs';
import { runAssetProcess } from './asset-process.mjs';

// Built from the checksum-pinned astc-encoder 5.7.1 source in the assets image.
const astcenc = process.env.ASTCENC_PATH || '/opt/astcenc/astcenc';
const exportRoot = fileURLToPath(new URL('../cs2export/', import.meta.url));
const boundary = fileURLToPath(new URL('./bin/asset-network-deny', import.meta.url));
const MiB = 1024 ** 2;
const digest = (data) => createHash('sha256').update(data).digest('hex');
async function readBounded(path, max) {
  await regular(path, max);
  return readFile(path);
}
export async function validatePreparedMap(root, map, version, manifest) {
  selectedMaps([map]);
  const directory = join(root, map);
  await localDirectory(directory);
  const bytes = await readBounded(join(directory, 'map.json'), 16 * MiB);
  const index = validate(JSON.parse(bytes));
  if (
    index.map !== map ||
    !/^[1-9]\d{0,19}$/.test(index.sourceManifest) ||
    (manifest && index.sourceManifest !== manifest)
  )
    throw Error('Native source identity differs.');
  const expected = new Set(['map.json', 'map.json.br']);
  const matchBr = async (name, raw, record) => {
    const packed = await readBounded(join(directory, name + '.br'), raw.length);
    if (
      (record && (packed.length !== record.size || digest(packed) !== record.sha256)) ||
      !brotliDecompressSync(packed, { maxOutputLength: raw.length }).equals(raw)
    )
      throw Error('Invalid native Brotli representation.');
  };
  await matchBr('map.json', bytes);
  for (const [name, record] of Object.entries(index.files)) {
    expected.add(name);
    const raw = await readBounded(join(directory, name), record.size);
    if (raw.length !== record.size || digest(raw) !== record.sha256)
      throw Error('Invalid native payload digest.');
    if (
      record.packing &&
      inflateSync(raw, { maxOutputLength: record.decodedSize }).length !== record.decodedSize
    )
      throw Error('Invalid native decoded extent.');
    if (record.br) {
      expected.add(name + '.br');
      await matchBr(name, raw, record.br);
    }
  }
  const names = await readdir(directory);
  if (names.length !== expected.size || names.some((name) => !expected.has(name)))
    throw Error('Foreign native pack entry.');
  const overview = join(root, 'overviews', map);
  await localDirectory(overview);
  const calibration = JSON.parse(await readBounded(join(overview, 'overview.json'), 16384));
  const image = await readBounded(join(overview, 'overview.png'), 8 * MiB);
  if (
    calibration.map !== map ||
    calibration.assetVersion !== version ||
    calibration.referenceSize !== 1024 ||
    !Number.isFinite(calibration.origin?.x) ||
    !Number.isFinite(calibration.origin?.y) ||
    !(calibration.scale > 0) ||
    calibration.imageSha256 !== digest(image)
  )
    throw Error('Invalid prepared map overview.');
  return expected;
}

export async function installLocalWorld(options) {
  const maps = selectedMaps(options.maps);
  const manifest = selectedSteamManifest(options.manifest);
  const game = resolve(options.gameRoot),
    output = resolve(options.output);
  if (
    !manifest ||
    [output, resolve(options.cache)].some((path) => path === game || path.startsWith(game + '/'))
  )
    throw Error('Private staging must be outside the verified source.');
  await readableDirectory(game);
  await localDirectory(options.cache, true);
  await localDirectory(output, true);
  const dotnet = resolve(process.env.DOTNET_ROOT || '/opt/dotnet', 'dotnet');
  for (const map of maps) {
    const source = join(game, 'csgo', 'maps', map + '.vpk');
    const hashes = await fileHashes(source, ['sha1', 'sha256'], 4 * 1024 ** 3);
    const stat = await regular(source, 4 * 1024 ** 3);
    const expected = options.expectedMapFiles?.[map],
      approved = options.expectedMapHashes?.[map];
    if (
      (!expected && !approved) ||
      (expected && (expected.sha1 !== hashes.sha1 || stat.size !== expected.bytes)) ||
      (approved && approved !== hashes.sha256)
    )
      throw Object.assign(Error('Map differs from verified source.'), {
        code: 'SOURCE_MAP_MISMATCH',
      });
    await options.onSourceVerified?.({
      map,
      manifest,
      mapSha256: hashes.sha256,
      sha1: hashes.sha1,
      bytes: stat.size,
    });
    const version = options.assetVersion ?? 'steam-2347770-' + manifest;
    const scratch = await mkdtemp(join(options.cache, 'native-'));
    const sourceDir = join(scratch, 'source'),
      prepared = join(scratch, 'prepared'),
      stage = join(scratch, 'stage');
    const packed = join(prepared, map),
      home = join(scratch, 'home'),
      temporary = join(scratch, 'tmp');
    const guard = async () => {
      options.signal?.throwIfAborted();
      const disk = await statfs(scratch);
      if (
        disk.bavail * disk.bsize < 4 * 1024 ** 3 ||
        (await allocatedStorage(scratch)).physicalBytes > 3 * 1024 ** 3
      )
        throw Error('Native conversion storage budget exceeded.');
    };
    // Both children start under the same inherited network and filesystem policy.
    let step = 0;
    const execute = async (command, args, phase) => {
      if (phase) await options.onPhase?.(phase);
      await runAssetProcess(
        options.networkDeny || boundary,
        ['--write-root', scratch, '--', command, ...args],
        {
          cwd: scratch,
          home,
          temporary,
          signal: options.signal,
          storageGuard: guard,
          maxRss: 4 * 1024 ** 3,
          timeoutMs: 300000,
          log: join(options.cache, scratch.split('/').at(-1) + '-' + ++step + '.log'),
        },
      );
    };
    const exporter = join(exportRoot, 'bin', 'Release', 'net11.0', 'cs2export.dll');
    try {
      for (const path of [sourceDir, prepared, packed, stage, home, temporary])
        await mkdir(path, { mode: 0o700 });
      const started = Date.now();
      await execute(
        dotnet,
        [
          exporter,
          '--extract',
          '--game',
          game,
          '--map',
          map,
          '--manifest',
          manifest,
          '--sha256',
          hashes.sha256,
          '--out',
          sourceDir,
        ],
        'geometry',
      );
      await execute(
        process.execPath,
        [join(exportRoot, 'pack.mjs'), sourceDir, packed, stage],
        'desktop',
      );
      // Phone tier: lay out stacked images, then decode and encode one group at a time with the
      // pinned astcenc so scratch holds a single uncompressed group, then page.
      const plan = join(stage, 'astc-plan.json'),
        astcDir = join(stage, 'astc');
      // After desktop packing the phone stage reads only its planned texture payloads.
      const planned = new Set(
        JSON.parse(await readBounded(plan, 64 * MiB)).items.flatMap((item) =>
          item.levels.flatMap((level) => level.slices.map((slice) => slice.file)),
        ),
      );
      for (const name of await readdir(sourceDir))
        if (/^[0-9a-f]{64}\.bin$/.test(name) && !planned.has(name)) await rm(join(sourceDir, name));
      await execute(dotnet, [exporter, '--astc-inputs', plan, sourceDir, astcDir], 'mobile');
      const layout = JSON.parse(await readBounded(join(astcDir, 'layout.json'), 64 * MiB));
      for (const [index, group] of layout.groups.entries()) {
        if (group.name !== 'group-' + index || !/^[4568]$/.test(String(group.block[0])))
          throw Error('Invalid phone texture group.');
        await execute(dotnet, [exporter, '--astc-group', plan, sourceDir, astcDir, String(index)]);
        const input = join(astcDir, group.name);
        await execute(options.astcenc || astcenc, [
          group.srgb ? '-cs' : '-cl',
          input + '.tga',
          input + '.astc',
          group.block.join('x'),
          '-medium',
          '-silent',
        ]);
        await rm(input + '.tga');
      }
      await execute(process.execPath, [join(exportRoot, 'finish.mjs'), packed, stage]);
      await rm(stage, { recursive: true, force: true });
      await options.onExported?.({ map, ms: Date.now() - started });
      await prepareOverview({
        image: join(sourceDir, 'overview.png'),
        overview: join(sourceDir, 'overview.txt'),
        map,
        version,
        source: 'Valve CS2 Steam depot 2347770 manifest ' + manifest,
        output: prepared,
      });
      await validatePreparedMap(prepared, map, version, manifest);
      await options.onPhase?.('publishing');
      // The supervisor owns this private generation until its exclusive final rename.
      await mkdir(join(output, 'overviews'), { recursive: true });
      await cp(packed, join(output, map), { recursive: true, force: false, errorOnExist: true });
      await cp(join(prepared, 'overviews', map), join(output, 'overviews', map), {
        recursive: true,
        force: false,
        errorOnExist: true,
      });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
}
