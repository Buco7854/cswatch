/** Match exported world meshes to manifest-verified embedded Source draw calls. */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readAtmosphereGlb } from './atmosphere-glb.mjs';
import { regularFile } from './toolchain-security.mjs';

const MiB = 1024 ** 2;
const limits = { models: 256, materials: 256, modelBytes: MiB, dump: 1024 * 1024, total: 32 * MiB };
const family = /^csgo_(?:complex|environment(?:_blend)?|vertexlitgeneric|simple)\.vfx$/;
const vertexFamily =
  /^csgo_(?:vertexlitgeneric|environment(?:_blend)?|lightmappedgeneric|lightmapped_4wayblend)\.vfx$/;
const materialPath = /^(?:materials|models)\/[a-z0-9_./-]{1,240}\.vmat$/;
const nativeMesh = /^([a-z0-9_-]{1,160})\.(meshset_\d{1,3})$/;
const aggregateMesh = /^(n\d+_[a-z0-9_-]{1,148}_agg_merge_[a-z0-9_-]{1,160})_fragment\d{1,7}$/;
// Match the pinned exporter's DXGI component counts. A four-component paint
// stream or a scalar instance index does not consume a TEXCOORD_ glTF slot.
const floatPair = new Set([16, 34, 35, 37, 38]);
const otherTexcoord = new Set([2, 4, 6, 10, 11, 12, 14, 28, 30, 41, 42]);
const colorVector = new Set([2, 10, 11, 28]);
const value = (text, name, indent) =>
  new RegExp(`^${'\\t'.repeat(indent)}${name}\\s*=\\s*([^\\r\\n]+)$`, 'm').exec(text)?.[1].trim();
const integer = (text, name, indent) => {
  const source = value(text, name, indent);
  return /^\d{1,9}$/.test(source ?? '') ? Number(source) : undefined;
};
const objects = (text, depth) => {
  const indent = '\\t'.repeat(depth);
  return [
    ...text.matchAll(new RegExp(`^${indent}\\{\\r?\\n([\\s\\S]*?)^${indent}\\},?\\s*$`, 'gm')),
  ].map((part) => part[1]);
};
const section = (text, name, indent) =>
  new RegExp(
    `^${'\\t'.repeat(indent)}${name}\\s*=\\s*\\r?\\n${'\\t'.repeat(indent)}\\[\\r?\\n([\\s\\S]*?)^${'\\t'.repeat(indent)}\\]`,
    'm',
  ).exec(text)?.[1];
const singleBlock = (text, name, maxBytes = limits.dump) => {
  if (Buffer.byteLength(text) > maxBytes || text.includes('\0')) return;
  const parts = text.split(/^--- Data for block "([A-Z0-9_]{4})" ---\r?$/gm);
  let block;
  for (let index = 1; index < parts.length; index += 2) {
    if (parts[index] !== name) continue;
    if (block !== undefined) return;
    block = parts[index + 1];
  }
  if (block !== undefined && Buffer.byteLength(block) <= limits.dump) return block;
};

/** The input signature discriminates the actual lightmap coordinate from paint UVs. */
export function nativeMaterialLightmapSlot(text) {
  const data = singleBlock(text, 'INSG');
  if (!data) return;
  const inputs = objects(section(data, 'm_elems', 1) ?? '', 2);
  const target = inputs.filter((element) =>
    ['"vLightmapUV"', '"vLightmapUVW"'].includes(value(element, 'm_pName', 3)),
  );
  if (target.length !== 1 || value(target[0], 'm_pD3DSemanticName', 3) !== '"TEXCOORD"') return;
  return integer(target[0], 'm_nD3DSemanticIndex', 3);
}

