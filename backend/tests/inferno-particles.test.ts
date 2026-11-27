import assert from 'node:assert/strict';
import test from 'node:test';
import { fireLayers, fireLights, fireParticles } from '../../frontend/src/inferno-particles.js';

const points = [
  { position: [1, 0, 2] as const, seed: 3.2, from: 10, until: 17 },
  { position: [2, 0, 2] as const, seed: 7.9, from: 10.5, until: 17 },
];

test('fire particles are a pure function of demo time and recorded points', () => {
  for (const layer of ['ground', 'flame', 'ember', 'smoke', 'glow'] as const) {
    assert.deepEqual(fireParticles(layer, points, 12.34), fireParticles(layer, points, 12.34));
    // Nothing before ignition; a seek backwards gives the same answer as playing forward.
    assert.deepEqual(fireParticles(layer, points, 9.9), []);
    assert.ok(fireParticles(layer, points, 13).length <= fireLayers[layer].cap);
  }
  // Flames live out their lifetime after the recorded end, then stop.
  assert.ok(fireParticles('flame', points, 17.3).length > 0);
  assert.deepEqual(fireParticles('flame', points, 17 + fireLayers.flame.life[1] + 0.01), []);
  // Smoke starts after its authored delay.
  assert.deepEqual(fireParticles('smoke', points, 10.5), []);
  // The scorch stays once the ground has burned.
  assert.equal(fireParticles('scorch', points, 30).length, 2);
  for (const particle of fireParticles('ground', points, 13))
    assert.ok(
      particle.alpha >= 0 && particle.alpha <= 1 && particle.life >= 0 && particle.life < 1,
    );
});

test('a burning area casts one flickering light that follows its recorded points', () => {
  assert.deepEqual(fireLights(points, 9), []);
  const [light] = fireLights(points, 12);
  assert.equal(fireLights(points, 12).length, 1);
  assert.deepEqual(fireLights(points, 12), fireLights(points, 12));
  assert.ok(light.radius > 120 && light.radius <= 480);
  assert.ok(light.color.every((channel) => channel > 0 && channel <= 1.2));
  assert.deepEqual(fireLights(points, 17), []);
});
