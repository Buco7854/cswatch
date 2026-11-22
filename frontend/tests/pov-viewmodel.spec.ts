import { expect, test } from '@playwright/test';
import { Group, PerspectiveCamera, Scene, Vector3, type WebGLRenderer } from 'three';
import { povFar, povNear, povOffset, povProjection, scopedVerticalFov } from '../src/pov-camera';
import { landingEnvelope, povDraw, povLanding, povMovement } from '../src/pov-movement';
import { renderPovEquipment, updatePovCamera } from '../src/pov-render';
import type { Frame, Playback, Position } from '../src/types';

const actor: Position = {
  id: '76561198000000001',
  alive: true,
  team: 3,
  health: 100,
  weapon: 'ak47',
  x: 12,
  y: 8,
  z: 0,
  yaw: 179,
  pitch: 0,
};
const sample = (tick: number, patch: Partial<Position> = {}): Frame => ({
  tick,
  players: [{ ...actor, ...patch }],
});
const history = (frames: Frame[], rounds: Playback['rounds'] = []) => ({
  frames,
  rounds,
  tickRate: 64,
});

test('POV projection fits tall canvases and keeps square pixels at each aspect', () => {
  const tangent = (fov: number) => Math.tan((fov * Math.PI) / 360);
  const reference = povProjection(4 / 3);
  expect(tangent(reference.fov) * reference.aspect).toBeCloseTo(tangent(68), 10);
  for (const aspect of [4 / 3, 16 / 9, 21 / 9, 390 / 844]) {
    const view = povProjection(aspect);
    expect(view.aspect).toBe(aspect);
    expect(tangent(view.fov) * aspect).toBeCloseTo(tangent(reference.fov) * Math.max(1, aspect));
    const camera = new PerspectiveCamera(view.fov, aspect, povNear, povFar);
    const projected = new Vector3(povOffset.right, povOffset.up, -povOffset.forward - 0.35).project(
      camera,
    );
    expect(projected.x).toBeGreaterThan(0);
    expect(projected.x).toBeLessThan(1);
    expect(projected.y).toBeLessThan(0);
    expect(projected.y).toBeGreaterThan(-1);
  }
  expect(povProjection(NaN)).toEqual(povProjection(16 / 9));
  expect(povProjection(0)).toEqual(povProjection(16 / 9));
});

test('POV camera shares the eye transform through world FOV and scope changes, with its own clip planes', () => {
  const world = new PerspectiveCamera(48, 16 / 9, 0.05, 3000);
  const parent = new Group();
  parent.position.set(3, 1, -2);
  parent.rotation.y = 0.27;
  parent.add(world);
  world.position.set(-12, 8, 21);
  world.rotation.set(0.2, 1.2, 0);
  const pov = new PerspectiveCamera(50, 1, povNear, povFar);
  updatePovCamera(world, pov, 16 / 9);
  const projection = pov.projectionMatrix.clone();
  const muzzle = new Vector3(0.27, -0.12, -0.78).applyMatrix4(world.matrixWorld);
  const pixel = muzzle.clone().project(pov);
  for (const fov of [
    100,
    scopedVerticalFov({ ...actor, weapon: 'awp', scoped: true, scopeFov: 10 })!,
    48,
  ]) {
    world.fov = fov;
    world.updateProjectionMatrix();
    updatePovCamera(world, pov, 16 / 9);
    expect(world.fov).toBe(fov);
    expect(pov.projectionMatrix.equals(projection)).toBe(true);
    expect(muzzle.clone().project(pov)).toEqual(pixel);
  }
  expect(pov.near).toBe(povNear);
  expect(pov.far).toBe(povFar);
  expect(pov.position.distanceTo(world.getWorldPosition(new Vector3()))).toBeLessThan(1e-10);
  updatePovCamera(world, pov, 390 / 844);
  expect(pov.aspect).toBe(390 / 844);
  expect(pov.projectionMatrix.equals(projection)).toBe(false);
});