/** The native buffer order determines S2V's consecutive glTF TEXCOORD indices. */
export function embeddedMapDraws(control, meshData = control) {
  const maxBytes = meshData === control ? 2 * limits.dump : limits.dump;
  const ctrl = singleBlock(control, 'CTRL', maxBytes),
    mdat = singleBlock(meshData, 'MDAT', maxBytes);
  if (!ctrl || !mdat) return;
  const headers = [...control.matchAll(/^\t-- Block: ([A-Z0-9_]{4})\s/gm)].map((line) => line[1]);
  if (headers.filter((name) => name === 'MDAT').length !== 1) return;
  const embedded = objects(section(ctrl, 'embedded_meshes', 1) ?? '', 2);
  if (embedded.length !== 1 || headers[integer(embedded[0], 'm_nDataBlock', 3)] !== 'MDAT') return;
  const name = /^"(meshset_\d{1,3})"$/.exec(value(embedded[0], 'm_Name', 3) ?? '')?.[1];
  if (!name) return;
  const buffers = objects(section(embedded[0], 'm_vertexBuffers', 3) ?? '', 4).map((buffer) => ({
    count: integer(buffer, 'm_nElementCount', 5),
    fields: objects(section(buffer, 'm_inputLayoutFields', 5) ?? '', 6).map((field) => ({
      name: value(field, 'm_pSemanticName', 7)?.toUpperCase(),
      index: integer(field, 'm_nSemanticIndex', 7),
      format: integer(field, 'm_Format', 7),
      vertex: value(field, 'm_nSlotType', 7) === '"RENDER_SLOT_PER_VERTEX"',
    })),
  }));
  if (!buffers.length || buffers.length > 64) return;
  const draws = objects(section(mdat, 'm_sceneObjects', 1) ?? '', 2).flatMap((object) =>
    objects(section(object, 'm_drawCalls', 3) ?? '', 4),
  );
  if (!draws.length || draws.length > 4096) return;
  const records = [];
  for (const draw of draws) {
    const material = /^resource:"([^"\r\n]+)"$/.exec(value(draw, 'm_material', 5) ?? '')?.[1];
    if (!materialPath.test(material ?? '') || material.split('/').includes('..')) continue;
    const indices = integer(draw, 'm_nIndexCount', 5);
    const bound = objects(section(draw, 'm_vertexBuffers', 5) ?? '', 6).map(
      (entry) => buffers[integer(entry, 'm_hBuffer', 7)],
    );
    if (!indices || !bound.length || bound.some((buffer) => !buffer?.fields.length)) continue;
    const position = bound.filter((buffer) =>
      buffer.fields.some((field) => field.name === '"POSITION"'),
    );
    if (position.length !== 1 || !position[0].count) continue;
    const coordinates = bound.flatMap(({ fields }) =>
      fields.filter((field) => field.name === '"TEXCOORD"'),
    );
    const slots = coordinates
      .filter(({ format }) => floatPair.has(format))
      .map(({ index }) => index);
    const validCoordinates =
      slots.length >= 1 &&
      slots.length <= 8 &&
      new Set(slots).size === slots.length &&
      slots[0] === 0 &&
      coordinates.every(
        (field) =>
          field.vertex &&
          field.index !== undefined &&
          (floatPair.has(field.format) || otherTexcoord.has(field.format)),
      );
    const atlas =
      value(draw, 'm_bHasBakedLightingFromLightMap', 5) === 'true' &&
      slots.length >= 2 &&
      validCoordinates;
    const colors = bound.flatMap(({ fields }) =>
      fields.filter((field) => field.name === '"COLOR"'),
    );
    const vertexField = value(draw, 'm_bHasBakedLightingFromVertexStream', 5);
    const flags = value(draw, 'm_nFlags', 5) ?? '';
    const vertexFlag =
      vertexField === undefined
        ? /\bMESH_DRAW_FLAGS_USE_COMPRESSED_PER_VERTEX_LIGHTING\b/.test(flags) ||
          (/^(?:\d{1,9}|0x[\da-f]{1,8})$/i.test(flags) && (Number(flags) & 0x10) !== 0)
        : vertexField === 'true';
    const vertex =
      vertexFlag &&
      colors.length === 2 &&
      colors[0].vertex &&
      colors[0].index === 0 &&
      colors[1].vertex &&
      colors[1].index === 1 &&
      colorVector.has(colors[1].format);
    records.push({
      material,
      indices,
      vertices: position[0].count,
      slots: validCoordinates ? slots : [],
      atlas,
      ...(vertex ? { vertex } : {}),
    });
  }
  return { name, records };
}

export const nativeLightingKey = (mesh, material, indices, vertices) =>
  `${mesh}:${material}:${indices}:${vertices}`;

export async function readNativeLightingBindings(path, { secondary = false } = {}) {
  const { handle } = await regularFile(path, 4 * MiB);
  try {
    const data = JSON.parse(await handle.readFile('utf8'));
    const candidate = (name) => {
      const [mesh, material, indices, vertices, extra] = name.split(':');
      return (
        !extra &&
        (nativeMesh.test(mesh) || aggregateMesh.test(mesh)) &&
        materialPath.test(material ?? '') &&
        !material.split('/').includes('..') &&
        /^\d{1,9}$/.test(indices ?? '') &&
        /^\d{1,9}$/.test(vertices ?? '')
      );
    };
    if (
      !data ||
      typeof data !== 'object' ||
      Array.isArray(data) ||
      Object.entries(data).some(
        ([name, slot]) =>
          !candidate(name) ||
          (secondary
            ? !Number.isInteger(slot) || slot < -1 || slot > 7
            : slot !== 'vertex' && (!Number.isInteger(slot) || slot < 1 || slot > 7)),
      )
    )
      throw Error('Invalid compiled map lighting bindings.');
    return new Map(Object.entries(data));
  } finally {
    await handle.close();
  }
}

