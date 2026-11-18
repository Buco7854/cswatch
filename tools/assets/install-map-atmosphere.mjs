/** Operator-only acquisition/preparation of explicitly supported material masks. */
import { mkdir, readFile, realpath, unlink, writeFile, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resourcePath } from './source2-dependencies.mjs';
import { exists, fileHash, regular } from './asset-storage.mjs';
import { verifyPreparedGlb } from './prepared-glb.mjs';
import { selectedMaps, checkedBatch } from './steam-assets-plan.mjs';

const wrapper = fileURLToPath(new URL('./prepare-installed-atmosphere.mjs', import.meta.url));
const maximum = 128 * 1024 ** 2;
function textureResource(value) {
  const resource = resourcePath(value, { compiled: true });
  if (!/^materials\/[a-z0-9_./-]+\.vtex_c$/.test(resource))
    throw new Error('Atmosphere textures must be exact local compiled material resources.');
  return resource;
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])]),
    );
  return value;
}

export async function prepareInstalledAtmosphere(context, adapters = {}) {
  const {
    map,
    input,
    stage,
    prepared,
    assetVersion,
    game,
    packageFiles,
    s2v,
    index,
    download,
    execute,
  } = context;
  selectedMaps([map]);
  const privateRoot = resolve(stage),
    absolute = resolve(input);
  if (
    (await realpath(privateRoot)) !== privateRoot ||
    resolve(prepared) !== join(privateRoot, 'prepared') ||
    !/^prepared\/\.environment-[a-zA-Z0-9_-]{1,80}\/merged\.glb$/.test(
      absolute.slice(privateRoot.length + 1),
    ) ||
    !absolute.startsWith(privateRoot + '/') ||
    (await realpath(absolute)) !== absolute
  )
    throw new Error('Atmosphere preparation requires this run’s real private merged input.');
  if (!Array.isArray(packageFiles) || packageFiles.length > 4)
    throw new Error('Invalid atmosphere package owner list.');
  for (const file of packageFiles) {
    if (typeof file !== 'string') throw new Error('Invalid atmosphere package owner.');
    const prefab = file.startsWith(`game/csgo/maps/prefabs/${map}/`);
    if (
      !prefab &&
      !['game/csgo/pak01_dir.vpk', 'game/core/pak01_dir.vpk', `game/csgo/maps/${map}.vpk`].includes(
        file,
      )
    )
      throw new Error('Atmosphere package owner is outside the selected map.');
    checkedBatch([{ selector: file, bytes: 0 }], { prefabs: prefab ? [file] : [] });
  }
  const module = adapters.module || (await import('./prepare-atmosphere.mjs'));
  const discovered = await module.discoverAtmosphericMaterials(input);
  if (!Array.isArray(discovered) || discovered.length > 64)
    throw new Error('Atmosphere material count exceeds its bounded registry.');
  if (!discovered.length) return { path: input, report: { materials: [], applied: false } };
  const names = new Map(),
    materials = [],
    resources = new Set();
  for (const spec of discovered) {
    if (!module.isSupportedAtmosphericMaterial(spec.material))
      throw new Error(
        'Atmosphere preparation requires an exact supported native material identity.',
      );
    const signature = JSON.stringify(stable(spec.material));
    if (names.has(spec.material.Name)) {
      if (names.get(spec.material.Name) !== signature)
        throw new Error('Conflicting atmosphere variants require explicit support.');
      continue;
    }
    names.set(spec.material.Name, signature);
    materials.push(spec);
    for (const name of ['color', 'mask1', 'mask2', 'mask3'])
      resources.add(textureResource(spec.resources?.[name]));
  }
  if (resources.size > 32) throw new Error('Atmosphere resource count exceeds its limit.');
  const indexes = new Map();
  const readIndex = async (file) => {
    if (!indexes.has(file)) indexes.set(file, await index(join(game, file)));
    return indexes.get(file);
  };
  const selected = [];
  for (const resource of resources) {
    let owner;
    for (const group of ['csgo', 'core']) {
      const path = join(game, 'game', group, resource);
      if (await exists(path)) {
        await regular(path, maximum);
        owner = {
          resource,
          args: ['-i', path],
          looseSha256: await fileHash(path, 'sha256', maximum),
        };
        break;
      }
    }
    if (!owner)
      for (const file of packageFiles) {
        const pak = await readIndex(file),
          entry = pak.entries.get(resource);
        if (!entry) continue;
        if (
          !Number.isSafeInteger(entry.length) ||
          !Number.isSafeInteger(entry.preloadBytes) ||
          entry.length < 0 ||
          entry.preloadBytes < 0 ||
          entry.length + entry.preloadBytes > maximum
        )
          throw new Error('Atmosphere resource exceeds its bounded VPK read size.');
        owner = {
          resource,
          file,
          pak,
          args: ['-i', join(game, file), '--vpk_filepath', resource],
          entry,
          missing: !(await pak.readEntry(resource)),
        };
        break;
      }
    if (!owner)
      throw new Error('Required atmosphere texture is absent from the pinned local indexes.');
    selected.push(owner);
  }
  const pending = selected.filter((owner) => owner.missing);
  if (pending.length) {
    await download(
      pending.map(({ file, resource, entry }) => ({
        selector: `${file}:${resource}`,
        bytes: entry.length + entry.preloadBytes,
      })),
      `${map}-atmosphere-resources`,
    );
    for (const owner of pending)
      if (!(await owner.pak.readEntry(owner.resource)))
        throw new Error('Atmosphere texture is unavailable or CRC invalid after selective fetch.');
  }
  const decoded = join(stage, 'atmosphere-source');
  await mkdir(decoded);
  const images = new Map(),
    sources = [];
  for (const owner of selected) {
    await execute(
      s2v,
      [...owner.args, '--decompile', '--output', decoded, '--quiet'],
      `${map}-atmosphere-texture-${images.size}`,
    );
    const path = join(decoded, owner.resource.slice(0, -'.vtex_c'.length) + '.png');
    await regular(path, 32 * 1024 ** 2, 57);
    images.set(owner.resource, path);
    sources.push({
      resource: owner.resource,
      package: owner.file ?? null,
      crc32: owner.entry?.crc32 ?? null,
      looseSha256: owner.looseSha256 ?? null,
      imageSha256: await fileHash(path, 'sha256', 32 * 1024 ** 2),
    });
  }
  const jobs = materials.map((spec, i) => ({
    material: spec.material,
    colorPath: images.get(textureResource(spec.resources.color)),
    maskPaths: Object.fromEntries(
      ['mask1', 'mask2', 'mask3'].map((name) => [
        name,
        images.get(textureResource(spec.resources[name])),
      ]),
    ),
    output: join(stage, `atmosphere-${i}.png`),
  }));
  const configPath = join(stage, 'atmosphere-prepare.json'),
    resultPath = join(stage, 'atmosphere-result.json');
  const config = { input, jobs, stage, output: join(stage, 'atmosphere-corrected.glb') };
  const text = JSON.stringify(config);
  if (Buffer.byteLength(text) > 1024 * 1024)
    throw new Error('Atmosphere preparation config exceeds its bound.');
  await writeFile(configPath, text, { flag: 'wx', mode: 0o600 });
  if (adapters.prepare) await adapters.prepare(config, resultPath);
  else
    await execute(
      process.execPath,
      [wrapper, '--config', configPath, '--result', resultPath],
      `${map}-atmosphere-pack`,
    );
  await regular(resultPath, 1024 * 1024);
  const result = JSON.parse(await readFile(resultPath, 'utf8'));
  if (result.path !== config.output || (await realpath(result.path)) !== resolve(config.output))
    throw new Error('Atmosphere output left its private installation stage.');
  const checked = await verifyPreparedGlb(result.path);
  const report = { ...result.report, sources, applied: true, output: checked };
  const provenance = join(prepared, 'environments', map, 'provenance.json');
  await regular(provenance, 1024 * 1024);
  const original = JSON.parse(await readFile(provenance, 'utf8'));
  if (
    !original ||
    original.schemaVersion !== 1 ||
    original.map !== map ||
    original.assetVersion !== assetVersion
  )
    throw new Error('Atmosphere provenance does not match this prepared map.');
  const updated = JSON.stringify({ ...original, atmosphere: report }, null, 2);
  if (Buffer.byteLength(updated) > 1024 * 1024)
    throw new Error('Atmosphere provenance exceeds its bound.');
  const next = join(prepared, 'environments', map, 'atmosphere-provenance.json');
  await writeFile(next, updated, { flag: 'wx', mode: 0o600 });
  await rename(next, provenance);
  // The superseded merge belongs to this run, never an operator input or cache.
  if ((await realpath(absolute)) !== absolute)
    throw new Error('Atmosphere cleanup requires this run’s private merged input.');
  await unlink(absolute);
  return { path: result.path, report };
}
