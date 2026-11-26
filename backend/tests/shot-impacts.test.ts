import assert from 'node:assert/strict';
import test from 'node:test';
import {
  impactLifetime,
  impactSprites,
  impactStyle,
  impactSurface,
  spritesPerImpact,
} from '../../frontend/src/shot-impacts.js';

test('authored material names select the impact surface family', () => {
  assert.equal(impactSurface('materials/de_mirage/metal/metal_sheet_01.vmat'), 'metal');
  assert.equal(impactSurface('materials/de_mirage/wood/wood_crate_02.vmat'), 'wood');
  assert.equal(impactSurface('materials/de_mirage/ground/sand_01.vmat'), 'soil');
  assert.equal(impactSurface('materials/glass/window_01.vmat'), 'glass');
  assert.equal(impactSurface('materials/de_mirage/plaster/plaster_wall_03.vmat'), 'mineral');
  assert.equal(impactSurface(undefined), 'mineral');
});

test('impacts are deterministic at a tick, bounded, and end with their lifetime', () => {
  const at = (age: number, surface: Parameters<typeof impactSprites>[2]) =>
    impactSprites([1, 2, 3], [0, 0, -1], surface, age, 41);
  assert.deepEqual(at(0.1, 'mineral'), at(0.1, 'mineral'));
  for (const surface of ['metal', 'wood', 'soil', 'glass', 'mineral'] as const)
    for (const age of [0, 0.02, 0.2, 0.5]) assert.ok(at(age, surface).length <= spritesPerImpact);
  assert.deepEqual(at(impactLifetime, 'metal'), []);
  assert.deepEqual(at(-0.01, 'metal'), []);
  // Metal throws sparks; soil only dust.
  assert.ok(at(0.05, 'metal').some((sprite) => sprite.style === impactStyle.spark));
  assert.ok(at(0.05, 'soil').every((sprite) => sprite.style === impactStyle.dust));
  // Dust rises back towards the shooter.
  assert.ok(at(0.4, 'mineral').every((sprite) => sprite.position[2] >= 3 - 1e-9));
});
