import assert from 'node:assert/strict';
import test from 'node:test';
import { materialCap } from './texture-tiers.mjs';

const material = (scale) => ({ vectors: scale ? { g_vTexCoordScale: scale } : {} });
// One UV unit across 256 inches is one texel per inch at 256 texels.
test('caps follow texels per placed inch at the default 1.25 target', () => {
  assert.equal(materialCap(material(), { world: 256 ** 2, uv: 1 }), 512);
  assert.equal(materialCap(material(), { world: 100 ** 2, uv: 1 }), 256);
  assert.equal(materialCap(material(), { world: 600 ** 2, uv: 1 }), 1024);
  assert.equal(materialCap(material(), { world: 1e9, uv: 1 }), 1024);
  assert.equal(materialCap(material([4, 4]), { world: 256 ** 2, uv: 1 }), 256);
});
test('materials without a resolved UV footprint keep the smallest cap', () => {
  assert.equal(materialCap(material(), undefined), 256);
  assert.equal(materialCap(material(), { world: 0, uv: 0 }), 256);
  assert.equal(materialCap(material(), { world: 10, uv: 0 }), 256);
});
