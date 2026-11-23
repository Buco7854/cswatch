/** Trusted operator orchestration for exact selected-map sky resources. */
import { constants } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resourcePath } from './source2-dependencies.mjs';
import { exists, fileHash, regular } from './asset-storage.mjs';
import {
  STEAM_APP,
  STEAM_DEPOT,
  parseSteamListing,
  skyPrefabPackage,
  steamAssetLimits,
} from './steam-assets-plan.mjs';
import { exportMapGltf, resolveMapResources } from './install-map-resources.mjs';
import { createHash } from 'node:crypto';
import { inspectMapGrade, inspectSunShadowChannel } from './environment-metadata.mjs';
import {
  maxPostProcessBytes,
  maxPostProcessDumpBytes,
  prepareMapGrade,
} from './prepare-map-grade.mjs';
import { cleanupSourceExports } from './cleanup-source-exports.mjs';

const prepareScript = fileURLToPath(
  new URL('./prepare-installed-environment.mjs', import.meta.url),
);
const entityBytes = 4 * 1024 ** 2;
const totalEntityBytes = 16 * 1024 ** 2;
const faces = ['rt', 'lf', 'bk', 'ft', 'up', 'dn'];

function compiledPath(value, extension) {
  const path = resourcePath(value, { compiled: true });
  if (!/^[a-z0-9_./-]+$/.test(path) || !path.startsWith('materials/') || !path.endsWith(extension))
    throw new Error('Environment resource must be an exact local compiled material or texture.');
  return path;
}

async function boundedText(path, maximum) {
  await regular(path, maximum);
  const text = await readFile(path, {
    encoding: 'utf8',
    flag: constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  });
  if (Buffer.byteLength(text) > maximum || text.includes('\0'))
    throw new Error('Environment metadata exceeds its bounded text format.');
  return text;
}

