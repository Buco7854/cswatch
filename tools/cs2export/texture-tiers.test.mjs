import assert from 'node:assert/strict';
import test from 'node:test';
import { materialCap, phonePlan } from './texture-tiers.mjs';

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

test('a lightmap atlas takes the irradiance extent and resamples the others by whole factors', () => {
  const kinds = ['irradiance', 'directional_irradiance', 'direct_light_shadows'];
  const sizes = {
    irradiance: [256, 512],
    directional_irradiance: [512],
    direct_light_shadows: [256],
  };
  const textures = {},
    sourceLevels = new Map();
  for (const kind of kinds) {
    const name = 'w/lightmaps/' + kind + '.vtex';
    const levels = sizes[kind].map((w, i) => ({ w, h: w / 2, offset: i * 64 }));
    textures[name] = {
      file: 'a'.repeat(64) + '.bin',
      format: kind === 'irradiance' ? 'BC6H' : 'DXT5',
      levels,
    };
    sourceLevels.set(name, levels);
  }
  const manifest = {
    arrays: [],
    specials: {},
    environments: [{ world: 'w', entities: [] }],
    geometry: { vb: 'v', ib: 'i' },
    files: { v: { size: 1 }, i: { size: 1 } },
  };
  const { items, targets } = phonePlan(manifest, { textures, files: {} }, sourceLevels);
  assert.equal(targets[0].kind, 'lightmap');
  const [level] = items[0].levels;
  assert.deepEqual([level.w, level.h], [512, 256]);
  assert.deepEqual(
    level.slices.map((s) => [s.w, s.h, s.profile]),
    [
      [512, 256, 'hdr'],
      [512, 256, 'linear'],
      [256, 128, 'linear'],
    ],
  );
  sizes.directional_irradiance = [384];
  textures['w/lightmaps/directional_irradiance.vtex'].levels = [{ w: 384, h: 192, offset: 0 }];
  sourceLevels.set('w/lightmaps/directional_irradiance.vtex', [{ w: 384, h: 192, offset: 0 }]);
  assert.throws(
    () => phonePlan(manifest, { textures, files: {} }, sourceLevels),
    /Unmatched lightmap extents/,
  );
});
