import assert from 'node:assert/strict';
import test from 'node:test';
import {
  burstLayers,
  burstParticles,
  detonationLights,
  sparkLayer,
  sparkParticles,
  type Detonation,
} from '../../frontend/src/explosion-particles.js';
import { packEffectLights } from '../../frontend/src/effect-lights.js';

const at = (age: number, kind: Detonation['kind'] = 'he', seed = 91): Detonation => ({
  id: kind + seed,
  kind,
  origin: [100, -200, 30],
  age,
  seed,
});

test('detonation particles are a pure function of the recorded detonation and its age', () => {
  for (const layer of burstLayers) {
    const burst = [at(0.4, layer.kind)];
    assert.deepEqual(burstParticles(layer, burst), burstParticles(layer, burst));
    assert.ok(burstParticles(layer, Array(12).fill(at(0.01, layer.kind))).length <= layer.cap);
    assert.deepEqual(burstParticles(layer, [at(-0.01, layer.kind)]), []);
    for (const particle of burstParticles(layer, burst))
      assert.ok(
        particle.alpha > 0 &&
          particle.alpha <= 1 &&
          particle.life >= 0 &&
          particle.life < 1 &&
          particle.size > 0 &&
          particle.position.every(Number.isFinite),
      );
  }
  assert.deepEqual(sparkParticles([at(0.3)]), sparkParticles([at(0.3)]));
  assert.ok(sparkParticles(Array(6).fill(at(0.2))).length <= sparkLayer.cap);
});

test('each official layer keeps its authored life', () => {
  const layer = (id: string) => burstLayers.find((entry) => entry.id === id)!;
  // The core flare and the flashbang flare are gone after a quarter second.
  assert.equal(burstParticles(layer('he-core'), [at(0.1)]).length, 1);
  assert.deepEqual(burstParticles(layer('he-core'), [at(0.26)]), []);
  assert.equal(burstParticles(layer('flash-flare'), [at(0.05, 'flash')]).length, 1);
  assert.deepEqual(burstParticles(layer('flash-flare'), [at(0.26, 'flash')]), []);
  // A flashbang draws no HE layer and the reverse.
  assert.deepEqual(burstParticles(layer('he-core'), [at(0.1, 'flash')]), []);
  // The fireball's three particles are emitted 0.05 s apart.
  assert.equal(burstParticles(layer('he-core-smoke'), [at(0.03)]).length, 1);
  assert.equal(burstParticles(layer('he-core-smoke'), [at(0.12)]).length, 3);
  // The scorch outlives the smoke and is projected only onto a floor within 30 inches;
  // debris settles on the traced floor.
  const above = (age: number, floor?: number) => ({ ...at(age), floor });
  assert.equal(burstParticles(layer('he-scorch'), [above(15, 10)]).length, 1);
  assert.ok(
    Math.abs(burstParticles(layer('he-scorch'), [above(15, 10)])[0].position[1] - 10.6 * 0.0254) <
      1e-9,
  );
  assert.deepEqual(burstParticles(layer('he-scorch'), [above(15, -10)]), []);
  assert.deepEqual(burstParticles(layer('he-scorch'), [at(15)]), []);
  assert.deepEqual(burstParticles(layer('he-core-smoke'), [at(2.1)]), []);
  for (const particle of burstParticles(layer('he-debris'), [above(2.9, 12)]))
    assert.ok(particle.position[1] >= 12 * 0.0254 - 1e-9);
  // Sparks stop after their carriers' half-second of emission and short lives.
  assert.deepEqual(sparkParticles([at(1.2)]), []);
});

test('the HE light lasts 0.225 s and only the strongest four lights reach the world', () => {
  assert.equal(detonationLights([at(0.05)]).length, 1);
  assert.deepEqual(detonationLights([at(0.23)]), []);
  assert.deepEqual(detonationLights([at(0.05, 'flash')]), []);
  const [light] = detonationLights([at(0)]);
  assert.equal(light.radius, 160);
  assert.ok(light.color[0] > light.color[1] && light.color[1] > light.color[2]);
  const data = new Float32Array(32);
  const set = new Map([
    [
      'a',
      Array.from({ length: 6 }, (_, i) => ({ ...light, position: [i * 10 + 1, 2, 3] as const })),
    ],
  ]);
  assert.equal(packEffectLights(set, [0, 0, 0], data), 4);
  // Nearest first, in Source inches: scene x stays x, -z becomes y and y becomes z.
  const expected = [1 / 0.0254, -3 / 0.0254, 2 / 0.0254, 160];
  data.slice(0, 4).forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 1e-2));
  assert.ok(Math.abs(data[8] - 11 / 0.0254) < 1e-2);
  assert.equal(packEffectLights(undefined, [0, 0, 0], data), 0);
});
