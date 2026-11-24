import { basename } from 'node:path';
import { breakableKey, breakableLimits } from '../../shared/map-breakables.mjs';
import { entityDumpRows } from './environment-metadata.mjs';
import { sourceRotate } from './environment-space.mjs';

const fields = new Set([
  'classname',
  'model',
  'origin',
  'angles',
  'scales',
  'scale',
  'parentname',
  'uselocaloffset',
  'hammeruniqueid',
  'health',
  'startdisabled',
  'clientsideentity',
  '@OnBreak',
]);
const modelPath = /^(?:models|maps)\/(?:[a-z0-9_-]+\/)*[a-z0-9_-]+\.vmdl$/;
const hammerId = /^\d{1,20}(?::\d{1,20}){0,7}$/;
const vec3 = (value, bound) =>
  Array.isArray(value) &&
  value.length === 3 &&
  value.every((n) => Number.isFinite(n) && Math.abs(n) <= bound);
const yes = (value) => [1, true, '1', 'true'].includes(value);

// The CS2 resource string table uses MurmurHash64B, with two little-endian uint32 lanes.
// Keep the full handle as a decimal string throughout JSON and replay comparisons.
export function modelResourceId(path) {
  const bytes = Buffer.from(path, 'utf8');
  const multiplier = 0x5bd1e995;
  const mixWord = (hash, word) => {
    const scaled = Math.imul(word, multiplier);
    return Math.imul(hash, multiplier) ^ Math.imul(scaled ^ (scaled >>> 24), multiplier);
  };
  let high = 0xedabcdef ^ bytes.length;
  let low = 0;
  let at = 0;
  for (; at + 8 <= bytes.length; at += 8) {
    high = mixWord(high, bytes.readUInt32LE(at));
    low = mixWord(low, bytes.readUInt32LE(at + 4));
  }
  if (at + 4 <= bytes.length) {
    high = mixWord(high, bytes.readUInt32LE(at));
    at += 4;
  }
  if (at < bytes.length) low = Math.imul(low ^ bytes.readUIntLE(at, bytes.length - at), multiplier);
  high = Math.imul(high ^ (low >>> 18), multiplier);
  low = Math.imul(low ^ (high >>> 22), multiplier);
  high = Math.imul(high ^ (low >>> 17), multiplier);
  low = Math.imul(low ^ (high >>> 19), multiplier);
  return ((BigInt(high >>> 0) << 32n) | BigInt(low >>> 0)).toString();
}

export function preparedBreakable(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    value.className !== 'prop_dynamic' ||
    typeof value.hammerId !== 'string' ||
    !hammerId.test(value.hammerId) ||
    typeof value.model !== 'string' ||
    value.model.length > 256 ||
    !modelPath.test(value.model) ||
    !breakableKey(value) ||
    value.modelId !== modelResourceId(value.model)
  )
    return;
  return value;
}

function placedMatrix({ origin, angles, scales }) {
  // Raw S2V uses metres in [Source Y, Source Z, Source X]. The viewer later rotates +90° Y.
  const toGltf = ([x, y, z]) => [y, z, x];
  const columns = [
    [0, 1, 0],
    [0, 0, 1],
    [1, 0, 0],
  ].map((axis) =>
    toGltf(
      sourceRotate(
        axis.map((v, i) => v * scales[i]),
        angles,
      ),
    ),
  );
  return [
    ...columns[0],
    0,
    ...columns[1],
    0,
    ...columns[2],
    0,
    ...toGltf(origin).map((v) => v * 0.0254),
    1,
  ];
}

