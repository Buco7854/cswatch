export const breakableLimits = Object.freeze({ active: 256, tracks: 512, intervals: 8192 });
const triple = (v, bound) =>
  Array.isArray(v) &&
  v.length === 3 &&
  [0, 1, 2].every((i) => Number.isFinite(v[i]) && Math.abs(v[i]) <= bound);

// Brush and prop entities can legitimately occupy the same pose and use the same model.
const resourceKey = (row) =>
  row.className === 'func_breakable' || row.className === 'func_brush'
    ? row.className + '/' + row.modelId
    : row.modelId;

/** Exact identity prior to any join at a recording's declared wire precision. */
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
    resourceKey(row),
    ...row.origin,
    ...row.angles.map((a) => (a % 360 < 0 ? (a % 360) + 360 : a % 360)),
  ].join('/');
}
/** Leave duplicate prepared identities unbound, including repeated tags on different nodes. */
function uniqueMapNodes(wanted, visit, classes, getKey) {
  const matches = new Map();
  if (!wanted.size) return matches;
  visit((node, tag) => {
    if (
      !classes.includes(tag?.className) ||
      typeof tag.hammerId !== 'string' ||
      !tag.hammerId ||
      tag.hammerId.length > 128 ||
      typeof tag.model !== 'string' ||
      tag.model.length > 256 ||
      !tag.model.endsWith('.vmdl')
    )
      return;
    const key = getKey(tag);
    if (key && wanted.has(key)) matches.set(key, matches.has(key) ? null : node);
  });
  return matches;
}

export const breakablePoseCodec = 'cell32-angle20';
const fullTurn = 2 ** 20;

// Fixed Source cell offsets have 32 levels per inch. qangle_precise has
// 2^20 uniformly spaced levels per turn. At exact half steps the encoder's
// tie rule is unverified, so both adjacent bins must remain unbound.
function wirePose(row, tie) {
  const values = [
    ...row.origin.map((n) => Math.fround(n) * 32),
    ...row.angles.map((n) => ((Math.fround(n) % 360) * fullTurn) / 360),
  ];
  const integer = values.map(Math.round);
  const key = () =>
    [
      resourceKey(row),
      ...integer.map((v, i) => (i < 3 ? v : ((v % fullTurn) + fullTurn) % fullTurn)),
    ].join('/');
  const half = values.flatMap((v, i) => (v - Math.floor(v) === 0.5 ? [i] : []));
  if (!half.length) return key();
  if (tie) {
    function visit(at) {
      if (at === half.length) {
        tie(key());
        return;
      }
      const i = half[at];
      integer[i] = Math.floor(values[i]);
      visit(at + 1);
      integer[i]++;
      visit(at + 1);
    }
    visit(0);
  }
}

export function uniqueBreakableNodes(tracks, visit) {
  return uniquePoseNodes(tracks, visit, ['prop_dynamic', 'func_breakable']);
}
export function uniqueVisibilityNodes(tracks, visit) {
  return uniquePoseNodes(tracks, visit, ['prop_dynamic', 'func_brush']);
}
function uniquePoseNodes(tracks, visit, classes) {
  const matches = new Map();
  if (!tracks?.length) return matches;
  const quantized = new Set(),
    wanted = new Map(),
    ambiguous = new Set();
  for (const row of tracks) {
    if (row.poseCodec === breakablePoseCodec && breakableKey(row)) {
      const wire = wirePose(row);
      if (wire) quantized.add(wire);
    }
  }
  function target(row, raw) {
    if (!quantized.size) return 'exact/' + raw;
    const wire = wirePose(row, (neighbor) => {
      if (quantized.has(neighbor)) ambiguous.add('wire/' + neighbor);
    });
    return wire && quantized.has(wire) ? 'wire/' + wire : 'exact/' + raw;
  }
  for (const row of tracks) {
    const raw = breakableKey(row);
    if (!raw) continue;
    const key = target(row, raw);
    const group = wanted.get(key);
    if (group) {
      group.push(raw);
      ambiguous.add(key);
    } else wanted.set(key, [raw]);
  }
  const found = uniqueMapNodes(wanted, visit, classes, (tag) => {
    const raw = breakableKey(tag);
    if (raw) return target(tag, raw);
  });
  for (const [key, group] of wanted) {
    if (ambiguous.has(key)) {
      for (const raw of group) matches.set(raw, null);
    } else if (found.has(key)) matches.set(group[0], found.get(key));
  }
  return matches;
}
export function uniqueDoorNodes(wanted, visit) {
  return uniqueMapNodes(wanted, visit, ['prop_door_rotating'], doorKey);
}
export function doorAnglesMatch(recorded, authored) {
  return (
    triple(recorded, 3600) &&
    triple(authored, 3600) &&
    recorded.every(
      (angle, i) => Math.abs(((((angle - authored[i] + 180) % 360) + 360) % 360) - 180) <= 0.01,
    )
  );
}