test('POV pass keeps world and equipment cameras distinct and restores state on draw failure', () => {
  const world = new Scene();
  const equipment = new Scene();
  world.environmentIntensity = 2;
  equipment.environmentIntensity = 0.4;
  const worldCamera = new PerspectiveCamera();
  const povCamera = new PerspectiveCamera();
  const calls: string[] = [];
  const renderer = {
    autoClear: true,
    clearDepth: () => calls.push('depth'),
    render(scene: Scene, camera: PerspectiveCamera) {
      if (scene === world) {
        expect(camera).toBe(worldCamera);
        expect(this.autoClear).toBe(true);
        calls.push('world');
      } else {
        expect(camera).toBe(povCamera);
        expect(this.autoClear).toBe(false);
        expect(equipment.environmentIntensity).toBe(1);
        calls.push('equipment');
        throw new Error('draw failed');
      }
    },
  };
  for (const worldAlreadyRendered of [false, true]) {
    calls.length = 0;
    expect(() =>
      renderPovEquipment(
        renderer as unknown as WebGLRenderer,
        world,
        equipment,
        worldCamera,
        povCamera,
        worldAlreadyRendered,
        0.5,
      ),
    ).toThrow('draw failed');
    expect(calls).toEqual(
      worldAlreadyRendered ? ['depth', 'equipment'] : ['world', 'depth', 'equipment'],
    );
    expect(renderer.autoClear).toBe(true);
    expect(equipment.environmentIntensity).toBe(0.4);
  }
});

test('landing is a bounded dip after observed descent and settling', () => {
  expect(landingEnvelope(-0.01, 7)).toBe(0);
  expect(landingEnvelope(0, 7)).toBe(0);
  expect(landingEnvelope(0.055, 7)).toBeGreaterThan(0.04);
  expect(landingEnvelope(0.055, 100)).toBeCloseTo(0.048);
  expect(landingEnvelope(0.13, 7)).toBeLessThan(landingEnvelope(0.055, 7));
  expect(landingEnvelope(0.24, 7)).toBe(0);
  expect(landingEnvelope(0.055, 1)).toBe(0);

  const frames = [
    sample(4, { z: 36 }),
    sample(8, { z: 16 }),
    sample(12),
    sample(16),
    sample(20),
    sample(24),
    sample(28),
    sample(32),
  ];
  const dip = (frame: number, fraction: number, overlap = frames) =>
    povLanding(
      history(overlap),
      frames.find((f) => f.tick === frame)!.players[0],
      frame,
      frame + fraction,
    );
  const first = dip(20, 0.25);
  expect(dip(12, 3.9)).toBe(0);
  expect(dip(16, 0)).toBe(0);
  expect(first).toBeGreaterThan(0.025);
  expect(dip(32, 0)).toBe(0);
  expect(dip(20, 0.25, frames.slice(1))).toBe(first);
  expect(dip(20, 0.25)).toBe(first);
  for (const invalid of [
    history([sample(8, { z: 100 }), ...frames.slice(2)]),
    history([sample(8, { z: 16, alive: false }), ...frames.slice(2)]),
    history([sample(8, { z: 16, id: '76561198000000002' }), ...frames.slice(2)]),
    history(frames, [{ number: 2, tick: 16 }]),
    history(frames.map((f) => sample(f.tick, { z: -f.tick }))),
  ]) {
    expect(povLanding(invalid, actor, 20, 20.25)).toBe(0);
  }
});

test('turn lag uses the shortest recorded angle and preserves the pose at shared samples', () => {
  const wrapped = { ...actor, yaw: -179 };
  const next = { ...actor, yaw: -177 };
  const timing = { fromTick: 8, nextTick: 12, tickRate: 64 };
  const before = povMovement(actor, wrapped, 1, timing, undefined, 7);
  const after = povMovement(
    wrapped,
    next,
    0,
    { ...timing, fromTick: 12, nextTick: 16 },
    {
      tick: 8,
      position: actor,
    },
    7,
  );
  expect(before?.yaw).toBeCloseTo(-32 * 0.00008);
  expect(before?.side).toBeGreaterThan(0);
  expect(after).toEqual(before);
  expect(povMovement(wrapped, actor, 1, timing)?.yaw).toBeCloseTo(32 * 0.00008);
  expect(povMovement(actor, wrapped, 1, timing, undefined, 7)).toEqual(before);
});

test('optional draw samples actual contiguous weapon switches, including in overlap', () => {
  const frames = [
    sample(4, { weapon: 'weapon_awp' }),
    sample(8),
    sample(12, { weapon: 'weapon_ak47' }),
    sample(16),
  ];
  const draw = (cut: Frame[]) => povDraw(history(cut), actor, 16, 18, 0.45);
  expect(draw(frames)).toEqual({ age: 10 / 64, weight: 1 });
  expect(draw(frames.slice(1))).toBeUndefined();
  expect(povDraw(history(frames), actor, 16, 45, 0.45)).toBeUndefined();
  expect(draw(frames)).toEqual({ age: 10 / 64, weight: 1 });
});
