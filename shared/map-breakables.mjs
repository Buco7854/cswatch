export const breakableLimits = Object.freeze({ active: 256, tracks: 512, intervals: 8192 });
const triple = (v, bound) =>
  Array.isArray(v) &&
  v.length === 3 &&
  [0, 1, 2].every((i) => Number.isFinite(v[i]) && Math.abs(v[i]) <= bound);

/** The prepared map and the network use the same model resource ID and Source-space pose.
 * Only equivalent complete turns are normalized. Nearby poses never match. */
export function breakableKey(row) {
  if (
    !row ||
    typeof row.modelId !== 'string' ||
    !/^[1-9]\d{0,19}$/.test(row.modelId) ||
    (row.modelId.length === 20 && row.modelId > '18446744073709551615') ||
    !triple(row.origin, 1e7) ||
    !triple(row.angles, 3600)
  )
    return;
  return [
    row.modelId,
    ...row.origin,
    ...row.angles.map((a) => (a % 360 < 0 ? (a % 360) + 360 : a % 360)),
  ].join('/');
}
/** Leave duplicate prepared identities unbound, including repeated tags on different nodes. */
export function uniqueBreakableNodes(wanted, visit) {
  const matches = new Map();
  visit((node, tag) => {
    if (
      tag?.className !== 'prop_dynamic' ||
      typeof tag.hammerId !== 'string' ||
      !tag.hammerId ||
      tag.hammerId.length > 128 ||
      typeof tag.model !== 'string' ||
      tag.model.length > 256 ||
      !tag.model.endsWith('.vmdl')
    )
      return;
    const key = breakableKey(tag);
    if (key && wanted.has(key)) matches.set(key, matches.has(key) ? null : node);
  });
  return matches;
}

export function validMapBreakables(rows, lastTick) {
  if (
    !Array.isArray(rows) ||
    !rows.length ||
    rows.length > breakableLimits.tracks ||
    !Number.isSafeInteger(lastTick)
  )
    return false;
  const seen = new Set();
  let total = 0;
  for (const row of rows) {
    const key = breakableKey(row);
    if (
      !key ||
      seen.has(key) ||
      Object.keys(row).length !== 4 ||
      !Array.isArray(row.hidden) ||
      !row.hidden.length
    )
      return false;
    seen.add(key);
    total += row.hidden.length;
    if (total > breakableLimits.intervals) return false;
    let end = -1;
    for (const span of row.hidden) {
      if (
        !Array.isArray(span) ||
        span.length !== 2 ||
        !Number.isSafeInteger(span[0]) ||
        !Number.isSafeInteger(span[1]) ||
        span[0] < 0 ||
        span[0] < end ||
        span[0] >= span[1] ||
        span[1] > lastTick + 1
      )
        return false;
      end = span[1];
    }
  }
  return true;
}
