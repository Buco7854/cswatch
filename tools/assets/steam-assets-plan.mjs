/** Fixed-source selective Steam plans. No caller-supplied URL, depot or file glob. */
import { resourcePath } from './source2-dependencies.mjs';

export const steamAssetLimits = Object.freeze({
  maps: 16,
  waves: 8,
  entries: 50000,
  selectedBytes: 8 * 1024 ** 3,
  cacheBytes: 16 * 1024 ** 3,
  reserveBytes: 512 * 1024 ** 2,
  outputBytes: 4 * 1024 ** 3,
  // Match the HTTP map discovery bound for each independently served GLB.
  modelBytes: 2 * 1024 ** 3,
  logBytes: 4 * 1024 ** 2,
});
export const STEAM_APP = '730',
  STEAM_DEPOT = '2347770';
/** Manifest IDs are uint64 strings, never rounded JavaScript numbers. */
export function selectedSteamManifest(value) {
  if (
    typeof value !== 'string' ||
    !/^[1-9]\d{0,19}$/.test(value) ||
    BigInt(value) > 18446744073709551615n
  )
    throw new Error('Provide --manifest as one nonzero uint64 decimal string.');
  return value;
}
export function selectedMaps(value) {
  const maps = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  if (
    !maps.length ||
    maps.length > steamAssetLimits.maps ||
    maps.some((map) => typeof map !== 'string' || !/^[a-z][a-z0-9_]{1,79}$/.test(map))
  )
    throw new Error('Provide --maps with 1–16 explicit lowercase map names separated by commas.');
  if (new Set(maps).size !== maps.length) throw new Error('Map selection contains duplicates.');
  return maps;
}
export function initialSteamFiles(maps) {
  return [
    ...selectedMaps(maps).map((map) => `game/csgo/maps/${map}.vpk`),
    ...['csgo', 'core'].flatMap((group) =>
      ['gameinfo.gi', 'pak01_dir.vpk', 'shaders_vulkan_dir.vpk'].map(
        (file) => `game/${group}/${file}`,
      ),
    ),
    'game/csgo/steam.inf',
  ].sort();
}
export function overviewResources(map) {
  selectedMaps([map]);
  return [`resource/overviews/${map}.txt`, `panorama/images/overheadmaps/${map}_radar_psd.vtex_c`];
}
const skyPrefabFolders = (map) => [map, map.replace(/^(?:de|cs|ar|dz|gd|tr)_/, '')];
export function selectedSkyPrefabFile(map, file) {
  selectedMaps([map]);
  return (
    validPrefabFile(file) &&
    skyPrefabFolders(map).some((folder) => file.startsWith(`game/csgo/maps/prefabs/${folder}/`))
  );
}
/** An enabled skybox_reference from the selected map may name exactly one
 * prefab inside that map's own directory, never another depot path or glob. */