export async function discoverNativeMapLighting({
  input,
  source,
  map,
  banks,
  folder,
  execute,
  s2v,
  includeAtlas,
}) {
  const { document } = await readAtmosphereGlb(input);
  const candidates = new Map();
  for (const mesh of document.meshes ?? []) {
    const name = nativeMesh.exec(mesh.name ?? '') ?? aggregateMesh.exec(mesh.name ?? '');
    if (!name) continue;
    const key = ['worldnodes', 'entities']
      .map((folder) => `maps/${map}/${folder}/${name[1]}.vmdl_c`)
      .filter((path) => source.entries.has(path));
    if (key.length !== 1) continue;
    for (const primitive of mesh.primitives) {
      const material = document.materials?.[primitive.material]?.extras?.vmat;
      if (!materialPath.test(material?.Name ?? '')) continue;
      const atlas =
        includeAtlas &&
        family.test(material.ShaderName) &&
        primitive.attributes.TEXCOORD_1 !== undefined;
      const vertex =
        vertexFamily.test(material.ShaderName) && primitive.attributes._COLOR_1 !== undefined;
      const vertices = document.accessors?.[primitive.attributes.POSITION]?.count;
      const indices = document.accessors?.[primitive.indices]?.count;
      const layerUv =
        material.ShaderName === 'csgo_environment_blend.vfx' &&
        [
          material.IntParams?.g_nUVSet2,
          material.IntParams?.g_nUVSet3,
          material.IntParams?.g_nColorOverlayUVSet,
        ].includes(2);
      if (!vertices || !indices || (!atlas && !vertex && !layerUv)) continue;
      const row = {
        mesh: mesh.name,
        group: name[2],
        material: material.Name,
        vertices,
        indices,
        atlas,
        layerUv,
        vertex,
      };
      const rows = candidates.get(key[0]) ?? [];
      rows.push(row);
      candidates.set(key[0], rows);
    }
  }
  let consumed = 0,
    models = 0,
    materials = 0;
  const read = async (bank, key, extension, limit) => {
    const entry = bank.entries.get(key);
    const bytes = entry ? entry.length + entry.preloadBytes : 0;
    if (!bytes || bytes > limit || consumed + bytes > limits.total) return;
    const data = await bank.readEntry(key);
    if (data?.length !== bytes) return;
    const path = join(folder, `native-layout-${models}-${materials}.${extension}_c`);
    await writeFile(path, data, { flag: 'wx', mode: 0o600 });
    consumed += bytes;
    return path;
  };
  const dump = async (path, block) => {
    const result = await execute(
      s2v,
      ['-i', path, '--block', block],
      `native-layout-${models}-${materials}-${block}`,
      { allowFailure: true },
    );
    return result.code === 0 ? result.stdout : '';
  };
  const signatures = new Map();
  const signature = async (material) => {
    if (signatures.has(material)) return signatures.get(material);
    if (materials >= limits.materials) return;
    const key = `${material}_c`;
    const bank = banks.find(({ entries }) => entries.has(key));
    const slot = bank && (await read(bank, key, 'vmat', 64 * 1024));
    materials++;
    const channel = slot ? nativeMaterialLightmapSlot(await dump(slot, 'INSG')) : undefined;
    signatures.set(material, channel);
    return channel;
  };
  const bindings = Object.create(null),
    secondaryUv = Object.create(null);
  for (const [key, rows] of [...candidates].sort((a, b) => b[1].length - a[1].length)) {
    if (++models > limits.models) break;
    const path = await read(source, key, 'vmdl', limits.modelBytes);
    if (!path) continue;
    // S2V accepts comma-separated blocks. Reuse the same confined tool process
    // and input read for both the embedded layout and its draw metadata.
    let metadata;
    try {
      metadata = embeddedMapDraws(await dump(path, 'CTRL,MDAT'));
    } catch (error) {
      if (error?.code !== 'ASSET_OUTPUT_LIMIT') throw error;
      // A combined dump can hit the process cap even when each block fits.
      // Preserve the individual diagnostic limits for these exceptional models.
      metadata = embeddedMapDraws(await dump(path, 'CTRL'), await dump(path, 'MDAT'));
    }
    if (!metadata) continue;
    for (const row of rows) {
      if (row.group && row.group !== metadata.name) continue;
      const matches = metadata.records.filter(
        ({ material, indices, vertices }) =>
          material === row.material && indices === row.indices && vertices === row.vertices,
      );
      if (!matches.length) continue;
      const binding = nativeLightingKey(row.mesh, row.material, row.indices, row.vertices);
      if (row.layerUv && matches.every(({ slots }) => slots.length > 0)) {
        const slots = new Set(matches.map((draw) => draw.slots.indexOf(1)));
        if (slots.size === 1 && [...slots][0] >= 0) secondaryUv[binding] = [...slots][0];
      }
      if (row.atlas && matches.every(({ atlas }) => atlas)) {
        const slot = await signature(row.material);
        if (slot !== undefined) {
          const channels = new Set(matches.map(({ slots }) => slots.indexOf(slot)));
          const channel = [...channels][0];
          if (channels.size === 1 && channel >= 1) {
            bindings[binding] = channel;
            continue;
          }
        }
      }
      if (row.vertex && bindings[binding] === undefined && matches.every(({ vertex }) => vertex))
        bindings[binding] = 'vertex';
    }
  }
  return { bindings, secondaryUv, models: Math.min(models, limits.models), materials };
}
