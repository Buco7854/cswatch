/** Prepared official particle atlases: square cells, row-major frames, per-sequence ranges. */
export type EffectTextureSheet = {
  width: number;
  height: number;
  cell: number;
  columns: number;
  sequences: { start: number; count: number; clamp: boolean }[];
};
export type EffectTextureCatalog = {
  schemaVersion: 1;
  items: Record<string, EffectTextureSheet & { url: string; sha256: string; bytes: number }>;
};
