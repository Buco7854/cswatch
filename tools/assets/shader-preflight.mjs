import { nativeResourceBatch } from './native-resource-batch.mjs';
/** Shader requirements come from CRC-proven VMAT DATA, never asynchronous logs. */
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { resourcePath, readVpkDirectory } from './source2-dependencies.mjs';
import { waterFromMaterialData } from './map-water-inputs.mjs';
import { regular, checkFreeReserve } from './asset-storage.mjs';
import { checkedBatch, steamAssetLimits } from './steam-assets-plan.mjs';

const models = ['60', '50', '41', '40', '31', '30', '2b'];
const stages = ['features', 'vs', 'ps', 'gs', 'hs', 'ds', 'cs', 'psrs', 'rtx', 'ms'];
const maximum = 128 * 1024 ** 2;
const shaderVerificationLimits = Object.freeze({
  entryBytes: 512 * 1024 ** 2,
  totalBytes: 16 * 1024 ** 3,
});
const hash = (data) => createHash('sha256').update(data).digest('hex');
export function shaderNameFromMaterialData(text) {
  if (
    typeof text !== 'string' ||
    Buffer.byteLength(text) > steamAssetLimits.logBytes ||
    text.includes('\0')
  )
    throw new Error('Material DATA exceeds its bounded text format.');
  const values = [...text.matchAll(/^\s*m_shaderName\s*=\s*([^\r\n]+)$/gm)];
  const name = values.length === 1 ? /^"([a-z0-9_]{1,100})\.vfx"$/.exec(values[0][1].trim()) : null;
  if (!name) throw new Error('Material DATA must name one exact shader.');
  return name[1];
}
export function materialShaderBatch(text, files) {
  return nativeResourceBatch(text, files).map(({ path, body }) => {
    const shader = shaderNameFromMaterialData(body);
    const water = shader === 'csgo_water_fancy' && waterFromMaterialData(body);
    return { path, shader, ...(water ? { water } : {}) };
  });
}
export function requiredShaderPrograms(names, indexes) {
  if (
    !Array.isArray(names) ||
    names.length > 128 ||
    names.some((name) => typeof name !== 'string' || !/^[a-z0-9_]{1,100}$/.test(name))
  )
    throw new Error('Invalid bounded shader family list.');
  if (
    !Array.isArray(indexes) ||
    indexes.length > 2 ||
    indexes.some(([group]) => !['csgo', 'core'].includes(group)) ||
    new Set(indexes.map(([group]) => group)).size !== indexes.length
  )
    throw new Error('Invalid fixed shader package indexes.');
  const owners = new Map();
  for (const group of ['csgo', 'core'])
    for (const entry of indexes.find(([name]) => name === group)?.[1].entries.values() ?? [])
      if (!owners.has(entry.resource)) owners.set(entry.resource, { group, entry });
  const families = [];
  for (const name of [...new Set(names)].sort()) {
    const model = models.find((model) =>
      owners.has(`shaders/vfx/${name}_vulkan_${model}_features.vcs`),
    );
    if (!model)
      throw new Error(
        `Authored shader ${name} has no Vulkan feature metadata in the pinned indexes.`,
      );
    const programs = [];
    for (const stage of stages) {
      const resource = `shaders/vfx/${name}_vulkan_${model}_${stage}.vcs`;
      const owner = owners.get(resource);
      if (!owner) continue;
      const { entry, group } = owner;
      if (
        !Number.isSafeInteger(entry.length) ||
        !Number.isSafeInteger(entry.preloadBytes) ||
        entry.length < 0 ||
        entry.preloadBytes < 0 ||
        entry.length + entry.preloadBytes > shaderVerificationLimits.entryBytes
      )
        throw new Error('Required shader exceeds the bounded streamed CRC verification limit.');
      programs.push({
        selector: `game/${group}/shaders_vulkan_dir.vpk:${resource}`,
        bytes: entry.length + entry.preloadBytes,
      });
    }
    families.push({ name, model, programs: checkedBatch(programs) });
  }
  if (
    families.flatMap((family) => family.programs).reduce((sum, program) => sum + program.bytes, 0) >
    steamAssetLimits.selectedBytes
  )
    throw new Error('Required shader program bytes exceed the selective asset budget.');
  return families;
}

