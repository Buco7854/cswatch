import assert from 'node:assert/strict';
import test from 'node:test';
import { impactSurfaceProperty } from '../../frontend/src/shot-impacts.js';
import { wallImpactSample, wallImpactSampleFor } from '../../frontend/src/shot-wall-audio.js';
import registry from '../../shared/gameplay-sounds.json' with { type: 'json' };

test('a contact plays its surface property’s official bullet impact', () => {
  const cases: [string, string, string][] = [
    ['de_mirage/tile/floor_tile_01', 'Tile.BulletImpact', 'Impact.Tile'],
    ['metal/metal_grate_02', 'MetalGrate.BulletImpact', 'Impact.Metal'],
    ['props/metal_sheet', 'SolidMetal.BulletImpact', 'Impact.Metal'],
    ['wood/wood_planks', 'Wood.BulletImpact', 'Impact.Wood'],
    ['nature/sand_01', 'Sand.BulletImpact', 'Impact.Dirt'],
    ['glass/window_01', 'Glass.BulletImpact', 'Impact.Glass'],
    ['walls/plaster_white', 'Concrete.BulletImpact', 'Impact.Plaster'],
    ['', 'Concrete.BulletImpact', 'Impact.Concrete'],
  ];
  const events = registry.events as Record<string, { soundId: string }>;
  for (const [name, sound, decal] of cases) {
    assert.deepEqual(impactSurfaceProperty(name), { sound, decal }, name);
    assert.ok(events[sound], sound);
    assert.ok(Object.hasOwn(registry.items, events[sound].soundId), sound);
    assert.equal(wallImpactSampleFor(name), events[sound].soundId);
  }
  assert.notEqual(wallImpactSampleFor('metal'), wallImpactSample);
});