export function skyPrefabPackage(map, reference) {
  selectedMaps([map]);
  const prefix =
    typeof reference === 'string' &&
    skyPrefabFolders(map)
      .map((folder) => `maps/prefabs/${folder}/`)
      .find((candidate) => reference.startsWith(candidate));
  if (!prefix) throw new Error('Sky reference must belong to the selected map prefab directory.');
  const leaf = reference.slice(prefix.length);
  if (!/^[a-z0-9_]{1,100}\.vmap$/.test(leaf))
    throw new Error('Sky reference must be one exact compiled map name.');
  return { file: `game/csgo/${reference.slice(0, -5)}.vpk`, resource: `${reference}_c` };
}
function validPrefabFile(file) {
  if (typeof file !== 'string') return false;
  const match = /^game\/csgo\/maps\/prefabs\/([a-z][a-z0-9_]{1,79})\/([a-z0-9_]{1,100})\.vpk$/.exec(
    file,
  );
  return Boolean(
    match && skyPrefabPackage(match[1], `maps/prefabs/${match[1]}/${match[2]}.vmap`).file === file,
  );
}
export function parseSteamListing(text, files) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > steamAssetLimits.logBytes)
    throw new Error('Steam metadata exceeds the output limit.');
  const expected = new Set(files),
    rows = [],
    seen = new Set();
  let manifest;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const fields = line.split('\t');
    if (fields.length !== 5) throw new Error('Unexpected Steam listing format.');
    const [depot, id, sha1, length, file] = fields;
    if (
      depot !== STEAM_DEPOT ||
      !/^[1-9]\d{0,19}$/.test(id) ||
      BigInt(id) > 18446744073709551615n ||
      !/^[a-f0-9]{40}$/i.test(sha1) ||
      !/^\d+$/.test(length) ||
      !expected.has(file) ||
      seen.has(file)
    )
      throw new Error('Steam listing does not match the exact selected files.');
    if (manifest && id !== manifest) throw new Error('Steam listing mixed manifest versions.');
    const bytes = Number(length);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > steamAssetLimits.selectedBytes)
      throw new Error('Selected Steam file exceeds the size limit.');
    manifest = id;
    seen.add(file);
    rows.push({ file, bytes, sha1: sha1.toLowerCase() });
  }
  if (seen.size !== expected.size || !manifest)
    throw new Error(
      'A selected map or required index is absent from the official Steam depot. No full-game or workshop fallback is used.',
    );
  const bytes = rows.reduce((sum, row) => sum + row.bytes, 0);
  if (bytes > steamAssetLimits.selectedBytes)
    throw new Error('Selected Steam files exceed the download budget.');
  return { manifest, files: rows, bytes };
}
export function dependencyBatch(plans, map, { packageFile } = {}) {
  selectedMaps([map]);
  const topLevel = `game/csgo/maps/${map}.vpk`;
  if (
    packageFile !== undefined &&
    packageFile !== topLevel &&
    !selectedSkyPrefabFile(map, packageFile)
  )
    throw new Error('Dependency package must belong to the selected map.');
  const records = [];
  for (const [group, entries] of Object.entries(plans.pending)) {
    if (!['map', 'csgo', 'core'].includes(group) || !Array.isArray(entries))
      throw new Error('Invalid dependency group.');
    for (const entry of entries) {
      const resource = resourcePath(entry.resource);
      if (
        !Number.isSafeInteger(entry.length) ||
        entry.length < 0 ||
        !Number.isSafeInteger(entry.preloadBytes) ||
        entry.preloadBytes < 0 ||
        entry.length + entry.preloadBytes > 128 * 1024 ** 2
      )
        throw new Error('Invalid dependency record size.');
      const pak = group === 'map' ? (packageFile ?? topLevel) : `game/${group}/pak01_dir.vpk`;
      records.push({ selector: `${pak}:${resource}`, bytes: entry.length + entry.preloadBytes });
    }
  }
  return checkedBatch(records, {
    prefabs: packageFile && packageFile !== topLevel ? [packageFile] : [],
  });
}
export function checkedBatch(records, { prefabs = [] } = {}) {
  if (
    !Array.isArray(prefabs) ||
    prefabs.length > steamAssetLimits.maps ||
    prefabs.some((file) => !validPrefabFile(file))
  )
    throw new Error('Invalid exact selected-map prefab allowlist.');
  const allowedPrefabs = new Set(prefabs);
  if (!Array.isArray(records) || records.length > steamAssetLimits.entries)
    throw new Error('Selective download entry limit exceeded.');
  const unique = new Map();
  for (const record of records) {
    if (
      typeof record.selector !== 'string' ||
      !Number.isSafeInteger(record.bytes) ||
      record.bytes < 0 ||
      record.bytes > steamAssetLimits.selectedBytes ||
      /[\r\n\0*?]/.test(record.selector) ||
      record.selector.includes('regex:') ||
      record.selector.includes('://')
    )
      throw new Error('Invalid exact Steam selection.');
    const [file, entry, extra] = record.selector.split(':');
    const knownFile =
      /^game\/(?:csgo|core)\/(?:gameinfo\.gi|pak01_dir\.vpk|shaders_vulkan_dir\.vpk)$/.test(file) ||
      file === 'game/csgo/steam.inf' ||
      /^game\/csgo\/maps\/[a-z][a-z0-9_]{1,79}\.vpk$/.test(file) ||
      allowedPrefabs.has(file);
    if (
      !knownFile ||
      extra !== undefined ||
      (entry !== undefined && (!/\.vpk$/.test(file) || resourcePath(entry) !== entry))
    )
      throw new Error('Steam selection is outside the fixed asset packages.');
    unique.set(record.selector, Math.max(unique.get(record.selector) ?? 0, record.bytes));
  }
  const result = [...unique].map(([selector, bytes]) => ({ selector, bytes }));
  if (result.reduce((sum, entry) => sum + entry.bytes, 0) > steamAssetLimits.selectedBytes)
    throw new Error('Selective download byte limit exceeded.');
  return result;
}
export function missingShaderNames(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > steamAssetLimits.logBytes)
    throw new Error('S2V output exceeds the limit.');
  const names = [
    ...new Set(
      [...text.matchAll(/Failed to find shader "([a-z0-9_]{1,100})\.vfx"/g)].map(
        (match) => match[1],
      ),
    ),
  ];
  if (names.length > 128) throw new Error('S2V shader dependency limit exceeded.');
  return names;
}
export function shaderBatch(names, indexes) {
  const records = [];
  for (const name of names) {
    if (!/^[a-z0-9_]{1,100}$/.test(name)) throw new Error('Invalid S2V shader name.');
    let found = false;
    for (const [group, index] of indexes) {
      if (!['csgo', 'core'].includes(group)) throw new Error('Invalid shader package group.');
      for (const entry of index.entries.values())
        if (
          entry.resource.startsWith(`shaders/vfx/${name}_vulkan_`) &&
          entry.resource.endsWith('.vcs')
        ) {
          found = true;
          records.push({
            selector: `game/${group}/shaders_vulkan_dir.vpk:${resourcePath(entry.resource)}`,
            bytes: entry.length + entry.preloadBytes,
          });
        }
    }
    if (!found) throw new Error(`Required shader ${name} is absent from the pinned local indexes.`);
  }
  return checkedBatch(records);
}
export function assertExportableUnknowns(names, map, { skyMap } = {}) {
  selectedMaps([map]);
  const actualSky = skyMap == null ? undefined : skyPrefabPackage(map, skyMap).resource;
  if (!Array.isArray(names) || names.length > steamAssetLimits.entries)
    throw new Error('Unknown dependency limit exceeded.');
  for (const name of names) {
    const resource = resourcePath(name);
    if (
      !resource.startsWith('_bakeresourcecache/') &&
      resource !== actualSky &&
      resource !== `maps/prefabs/${map}/${map}_skybox.vmap_c` &&
      resource !== `maps/prefabs/${map}/${map}_sky.vmap_c` &&
      !/^scripts\/vscripts\/.+\.lua_c$/.test(resource)
    )
      throw new Error(`Required resource is absent from the pinned indexes: ${resource}`);
  }
  return names;
}
