import { expect, test } from '@playwright/test';
import { Group, Matrix4, Object3D } from 'three';
import { indexWeaponFire, nativeWeaponPose, weaponFireAt } from '../src/weapon-fire';
import { nativeMuzzleFrame } from '../src/equipment-model';
import { createMuzzleResources } from '../src/muzzle-resources';
import { povMovement } from '../src/pov-movement';
import { recordedMotion } from '../src/recorded-motion';
import type { Playback, Position } from '../src/types';

const id = '76561198000000001',
  other = '76561198000000002';
const actor: Position = {
  id,
  alive: true,
  weapon: 'AK-47',
  x: 0,
  y: 0,
  z: 0,
  yaw: 0,
  pitch: 0,
  health: 100,
  team: 3,
};
const recording = (events: Playback['events']) => ({
  sample: false,
  players: [
    { id, name: 'twin', team: 3 },
    { id: other, name: 'twin', team: 2 },
  ],
  events,
});

test('held rigs move with contiguous recorded motion and replay the same stride after seeking', () => {
  const timing = { fromTick: 96, nextTick: 100, tickRate: 64 };
  const next = { ...actor, x: 11 };
  const movement = povMovement(actor, next, 0.25, timing);
  expect(movement).toBeDefined();
  expect(povMovement(actor, next, 0.75, timing)).not.toEqual(movement);
  expect(povMovement(actor, next, 0.25, timing)).toEqual(movement);
  expect(povMovement(actor, actor, 0.25, timing)).toBeUndefined();
  expect(povMovement(actor, { ...next, id: other }, 0.25, timing)).toBeUndefined();
  expect(povMovement(actor, { ...next, z: 300 }, 0.25, timing)).toBeUndefined();
  expect(povMovement(actor, next, 0.25, { ...timing, roundBoundary: true })).toBeUndefined();
});

test('recorded motion blends across sample boundaries and wraps camera turns', () => {
  const current = { ...actor, x: 8, yaw: 179 };
  const next = { ...actor, x: 13, yaw: -179 };
  const later = { ...actor, x: 32, yaw: -177 };
  const at = recordedMotion(current, next, 1, { fromTick: 8, nextTick: 12, tickRate: 64 });
  const after = recordedMotion(
    next,
    later,
    0,
    { fromTick: 12, nextTick: 16, tickRate: 64 },
    {
      position: current,
      tick: 8,
    },
  );
  expect(after).toEqual(at);
  expect(at.yaw).toBe(32);
  expect(
    recordedMotion(next, { ...later, x: 20_000 }, 0.5, {
      fromTick: 12,
      nextTick: 16,
      tickRate: 64,
    }).speed,
  ).toBe(0);
});

test('rapid authored shots keep the ongoing pose at the next recorded fire boundary', () => {
  const index = indexWeaponFire(
    recording(
      [64, 71].map((tick) => ({
        type: 'weapon_fire',
        tick,
        user_steamid: id,
        weapon: 'ak47',
      })),
    ),
  );
  const pose = (tick: number) => nativeWeaponPose(index, actor, tick, 64, 0.25, 1, true);
  const before = pose(71 - 1e-6);
  const boundary = pose(71);
  expect(boundary.fire).toEqual({ age: 0, weight: 0 });
  expect(boundary.priorFire?.age).toBeCloseTo(before.fire!.age, 6);
  expect(boundary.priorFire?.weight).toBeCloseTo(before.fire!.weight, 6);
  expect(pose(72).fire?.weight).toBeGreaterThan(0);
  expect(pose(74).priorFire).toBeUndefined();
  expect(pose(71)).toEqual(boundary);
  expect(nativeWeaponPose(index, actor, 72, 64, 0.25, 1, false)).toEqual({});
});

test('shots require recorded firearm events, exact immutable identity and current weapon, with no input inference', () => {
  const index = indexWeaponFire(
    recording([
      { type: 'weapon_fire', tick: 64, user_steamid: id, weapon: 'weapon_ak47' },
      { type: 'weapon_fire', tick: 64, user_name: 'twin', weapon: 'ak47' },
      { type: 'weapon_fire', tick: 64, user_steamid: other, weapon: 'knife' },
      { type: 'weapon_fire', tick: 64, user_steamid: other, weapon: 'smokegrenade' },
      { type: 'weapon_fire', tick: 64, user_steamid: other, weapon: 'taser' },
      { type: 'player_hurt', tick: 64, user_steamid: other, weapon: 'ak47' },
      { type: 'weapon_fire', tick: NaN, user_steamid: other, weapon: 'ak47' },
      { type: 'weapon_fire', tick: 1.5, user_steamid: other, weapon: 'ak47' },
    ]),
  );
  expect(index.size).toBe(1);
  expect(weaponFireAt(index, actor, 63.99, 64)).toBeUndefined();
  expect(weaponFireAt(index, actor, 64, 64)?.flash).toBe(1);
  expect(weaponFireAt(index, { ...actor, id: other }, 64, 64)).toBeUndefined();
  expect(weaponFireAt(index, { ...actor, weapon: 'm4a4' }, 64, 64)).toBeUndefined();
  expect(weaponFireAt(index, { ...actor, alive: false }, 64, 64)).toBeUndefined();
  expect(weaponFireAt(index, actor, 64, 0)).toBeUndefined();
  expect(weaponFireAt(index, actor, Infinity, 64)).toBeUndefined();
});

