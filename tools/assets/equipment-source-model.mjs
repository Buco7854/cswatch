/** Native model metadata selection. Never export every default/legacy/arm body group together. */
const maximum = 4 * 1024 ** 2;
function dump(text, block) {
  if (
    typeof text !== 'string' ||
    Buffer.byteLength(text) > maximum ||
    text.includes('\0') ||
    !text.includes(`--- Data for block "${block}" ---`)
  )
    throw Error('Expected bounded native model block DATA.');
  return text;
}
function integers(text, key) {
  const rows = [...text.matchAll(new RegExp('^\\s*' + key + '\\s*=\\s*\\[([^\\]]*)\\]', 'gm'))];
  if (rows.length !== 1 || !/^[\d,\s]*$/.test(rows[0][1]))
    throw Error('Missing/ambiguous native mesh group masks.');
  return rows[0][1]
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const value = BigInt(x);
      if (value > 18446744073709551615n) throw Error('Native mask exceeds uint64.');
      return value;
    });
}
export function inspectEquipmentSourceModel({ data, control }) {
  data = dump(data, 'DATA');
  control = dump(control, 'CTRL');
  const defaults = [...data.matchAll(/^\s*m_nDefaultMeshGroupMask\s*=\s*(\d+)\s*$/gm)];
  if (defaults.length !== 1) throw Error('Native model has no unique default group mask.');
  const defaultMask = BigInt(defaults[0][1]),
    groups = integers(data, 'm_refMeshGroupMasks'),
    lod = integers(data, 'm_refLODGroupMasks');
  const refs = [...data.matchAll(/^\s*m_refMeshes\s*=\s*\[([^\]]*)\]/gm)];
  if (refs.length !== 1 || refs[0][1].trim())
    throw Error('Only proven embedded native equipment meshes are currently supported.');
  const embedded = [
    ...control.matchAll(/\bm_Name\s*=\s*"([a-zA-Z0-9_-]{1,100})"\s+m_nMeshIndex\s*=\s*(\d+)/g),
  ].map((match) => ({ name: match[1], index: Number(match[2]) }));
  if (
    !embedded.length ||
    embedded.length > 128 ||
    new Set(embedded.map((x) => x.index)).size !== embedded.length ||
    new Set(embedded.map((x) => x.name)).size !== embedded.length ||
    groups.length !== lod.length ||
    groups.length !== embedded.length ||
    defaultMask > 18446744073709551615n
  )
    throw Error('Native embedded mesh metadata is inconsistent.');
  let lowest = 0n;
  for (const value of lod)
    if (value) {
      const bit = value & -value;
      if (!lowest || bit < lowest) lowest = bit;
    }
  const selected = embedded.filter(
    (mesh) =>
      mesh.index < groups.length &&
      (groups[mesh.index] & defaultMask) !== 0n &&
      (lod[mesh.index] & lowest) !== 0n,
  );
  if (!selected.length) throw Error('Native default mesh and LOD masks select no geometry.');
  return {
    schemaVersion: 1,
    defaultMask: String(defaultMask),
    lodBit: String(lowest),
    meshes: selected.map((x) => x.name),
    excludedMeshes: embedded.filter((x) => !selected.includes(x)).map((x) => x.name),
    animationMode: 'omitted',
  };
}
/** Animations/skin customization are intentionally not required by a static S2V export.
 * Skeleton resources remain allowed; their small authored data may be needed by rigs. */
export function staticModelDependency(resource) {
  return !/\.(?:vnmgraph|vnmclip|vanim|vagrp|vseq|vgcxdata)_c$/.test(resource);
}
