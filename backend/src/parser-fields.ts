type Row = Record<string, unknown>;
type ReadRows = (fields: string[]) => Row[];

/** Unsupported optional properties cannot erase unrelated economy/input groups. */
export function readPlayerRows(read: ReadRows, base: string[], groups: string[][]): Row[] {
  try {
    return read([...base, ...groups.flat()]);
  } catch {
    /* Retry optional groups independently. */
  }
  const rows = read(base);
  const index = new Map(rows.map((row) => [`${row.tick}:${row.steamid}`, row]));
  const merge = (extra: Row[]) => {
    for (const row of extra) {
      const target = index.get(`${row.tick}:${row.steamid}`);
      if (!target) continue;
      for (const [field, value] of Object.entries(row))
        if (value !== undefined && value !== null) target[field] = value;
    }
  };
  for (const group of groups) {
    try {
      merge(read(group));
    } catch {
      for (const field of group) {
        try {
          merge(read([field]));
        } catch {
          /* Capability remains unavailable. */
        }
      }
    }
  }
  return rows;
}