// S2V may export an animated prop as a placed armature and a separate,
// identity-transform mesh. A shared or detached skeleton cannot identify a single placement.
function placedMeshMatrix(node, stem) {
  const skin = node.getSkin();
  if (!skin) return node.getWorldMatrix();
  if (skin.listParents().filter((parent) => parent.propertyType === 'Node').length !== 1) return;
  if (!node.getWorldMatrix().every((v, i) => Math.abs(v - (i % 5 === 0 ? 1 : 0)) <= 0.00001))
    return;
  const joints = skin.listJoints();
  if (!joints.length || joints.length > 256) return;
  const members = new Set(joints);
  const roots = joints.filter((joint) => !members.has(joint.getParentNode()));
  if (roots.length !== 1) return;
  const anchor = roots[0].getParentNode();
  if (
    !anchor ||
    anchor.getName() !== stem ||
    anchor.getMesh() ||
    anchor.listChildren().length !== 1
  )
    return;
  if (
    joints.some((joint) => joint.listParents().some((p) => p.propertyType === 'Skin' && p !== skin))
  )
    return;
  return anchor.getWorldMatrix();
}

/** Bind an unparented, independently identifiable Source entity to its intact pre-batch mesh.
 * Duplicate source placements, ambiguous node parts and unrecognized/absent models remain static. */
export function tagBreakableGeometry(document, dumps) {
  const rows = entityDumpRows(dumps, fields);
  const usedIds = new Map();
  const placements = new Map();
  let eligible = 0;
  for (const row of rows) {
    if (typeof row.hammeruniqueid === 'string')
      usedIds.set(row.hammeruniqueid, (usedIds.get(row.hammeruniqueid) ?? 0) + 1);
    if (
      typeof row.model !== 'string' ||
      row.model.length > 256 ||
      !modelPath.test(row.model) ||
      !vec3(row.origin, 1e7) ||
      !vec3(row.angles, 3600)
    )
      continue;
    const scales = row.scales ?? new Array(3).fill(row.scale ?? 1);
    if (!vec3(scales, 1024) || scales.some((s) => s === 0)) continue;
    const allowed =
      row.classname === 'prop_dynamic' &&
      !row.parentname &&
      !yes(row.uselocaloffset) &&
      !yes(row.startdisabled) &&
      !yes(row.clientsideentity) &&
      typeof row.hammeruniqueid === 'string' &&
      hammerId.test(row.hammeruniqueid) &&
      (row['@OnBreak'] || (Number.isFinite(Number(row.health)) && Number(row.health) > 0));
    const stem = basename(row.model, '.vmdl');
    if (!placements.has(stem)) placements.set(stem, []);
    placements
      .get(stem)
      .push({ row, matrix: placedMatrix({ ...row, scales }), allowed, nodes: [] });
    if (allowed) eligible++;
  }
  if (!eligible || eligible > breakableLimits.active) return 0;
  const candidates = new Map(
    [...placements].filter(
      ([, places]) => places.length <= breakableLimits.active && places.some((p) => p.allowed),
    ),
  );
  for (const node of document.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (
      !mesh ||
      node.getExtension('EXT_mesh_gpu_instancing') ||
      node.listChildren().length ||
      node.getExtras().cswatchBreakable
    )
      continue;
    const name = node.getName(),
      stem = name.split('.', 1)[0];
    const possible = candidates.get(stem);
    if (!possible || mesh.getName().split('.', 1)[0] !== stem) continue;
    const matrix = placedMeshMatrix(node, stem);
    if (!matrix) continue;
    const matches = possible.filter((placement) =>
      placement.matrix.every(
        (v, i) => Math.abs(matrix[i] - v) <= (i >= 12 && i <= 14 ? 0.0005 : 0.0001),
      ),
    );
    if (matches.length === 1 && matches[0].allowed) matches[0].nodes.push(node);
  }
  let tagged = 0;
  for (const places of candidates.values())
    for (const { row, nodes } of places) {
      if (nodes.length !== 1 || usedIds.get(row.hammeruniqueid) !== 1) continue;
      const [node] = nodes;
      node.setExtras({
        ...node.getExtras(),
        cswatchBreakable: {
          hammerId: row.hammeruniqueid,
          className: row.classname,
          model: row.model,
          modelId: modelResourceId(row.model),
          origin: row.origin,
          angles: row.angles,
        },
      });
      tagged++;
    }
  return tagged;
}
