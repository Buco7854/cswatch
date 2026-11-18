import type { PlayerColumns } from '../../src/parser-fields.js';

export function columnsOf(rows: Record<string, unknown>[]): PlayerColumns {
  const fields = new Set(rows.flatMap((row) => Object.keys(row)));
  return Object.fromEntries([...fields].map((field) => [field, rows.map((row) => row[field])]));
}