export function validMapBreakables(rows, lastTick) {
  return validIntervals(rows, lastTick, 'hidden');
}
export function validMapVisibility(rows, lastTick) {
  return validIntervals(rows, lastTick, 'visible');
}
function validIntervals(rows, lastTick, field) {
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
      (row.poseCodec !== undefined && row.poseCodec !== breakablePoseCodec) ||
      (field === 'hidden'
        ? row.className !== undefined && row.className !== 'func_breakable'
        : !['prop_dynamic', 'func_brush'].includes(row.className)) ||
      Object.keys(row).length !==
        4 + Number(row.poseCodec !== undefined) + Number(row.className !== undefined) ||
      !Array.isArray(row[field]) ||
      !row[field].length
    )
      return false;
    seen.add(key);
    total += row[field].length;
    if (total > breakableLimits.intervals) return false;
    let end = -1;
    for (const span of row[field]) {
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

export const doorLimits = Object.freeze({ active: 64, tracks: 256, samples: 65536 });

/** A door's unquantized network closedPosition is a float32 pivot. Compiled
 * entity text prints those floats in decimal; require their exact float32 value. */
export function doorKey(row) {
  if (!breakableKey(row)) return;
  return [row.modelId, ...row.origin.map(Math.fround)].join('/');
}

export function validMapDoors(rows, lastTick) {
  if (
    !Array.isArray(rows) ||
    !rows.length ||
    rows.length > doorLimits.tracks ||
    !Number.isSafeInteger(lastTick) ||
    lastTick < 0
  )
    return false;
  const seen = new Set();
  let used = 0;
  for (const row of rows) {
    const key = doorKey(row);
    if (
      !key ||
      seen.has(key) ||
      Object.keys(row).some(
        (field) => !['origin', 'angles', 'modelId', 'samples', 'hidden', 'models'].includes(field),
      )
    )
      return false;
    seen.add(key);
    if (
      !Array.isArray(row.samples) ||
      !Array.isArray(row.hidden) ||
      (row.models !== undefined && (!Array.isArray(row.models) || !row.models.length))
    )
      return false;
    const count = row.samples.length + row.hidden.length + (row.models?.length ?? 0);
    if (!count || (used += count) > doorLimits.samples) return false;
    for (const [samples, kind] of [
      [row.samples, 'yaw'],
      [row.hidden, 'hidden'],
      [row.models ?? [], 'model'],
    ]) {
      let next = 0;
      for (const sample of samples) {
        if (!Array.isArray(sample) || sample.length !== 2) return false;
        const [tick, value] = sample;
        if (!Number.isSafeInteger(tick) || tick < next || tick > lastTick) return false;
        next = tick + 1;
        if (kind === 'hidden') {
          if (!Number.isSafeInteger(value) || value <= tick || value > lastTick + 1) return false;
          next = value;
        } else if (kind === 'yaw') {
          if (value !== null && (!Number.isFinite(value) || value < -180 || value > 180))
            return false;
        } else if (value !== null && !breakableKey({ ...row, modelId: value })) return false;
      }
    }
  }
  return true;
}
