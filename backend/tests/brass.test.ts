import assert from 'node:assert/strict';
import test from 'node:test';
import {
  brassCues,
  brassFlight,
  brassLanding,
  brassSounds,
  brassSystems,
  brassVelocity,
  weaponBrass,
} from '../../frontend/src/brass.js';
import registry from '../../shared/equipment-models.json' with { type: 'json' };
import sounds from '../../shared/gameplay-sounds.json' with { type: 'json' };

test('every firearm with an ejecting fire clip has an official casing system and model', () => {
  const items = registry.items as Record<string, { kind: string }>;
  for (const [weapon, { system, at }] of Object.entries(weaponBrass)) {
    assert.equal(items[weapon]?.kind, 'weapon', weapon);
    assert.ok(at >= 0 && at < 1, weapon);
    assert.equal(items[brassSystems[system].model]?.kind, 'casing', system);
  }
  // The revolver and Zeus emit no brass on a shot.
  assert.equal(weaponBrass.revolver, undefined);
  assert.equal(weaponBrass.taser, undefined);
  for (const { samples } of Object.values(brassSounds))
    for (const id of samples) assert.ok(Object.hasOwn((sounds as { items: object }).items, id), id);
});

test('a casing falls on a closed-form arc, lands once and stays where it touched down', () => {
  const system = brassSystems.rifle;
  const velocity = brassVelocity(system, 42);
  assert.deepEqual(velocity, brassVelocity(system, 42));
  velocity.forEach((value, axis) =>
    assert.ok(
      value >= Math.min(system.speedMin[axis], system.speedMax[axis]) &&
        value <= Math.max(system.speedMin[axis], system.speedMax[axis]),
    ),
  );
  const landing = brassLanding(velocity[2], 56, system.life)!;
  assert.ok(landing > 0.2 && landing < 1, String(landing));
  const before = brassFlight(velocity, landing - 0.01, 56, landing);
  const after = brassFlight(velocity, landing + 1, 56, landing);
  assert.ok(before.offset[2] > -56 && !before.landed);
  assert.equal(after.offset[2], -56);
  assert.ok(after.landed);
  assert.deepEqual(after.offset, brassFlight(velocity, landing + 1.5, 56, landing).offset);
  // A port below the floor cannot fall; a casing still airborne at the end of its life never lands.
  assert.equal(brassLanding(velocity[2], 0, system.life), 0);
  assert.equal(brassLanding(velocity[2], 1e6, system.life), undefined);
});

test('landing cues follow each recorded shot, block for 0.4 s per shooter and stay bounded', () => {
  const shooter = { x: 0, y: 0, z: 0, eyeOffset: [64] };
  const spray = Array.from({ length: 30 }, (_, i) => ({
    tick: 1000 + i * 6,
    weapon: 'ak47',
    actor: 'a',
    seed: i,
  }));
  const cues = brassCues(spray, 64, () => shooter);
  assert.deepEqual(
    cues,
    brassCues(spray, 64, () => shooter),
  );
  for (let i = 1; i < cues.length; i++) assert.ok(cues[i].tick - cues[i - 1].tick >= 0.4 * 64);
  assert.ok(cues.length < spray.length && cues.length > 0);
  assert.ok(cues.every((cue) => cue.tick > 1000 && cue.evidence === 'recorded-state'));
  assert.ok(cues.every((cue) => cue.eventName === 'Bounce.Shell'));
  // Pump and bolt actions eject later in their fire clip; shotguns use the shotgun shell.
  const [pump] = brassCues([{ tick: 0, weapon: 'nova', actor: 'b', seed: 1 }], 64, () => shooter);
  assert.equal(pump.eventName, 'Bounce.ShotgunShell');
  assert.ok(pump.tick > 0.33 * 64);
  assert.deepEqual(
    brassCues([{ tick: 0, weapon: 'revolver', actor: 'c', seed: 1 }], 64, () => shooter),
    [],
  );
  assert.deepEqual(
    brassCues(spray, 64, () => undefined),
    [],
  );
});