export async function preflightMaterialShaders({
  closure,
  game,
  packageFile,
  stage,
  label,
  s2v,
  execute,
  download,
  shaderIndexes,
  index = readVpkDirectory,
}) {
  const records = closure?.materials;
  if (!Array.isArray(records) || records.length > 20000)
    throw new Error('Material shader preflight requires a bounded reference proof list.');
  if (!records.length) return { materials: [], families: [], repaired: [] };
  const allowed = new Set(
    [packageFile, 'game/csgo/pak01_dir.vpk', 'game/core/pak01_dir.vpk'].map((file) =>
      resolve(game, file),
    ),
  );
  const directories = new Map(),
    root = join(stage, `${label}-shader-materials`);
  await mkdir(root);
  let batch = [],
    batchBytes = 0,
    batchIndex = 0,
    totalBytes = 0;
  const materialProofs = [];
  async function inspectBatch() {
    if (!batch.length) return;
    const result = await execute(
      s2v,
      ['-i', join(root, String(batchIndex)), '--recursive', '--block', 'DATA', '--threads', '1'],
      `${label}-shader-data-${batchIndex}`,
    );
    const decoded = materialShaderBatch(
      result.stdout,
      batch.map((entry) => entry.path),
    );
    for (const decodedMaterial of decoded) {
      const record = batch.find((record) => record.path === decodedMaterial.path);
      materialProofs.push({
        resource: record.resource,
        sha256: record.sha256,
        bytes: record.bytes,
        shader: decodedMaterial.shader,
        ...(decodedMaterial.water ? { water: decodedMaterial.water } : {}),
      });
    }
    await rm(join(root, String(batchIndex)), { recursive: true });
    batch = [];
    batchBytes = 0;
    batchIndex++;
  }
  for (const [ordinal, record] of records.entries()) {
    if (
      typeof record.resource !== 'string' ||
      resourcePath(record.resource) !== record.resource ||
      !record.resource.endsWith('.vmat_c') ||
      !Number.isSafeInteger(record.bytes) ||
      record.bytes < 1 ||
      record.bytes > maximum ||
      !/^[a-f0-9]{64}$/.test(record.sha256)
    )
      throw new Error('Invalid CRC-proven material preflight record.');
    let bytes;
    if (record.source?.kind === 'vpk') {
      const path = resolve(record.source.path);
      if (!allowed.has(path))
        throw new Error('Material preflight package is outside the selected map.');
      if (!directories.has(path)) directories.set(path, await index(path));
      bytes = await directories.get(path).readEntry(record.resource);
    } else if (record.source?.kind === 'loose') {
      const path = resolve(record.source.path);
      if (
        !['csgo', 'core'].some((group) => path === resolve(game, 'game', group, record.resource)) ||
        (await realpath(path)) !== path
      )
        throw new Error('Loose material preflight source is outside trusted game roots.');
      await regular(path, maximum);
      bytes = await readFile(path);
    } else throw new Error('Invalid material preflight source.');
    if (!bytes || bytes.length !== record.bytes || hash(bytes) !== record.sha256)
      throw new Error('Material preflight source changed or is CRC invalid.');
    totalBytes += bytes.length;
    if (totalBytes > 256 * 1024 ** 2) throw new Error('Material preflight copy budget exceeded.');
    if (batch.length && (batch.length >= 16 || batchBytes + bytes.length > 256 * 1024))
      await inspectBatch();
    const directory = join(root, String(batchIndex));
    if (!batch.length) await mkdir(directory);
    const path = join(directory, `${String(ordinal).padStart(6, '0')}.vmat_c`);
    await checkFreeReserve(stage, stage, bytes.length);
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
    batch.push({ ...record, path });
    batchBytes += bytes.length;
  }
  await inspectBatch();
  const families = requiredShaderPrograms(
    [...new Set(materialProofs.map((record) => record.shader))],
    shaderIndexes,
  );
  const pending = [];
  let verifiedBytes = 0;
  const verifyProgram = async (directory, resource, bytes) => {
    verifiedBytes += bytes;
    if (verifiedBytes > shaderVerificationLimits.totalBytes)
      throw new Error('Shader preflight exceeds the cumulative verification budget.');
    if (typeof directory.verifyEntry !== 'function')
      throw new Error('Shader programs require bounded streaming CRC verification.');
    return (await directory.verifyEntry(resource)) === true;
  };
  for (const family of families)
    for (const program of family.programs) {
      const [file, resource] = program.selector.split(':');
      const group = /^game\/(csgo|core)\//.exec(file)[1];
      const directory = shaderIndexes.find(([name]) => name === group)[1];
      if (!(await verifyProgram(directory, resource, program.bytes))) pending.push(program);
    }
  if (pending.length) await download(checkedBatch(pending), `${label}-authored-shaders`);
  for (const program of pending) {
    const [file, resource] = program.selector.split(':');
    const group = /^game\/(csgo|core)\//.exec(file)[1];
    if (
      !(await verifyProgram(
        shaderIndexes.find(([name]) => name === group)[1],
        resource,
        program.bytes,
      ))
    )
      throw new Error('Authored shader program remains unavailable or CRC invalid.');
  }
  const report = { materials: materialProofs, families, repaired: pending, verifiedBytes };
  if (Buffer.byteLength(JSON.stringify(report)) > steamAssetLimits.logBytes)
    throw new Error('Material shader provenance exceeds its bound.');
  return report;
}
