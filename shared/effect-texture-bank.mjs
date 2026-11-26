import { createHash } from 'node:crypto';
import registry from './effect-textures.json' with { type: 'json' };

// Only the fixed sources determine the generation, as for the sound bank.
const sources = Object.keys(registry.items)
  .sort()
  .map((id) => [id, registry.items[id].source]);
export const managedEffectDirectory =
  'effects-' + createHash('sha256').update(JSON.stringify(sources)).digest('hex');
export const effectTextureRegistry = registry;
export const effectTextureLimits = Object.freeze({
  items: 32,
  sourceBytes: 16 * 1024 ** 2,
  atlasEdge: 2048,
  atlasBytes: 8 * 1024 ** 2,
  frames: 256,
  sequences: 64,
  bankBytes: 48 * 1024 ** 2,
});
