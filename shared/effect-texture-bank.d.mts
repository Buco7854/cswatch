export const managedEffectDirectory: string;
export const effectTextureRegistry: {
  schemaVersion: 1;
  items: Record<string, { source: string; use: string }>;
};
export const effectTextureLimits: Readonly<{
  items: number;
  sourceBytes: number;
  atlasEdge: number;
  atlasBytes: number;
  frames: number;
  sequences: number;
  bankBytes: number;
}>;