export async function inspectInstalledEnvironment(context, adapters = {}) {
  const {
    map,
    game,
    stage,
    assetVersion,
    manifest,
    source,
    s2v,
    downloader,
    execute,
    download,
    permitPrefab,
    index,
    scan,
    shaderIndexes,
    progress,
    storage,
    onShaderPreflight,
    onSourceImages,
  } = context;
  const module = adapters.module || (await import('./prepare-environment.mjs'));
  const mainPackage = `game/csgo/maps/${map}.vpk`;
  const packageIndexes = new Map();
  const packageIndex = async (file) => {
    if (!packageIndexes.has(file)) packageIndexes.set(file, await index(join(game, file)));
    return packageIndexes.get(file);
  };
  const entityTexts = async (file, prefix, label) => {
    const entries = [...(await packageIndex(file)).entries.keys()]
      .filter((entry) => entry.startsWith(`${prefix}/entities/`) && entry.endsWith('.vents_c'))
      .sort();
    if (
      !entries.length ||
      entries.length > 64 ||
      entries.some((entry) => resourcePath(entry) !== entry || !/^[a-z0-9_./#-]+$/.test(entry))
    )
      throw new Error('Map environment requires a bounded exact entity-lump list.');
    const output = join(stage, `${label}-entity-source`);
    await mkdir(output);
    await execute(
      s2v,
      ['-i', join(game, file), '-f', entries.join(','), '--vpk_decompile', '-o', output + '/'],
      `${label}-entities`,
    );
    const result = [];
    let total = 0;
    for (const entry of entries) {
      const text = await boundedText(join(output, entry.slice(0, -2)), entityBytes);
      total += Buffer.byteLength(text);
      if (total > totalEntityBytes)
        throw new Error('Map entity metadata exceeds the aggregate limit.');
      result.push(text);
    }
    return result;
  };
  const mainEntities = await entityTexts(mainPackage, `maps/${map}`, map);
  const configuration = module.inspectMapEnvironment(mainEntities);
  const prefab = configuration.skyMap ? skyPrefabPackage(map, configuration.skyMap) : null;
  const material =
    configuration.skyMaterial == null ? null : compiledPath(configuration.skyMaterial, '.vmat_c');
  if (prefab) permitPrefab(prefab.file);
  async function postProcessing() {
    try {
      const authored = inspectMapGrade(mainEntities);
      if (!authored) return;
      for (const file of [
        mainPackage,
        ...(prefab ? [prefab.file] : []),
        'game/csgo/pak01_dir.vpk',
        'game/core/pak01_dir.vpk',
      ]) {
        const bank = await packageIndex(file);
        const entry = bank.entries.get(authored.resource);
        if (!entry) continue;
        const size = entry.length + entry.preloadBytes;
        if (!Number.isSafeInteger(size) || size < 1 || size > maxPostProcessBytes) return;
        let payload = await bank.readEntry(authored.resource);
        if (!payload) {
          await download(
            [{ selector: `${file}:${authored.resource}`, bytes: size }],
            `${map}-post-processing`,
          );
          const refreshed = await index(join(game, file));
          payload = await refreshed.readEntry(authored.resource);
        }
        if (payload?.length !== size) return;
        const compiled = join(stage, 'authored.vpost_c');
        await writeFile(compiled, payload, { flag: 'wx', mode: 0o600 });
        const { stdout: data } = await execute(
          s2v,
          ['-i', compiled, '--block', 'DATA'],
          `${map}-post-data`,
        );
        if (Buffer.byteLength(data) > maxPostProcessDumpBytes) return;
        prepareMapGrade(authored, data);
        return { data, sha256: createHash('sha256').update(payload).digest('hex') };
      }
    } catch {
      // Missing, unavailable or unsupported authored post-processing is optional.
      // Later required stages still observe installation cancellation/storage failure.
    }
  }

  return {
    skyMap: configuration.skyMap,
    required: material === null ? [] : [material],
    configuration,
    sunChannel: inspectSunShadowChannel(mainEntities),
    async prepare(mainGltf, output) {
      let skyEntities, camera, skyGltf, closure;
      if (prefab) {
        const listed = await execute(
          downloader,
          ['ls', STEAM_APP, `${STEAM_DEPOT}:${manifest}`, '--anonymous', '--', prefab.file],
          `${map}-sky-manifest`,
          { timeoutMs: 120000 },
        );
        const plan = parseSteamListing(listed.stdout, [prefab.file]);
        if (plan.manifest !== manifest)
          throw new Error('Sky prefab listing does not match the pinned map manifest.');
        await download(
          plan.files.map((entry) => ({ selector: entry.file, bytes: entry.bytes })),
          `${map}-sky-selected-file`,
        );
        if (
          (await fileHash(join(game, prefab.file), 'sha1', plan.files[0].bytes)) !==
          plan.files[0].sha1
        )
          throw new Error('Sky prefab failed its pinned manifest hash check.');
        skyEntities = await entityTexts(prefab.file, prefab.resource.slice(0, -7), `${map}-sky`);
        camera = module.inspectSkyCamera(skyEntities);
      }
      const skyMaterial = camera?.skyEnvironment?.skyMaterial ?? configuration.skyMaterial;
      const effectiveMaterial = skyMaterial ? compiledPath(skyMaterial, '.vmat_c') : null;
      if (prefab) {
        closure = await resolveMapResources({
          map,
          packageFile: prefab.file,
          game,
          skyMap: configuration.skyMap,
          scan,
          download,
          progress,
          label: `${map}-sky`,
          required: effectiveMaterial ? [effectiveMaterial] : [],
        });
        skyGltf = await exportMapGltf({
          map,
          packageFile: prefab.file,
          resource: prefab.resource,
          game,
          stage,
          label: `${map}-sky`,
          closure,
          s2v,
          execute,
          download,
          shaderIndexes,
          storage,
          index,
          onShaderPreflight,
          onSourceImages,
        });
      }
      let materialData, skyFaces;
      if (effectiveMaterial) {
        const owner = async (resource) => {
          for (const group of ['csgo', 'core']) {
            const loose = join(game, 'game', group, resource);
            if (await exists(loose)) {
              await regular(loose, 128 * 1024 ** 2);
              return ['-i', loose];
            }
          }
          for (const file of [
            mainPackage,
            ...(prefab ? [prefab.file] : []),
            'game/csgo/pak01_dir.vpk',
            'game/core/pak01_dir.vpk',
          ])
            if ((await packageIndex(file)).entries.has(resource))
              return ['-i', join(game, file), '--vpk_filepath', resource];
          throw new Error('Required sky resource has no verified local package owner.');
        };
        const dumped = await execute(
          s2v,
          [...(await owner(effectiveMaterial)), '--block', 'DATA'],
          `${map}-sky-material`,
        );
        if (Buffer.byteLength(dumped.stdout) > 1024 * 1024)
          throw new Error('Sky material metadata exceeds its limit.');
        materialData = dumped.stdout;
        const parsedMaterial = module.inspectSkyMaterial(materialData);
        const texture = compiledPath(parsedMaterial.texture, '.vtex_c');
        const faceOutput = join(stage, 'sky-face-source');
        await mkdir(faceOutput);
        await execute(
          s2v,
          [
            ...(await owner(texture)),
            '--decompile',
            '--texture_decode_flags',
            'ForceLDR',
            '--output',
            faceOutput,
            '--quiet',
          ],
          `${map}-sky-faces`,
        );
        // Package extraction preserves the resource directory below --output.
        // The validated exact VPK key supplies the only permitted face prefix.
        const stem = texture.slice(0, -'.vtex_c'.length);
        skyFaces = Object.fromEntries(
          faces.map((face) => [face, join(faceOutput, `${stem}_${face}.png`)]),
        );
        for (const path of Object.values(skyFaces)) await regular(path, 8 * 1024 ** 2, 57);
      }
      const gradeInput = await postProcessing();
      const config = {
        map,
        assetVersion,
        source,
        mainGltf,
        skyGltf,
        mainEntities,
        skyEntities,
        materialData,
        skyFaces,
        ...(gradeInput ? { gradeInput } : {}),
        output,
      };
      const configPath = join(stage, 'environment-prepare.json');
      const resultPath = join(stage, 'environment-result.json');
      const serialized = JSON.stringify(config);
      if (Buffer.byteLength(serialized) > 2 * totalEntityBytes + 2 * 1024 ** 2)
        throw new Error('Environment preparation configuration exceeds its limit.');
      await writeFile(configPath, serialized, { flag: 'wx', mode: 0o600 });
      if (adapters.prepare) await adapters.prepare(config, resultPath);
      else
        await execute(
          process.execPath,
          ['--expose-gc', prepareScript, '--config', configPath, '--result', resultPath],
          `${map}-environment-pack`,
        );
      const result = JSON.parse(await boundedText(resultPath, 1024 * 1024));
      if (
        typeof result.mergedInput !== 'string' ||
        !resolve(result.mergedInput).startsWith(resolve(stage) + '/')
      )
        throw new Error(
          'Merged environment input must remain inside its private installation stage.',
        );
      await regular(result.mergedInput, steamAssetLimits.modelBytes, 24);
      const cleaned = await cleanupSourceExports({
        stage,
        map,
        assetVersion,
        mergedInput: result.mergedInput,
        sources: skyGltf ? [mainGltf, skyGltf] : [mainGltf],
        provenance: join(output, 'environments', map, 'provenance.json'),
      });
      return {
        ...result,
        report: {
          ...result.report,
          sourceVpks: closure?.sources ?? [],
          unknownNonRenderingResources: closure?.unknown ?? [],
          selectedPrefab: prefab?.file ?? null,
          pinnedManifest: manifest,
          sourceExportsCleaned: cleaned,
        },
      };
    },
  };
}