test('demo-time shot sampling remains identical across pause, seek, speed and chunk replacement', () => {
  const events = [
    { type: 'weapon_fire', tick: 80, user_steamid: id, weapon: 'ak47' },
    { type: 'weapon_fire', tick: 64, user_steamid: id, weapon: 'ak47' },
  ];
  const index = indexWeaponFire(recording(events)),
    first = weaponFireAt(index, actor, 65, 64)!;
  expect(first.flash).toBeGreaterThan(0);
  expect(first.flash).toBeLessThan(1);
  expect(first.kick).toBeGreaterThan(0);
  expect(weaponFireAt(index, actor, 65, 64, true)).toEqual({ ...first, kick: 0 });
  expect(weaponFireAt(index, actor, 68, 64)?.flash).toBe(0);
  expect(weaponFireAt(index, actor, 74, 64)).toBeUndefined();
  expect(weaponFireAt(index, actor, 80, 64)?.tick).toBe(80);
  expect(weaponFireAt(index, actor, 65, 64)).toEqual(first);
  expect(weaponFireAt(indexWeaponFire(recording([...events])), actor, 65, 64)).toEqual(first);
  expect(weaponFireAt(index, actor, 63, 64)).toBeUndefined();
});

test('practice names are accepted only when unambiguous and firearm aliases remain canonical', () => {
  const data = recording([{ type: 'weapon_fire', tick: 32, user_name: 'twin', weapon: 'M4A4' }]);
  expect(indexWeaponFire({ ...data, sample: true }).size).toBe(0);
  data.players[1].name = 'someone else';
  const index = indexWeaponFire({ ...data, sample: true });
  expect(weaponFireAt(index, { ...actor, weapon: 'weapon_m4a1' }, 32, 64)?.flash).toBe(1);
});

test('native muzzle follows only the exact cloned attachment frame and rejects alien or singular roots', () => {
  const world = new Group(),
    model = new Group(),
    bone = new Group(),
    marker = new Object3D();
  marker.name = 'cswatch_native_muzzle';
  marker.userData.cswatchNativeAttachment = 'muzzle_flash';
  world.add(model);
  model.add(bone);
  bone.add(marker);
  world.position.set(23, 12, -5);
  model.rotation.y = Math.PI / 3;
  bone.position.set(0.2, 0.3, 0.1);
  marker.position.set(0.4, 0.02, 0);
  const frame = new Matrix4();
  expect(nativeMuzzleFrame(frame, model, marker)).toBe(true);
  expect(frame.elements[12]).toBeCloseTo(0.6);
  expect(frame.elements[13]).toBeCloseTo(0.32);
  expect(frame.elements[14]).toBeCloseTo(0.1);
  bone.rotation.z = Math.PI / 2;
  expect(nativeMuzzleFrame(frame, model, marker)).toBe(true);
  expect(frame.elements[12]).toBeCloseTo(0.18);
  expect(frame.elements[13]).toBeCloseTo(0.7);
  expect(nativeMuzzleFrame(frame, new Group(), marker)).toBe(false);
  marker.name = 'muzzle';
  expect(nativeMuzzleFrame(frame, model, marker)).toBe(false);
  marker.name = 'cswatch_native_muzzle';
  delete marker.userData.cswatchNativeAttachment;
  expect(nativeMuzzleFrame(frame, model, marker)).toBe(false);
  marker.userData.cswatchNativeAttachment = 'muzzle_flash';
  model.scale.set(0, 0, 0);
  expect(nativeMuzzleFrame(frame, model, marker)).toBe(false);
  expect(nativeMuzzleFrame(frame, model, undefined)).toBe(false);
});

test('procedural flash resources are instance-owned and explicitly retire once without touching another model', () => {
  const current = createMuzzleResources(),
    sibling = createMuzzleResources();
  const disposed: string[] = [];
  for (const key of ['flame', 'core', 'outer', 'inner'] as const) {
    current[key].addEventListener('dispose', () => disposed.push(key));
    sibling[key].addEventListener('dispose', () => disposed.push('sibling:' + key));
  }
  current.dispose();
  current.dispose();
  expect(disposed).toEqual(['flame', 'core', 'outer', 'inner']);
  expect(current.outer.depthWrite).toBe(false);
  expect(current.inner.toneMapped).toBe(false);
  sibling.dispose();
  expect(disposed).toHaveLength(8);
  const release = current.acquire(); // The same instance is replayed by StrictMode.
  release();
  release();
  expect(disposed).toHaveLength(12);
});
