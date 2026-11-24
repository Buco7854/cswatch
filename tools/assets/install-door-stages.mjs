import { lstat, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { entityDumpRows } from './environment-metadata.mjs';
import { source2References } from './source2-dependencies.mjs';
import { regularFile } from './toolchain-security.mjs';

const modelPath = /^models\/(?:[a-z0-9_-]+\/)*[a-z0-9_-]+\.vmdl$/;
const materialPath = /^(?:materials|models)\/(?:[a-z0-9_-]+\/)*[a-z0-9_-]+\.vmat$/;
export const doorStageLimits = Object.freeze({
  models: 8,
  variants: 32,
  source: 4 * 1024 ** 2,
  bytes: 24 * 1024 ** 2,
  glb: 3 * 1024 ** 2,
  triangles: 120000,
});

export function declaredDoorStages(model, data, references) {
  if (typeof data !== 'string' || Buffer.byteLength(data) > 1024 ** 2 || !modelPath.test(model))
    return [];
  const declarations = [
    ...data.matchAll(/^\s*door_options\s*=\s*\{\s*defaults\s*=\s*\{([^{}]*)\}/gm),
  ];
  if (declarations.length !== 1 || !data.includes('m_name = "' + model + '"')) return [];
  const stages = [],
    seen = new Set();
  for (const match of declarations[0][1].matchAll(/^\s*damage([1-4])\s*=\s*"([^"\r\n]+)"\s*$/gm)) {
    const path = 'models/' + match[2].replaceAll('\\\\', '/').toLowerCase() + '.vmdl';
    const stage = Number(match[1]);
    if (
      !modelPath.test(path) ||
      path === model ||
      !references.includes(path + '_c') ||
      seen.has(path) ||
      seen.has(stage)
    )
      return [];
    stages.push({ stage, path });
    seen.add(path);
    seen.add(stage);
  }
  return stages;
}

export function singleDoorDraw(data, references) {
  if (typeof data !== 'string' || Buffer.byteLength(data) > 1024 ** 2) return;
  const value = (key, pattern) => {
    const occurrences = [
      ...data.matchAll(new RegExp('^\\s*' + key + '\\s*=\\s*' + pattern + '\\s*$', 'gm')),
    ];
    if (occurrences.length === 1) return occurrences[0][1];
  };
  if (
    value('m_nPrimitiveType', '"([^"]+)"') !== 'RENDER_PRIM_TRIANGLES' ||
    value('m_nStartIndex', '(\\d+)') !== '0' ||
    value('m_nBaseVertex', '(\\d+)') !== '0'
  )
    return;
  const material = value('m_material', 'resource:"([^"]+)"'),
    indices = Number(value('m_nIndexCount', '(\\d+)')),
    vertices = Number(value('m_nVertexCount', '(\\d+)'));
  if (
    !material ||
    !materialPath.test(material) ||
    !references.includes(material + '_c') ||
    !Number.isSafeInteger(indices) ||
    indices <= 0 ||
    indices % 3 !== 0 ||
    indices > doorStageLimits.triangles * 3 ||
    !Number.isSafeInteger(vertices) ||
    vertices <= 0 ||
    vertices > 100000
  )
    return;
  return { material, indices, vertices };
}

function optionalReferences(bytes) {
  // Only catch decoding of already bounded in-memory bytes. Filesystem security,
  // cancellation, space limits and native process termination remain fatal.
  try {
    return source2References(bytes);
  } catch {
    return [];
  }
}

function nativeFailed(result) {
  if (result.signal)
    throw new Error('Door asset conversion terminated with signal ' + result.signal);
  return Boolean(result.code);
}

/** Each optional variant is selected by the base VMDL's compiled DATA and RERL.
 * All native reads are CRC checked against the same pinned packages as the world. */
export async function exportDoorStages({ entities, banks, execute, s2v, directory }) {
  const lumps = Array.isArray(entities) ? entities : [entities];
  if (!lumps.some((lump) => typeof lump === 'string' && lump.includes('prop_door_rotating')))
    return [];
  const classes = entityDumpRows(entities, new Set(['classname', 'model', 'skin', 'parentname']));
  const models = [
    ...new Set(
      classes
        .filter(
          (r) =>
            r.classname === 'prop_door_rotating' &&
            !r.parentname &&
            typeof r.model === 'string' &&
            r.model.length <= 256 &&
            modelPath.test(r.model) &&
            [undefined, '', 'default', 0, '0'].includes(r.skin),
        )
        .map((r) => r.model),
    ),
  ];
  if (!models.length || models.length > doorStageLimits.models) return [];
  const owners = await banks();
  const output = await mkdtemp(directory + '-');
  let sourceBytes = 0,
    outputBytes = 0,
    triangles = 0;
  async function verified(path) {
    const key = path + '_c';
    const entries = owners.filter((o) => o.index.entries.has(key));
    const first = entries[0];
    if (!first) return;
    const entry = first.index.entries.get(key),
      bytes = entry.length + entry.preloadBytes;
    if (
      bytes < 1 ||
      bytes > doorStageLimits.source ||
      sourceBytes + bytes > doorStageLimits.bytes ||
      entries.some(({ index }) => {
        const found = index.entries.get(key);
        return found.crc32 !== entry.crc32 || found.length + found.preloadBytes !== bytes;
      })
    )
      return;
    sourceBytes += bytes;
    // The main resource closure has already fetched its verified dependencies.
    // Unavailable optional geometry must neither start a second download nor delay the world.
    for (const owner of entries) {
      const data = await owner.index.readEntry(key);
      if (data?.length === bytes) return data;
    }
  }
  const rows = [];
  for (const [i, base] of models.entries()) {
    const source = await verified(base);
    if (!source) continue;
    const input = join(output, 'base-' + i + '.vmdl_c');
    await writeFile(input, source, { flag: 'wx', mode: 0o600 });
    const info = await execute(s2v, ['-i', input, '--block', 'DATA'], 'door-base-' + i, {
      allowFailure: true,
    });
    if (nativeFailed(info)) continue;
    for (const { stage, path } of declaredDoorStages(
      base,
      info.stdout,
      optionalReferences(source),
    )) {
      const raw = await verified(path);
      if (!raw) continue;
      const name = 'stage-' + i + '-' + stage,
        compiled = join(output, name + '.vmdl_c'),
        file = join(output, name + '.glb');
      await writeFile(compiled, raw, { flag: 'wx', mode: 0o600 });
      const mdat = await execute(s2v, ['-i', compiled, '--block', 'MDAT'], name + '-layout', {
        allowFailure: true,
      });
      if (nativeFailed(mdat)) continue;
      const draw = singleDoorDraw(mdat.stdout, optionalReferences(raw));
      if (!draw || triangles + draw.indices / 3 > doorStageLimits.triangles) continue;
      const converted = await execute(
        s2v,
        ['-i', compiled, '-o', file, '--gltf_export_format', 'glb', '--quiet'],
        name + '-geometry',
        { allowFailure: true },
      );
      if (nativeFailed(converted)) continue;
      // An optional model beyond this tier's allowance must not prevent the map from opening.
      if ((await lstat(file)).size > doorStageLimits.glb) continue;
      const { handle, stat } = await regularFile(file, doorStageLimits.glb);
      await handle.close();
      if (outputBytes + stat.size > doorStageLimits.bytes) return rows;
      outputBytes += stat.size;
      triangles += draw.indices / 3;
      rows.push({ base, stage, path, file, ...draw });
    }
  }
  return rows;
}
