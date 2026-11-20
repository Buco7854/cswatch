export type PlayerColumns = Record<string, unknown[]>;
type ReadColumns = (fields: string[]) => unknown;
export const playerRowLimit = 180000 * 64;
export const recordedCameraFov = 'CCSPlayerPawn.CCSPlayer_CameraServices.m_iFOV';
export const recordedReloadTickLimit = 256;

/** The native SoA bridge includes aligned identity columns even for optional-only queries. */
export function playerColumns(value: unknown, maxRows = playerRowLimit): PlayerColumns {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid player columns');
  const columns = value as PlayerColumns;
  if (
    !Array.isArray(columns.tick) ||
    !Array.isArray(columns.steamid) ||
    columns.tick.length > maxRows ||
    Object.values(columns).some(
      (column) => !Array.isArray(column) || column.length !== columns.tick.length,
    )
  )
    throw new Error('Invalid player columns');
  return columns;
}

/** Unsupported optional properties cannot erase unrelated economy/input groups.
 * Keep column arrays throughout: materializing a complete row object per player
 * and tick duplicates most of a full match while native query output is live. */
export function readPlayerColumns(
  read: ReadColumns,
  base: string[],
  groups: string[][],
  maxRows = playerRowLimit,
): PlayerColumns {
  const query = (fields: string[]) => playerColumns(read(fields), maxRows);
  try {
    return query([...base, ...groups.flat()]);
  } catch {
    /* Retry optional groups independently. */
  }
  const columns = query(base);
  let identityIndex: Map<string, number> | undefined;
  const identity = (data: PlayerColumns, index: number) => {
    const tick = data.tick[index],
      id = data.steamid[index];
    return Number.isSafeInteger(tick) && typeof id === 'string' && /^\d{1,20}$/.test(id)
      ? `${tick}:${id}`
      : undefined;
  };
  const merge = (extra: PlayerColumns) => {
    const aligned =
      extra.tick.length === columns.tick.length &&
      extra.tick.every(
        (tick, index) =>
          tick === columns.tick[index] && extra.steamid[index] === columns.steamid[index],
      );
    if (!aligned && !identityIndex) {
      identityIndex = new Map();
      for (let index = 0; index < columns.tick.length; index++) {
        const key = identity(columns, index);
        if (key !== undefined) identityIndex.set(key, index);
      }
    }
    const targets = aligned ? undefined : new Uint32Array(extra.tick.length).fill(0xffffffff);
    if (targets)
      for (let index = 0; index < extra.tick.length; index++) {
        const key = identity(extra, index);
        const target = key === undefined ? undefined : identityIndex!.get(key);
        if (target !== undefined) targets[index] = target;
      }
    for (const [field, values] of Object.entries(extra)) {
      // Identity is supplied by the base query and is never replaced by an
      // optional result. Display names must never be used to join rows.
      if (field === 'tick' || field === 'steamid' || field === 'name') continue;
      const previous = columns[field];
      if (aligned && !previous) {
        columns[field] = values;
        continue;
      }
      const target = previous ?? Array<unknown>(columns.tick.length).fill(undefined);
      for (let index = 0; index < values.length; index++) {
        const value = values[index];
        if (value === undefined || value === null) continue;
        const targetIndex = targets ? targets[index] : index;
        if (targetIndex !== 0xffffffff) target[targetIndex] = value;
      }
      columns[field] = target;
    }
  };
  for (const group of groups) {
    try {
      merge(query(group));
    } catch {
      for (const field of group) {
        try {
          merge(query([field]));
        } catch {
          /* Capability remains unavailable. */
        }
      }
    }
  }
  return columns;
}
