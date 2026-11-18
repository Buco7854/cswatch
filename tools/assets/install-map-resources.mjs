/** Shared bounded resource closure and S2V export for ordinary and sky-prefab maps. */
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { exists } from './asset-storage.mjs';
import { preflightMaterialShaders } from './shader-preflight.mjs';
import { createSourceImageCompactor } from './source-image-compactor.mjs';
import {
  steamAssetLimits,
  assertExportableUnknowns,
  dependencyBatch,
  missingShaderNames,
  shaderBatch,
} from './steam-assets-plan.mjs';

export async function resolveMapResources({
  map,
  packageFile,
  game,
  required = [],
  skyMap,
  scan,
  download,
  progress,
  label,
}) {
  let closure;
  for (let wave = 0; wave <= steamAssetLimits.waves; wave++) {
    progress('dependency-scan', { map, wave, part: label });
    closure = await scan({
      mapVpk: join(game, packageFile),
      csgoVpk: join(game, 'game/csgo/pak01_dir.vpk'),
      coreVpk: join(game, 'game/core/pak01_dir.vpk'),
      looseRoots: [join(game, 'game/csgo'), join(game, 'game/core')],
      required,
    });
    assertExportableUnknowns(closure.unknown, map, { skyMap });
    const records = dependencyBatch(closure, map, { packageFile });
    if (!records.length) return closure;
    if (wave === steamAssetLimits.waves)
      throw new Error('Source 2 dependencies did not converge within eight selective waves.');
    await download(records, `${label}-dependencies-${wave + 1}`);
  }
  throw new Error('Source 2 dependency scan did not complete.');
}

export async function exportMapGltf({
  map,
  packageFile,
  resource,
  game,
  stage,
  label,
  closure,
  s2v,
  execute,
  download,
  shaderIndexes,
  storage,
  index,
  onShaderPreflight,
  onSourceImages,
}) {
  const shaderPreflight = await preflightMaterialShaders({
    closure,
    game,
    packageFile,
    stage,
    label,
    s2v,
    execute,
    download,
    shaderIndexes,
    index,
  });
  await onShaderPreflight?.(shaderPreflight);
  for (let attempt = 0; attempt < 3; attempt++) {
    const exportRoot = join(stage, `${label}-export-${attempt}`);
    await mkdir(exportRoot);
    const source = join(exportRoot, 'scene.gltf');
    await storage(256 * 1024 ** 2);
    const outputWork = new AbortController();
    const images = await createSourceImageCompactor({
      root: exportRoot,
      signal: outputWork.signal,
    });
    let result, imageReport, failure;
    try {
      result = await execute(
        s2v,
        [
          '-i',
          join(game, packageFile),
          '--game',
          join(game, 'game/csgo'),
          '--vpk_filepath',
          resource,
          '--output',
          source,
          '--gltf_export_format',
          'gltf',
          '--gltf_textures_adapt',
        ],
        `${label}-export-${attempt}`,
        {
          allowFailure: true,
          onOutputAbort: () => outputWork.abort(),
          onOutputLine: (line) =>
            /^--- \[.*\] Exported texture:/.test(line) ? images.consume(line) : undefined,
        },
      );
    } catch (error) {
      failure = error;
    }
    try {
      imageReport = await images.finish();
    } catch (error) {
      failure ||= error;
    }
    if (failure) throw failure;
    await onSourceImages?.({ part: label, attempt, report: imageReport });
    const text = result.stdout + result.stderr;
    const missing = missingShaderNames(text);
    if (missing.length) {
      if (attempt === 2)
        throw new Error('Required shaders remain missing after bounded selective retries.');
      await download(shaderBatch(missing, shaderIndexes), `${label}-shaders-${attempt + 1}`);
      await rm(exportRoot, { recursive: true, force: true });
      continue;
    }
    const errors = text
      .split(/\r?\n/)
      .filter(
        (line) =>
          /(?:Failed to|Could not|Unable to|Exception|Error:)/i.test(line) &&
          !closure.unknown.some((resource) => line.includes(resource)),
      );
    if (result.code !== 0 || errors.length || !(await exists(source)))
      throw new Error(
        'S2V could not export the real map and required materials. Inspect the private export log.',
      );
    return source;
  }
  throw new Error(`S2V export did not complete for ${map}.`);
}
