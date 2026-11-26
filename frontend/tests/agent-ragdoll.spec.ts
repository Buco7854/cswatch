import { expect, test } from '@playwright/test';
import { Matrix4, Quaternion, Triangle, Vector3 } from 'three';
import { createRagdollSimulation, validRagdoll, type RagdollData } from '../src/agent-ragdoll';

// A synthetic two-body chain: a torso capsule and a head sphere joined at the neck.
const ragdoll: RagdollData = {
  schemaVersion: 1,
  bodies: [
    {
      bone: 'torso',
      mass: 50,
      linearDamping: 0,
      angularDamping: 2,
      shapes: [{ a: [0, 0, 0], b: [0, 0.6, 0], radius: 0.15 }],
    },
    {
      bone: 'head',
      mass: 10,
      linearDamping: 0,
      angularDamping: 2,
      shapes: [{ a: [0, 0.1, 0], b: [0, 0.1, 0], radius: 0.1 }],
    },
  ],
  joints: [
    {
      body1: 0,
      body2: 1,
      frame1: { position: [0, 0.6, 0], rotation: [0, 0, 0.7071068, 0.7071068] },
      frame2: { position: [0, 0, 0], rotation: [0, 0, 0.7071068, 0.7071068] },
      swing: [0, 0.6],
      twist: [-0.5, 0.5],
      friction: 0.4,
    },
  ],
};
const floor = [
  new Triangle(new Vector3(-20, 0, -20), new Vector3(20, 0, -20), new Vector3(-20, 0, 20)),
  new Triangle(new Vector3(20, 0, -20), new Vector3(20, 0, 20), new Vector3(-20, 0, 20)),
];
const world = {
  nearby: (_o: Vector3, _r: number, accept: (t: Triangle) => void) => floor.forEach(accept),
};
function run(height: number) {
  const bones = new Map([
    ['torso', new Matrix4().makeTranslation(0, height, 0)],
    ['head', new Matrix4().makeTranslation(0, height + 0.6, 0)],
  ]);
  const simulation = createRagdollSimulation(
    ragdoll,
    {
      bones,
      velocity: new Vector3(0.5, 0, 0),
      impulse: { body: 1, direction: new Vector3(0, 0, -1), speed: 3 },
    },
    world,
  );
  simulation.advanceTo(4);
  const frames: number[][] = [];
  const worlds = [new Matrix4(), new Matrix4()];
  for (let t = 0; t <= 4; t += 0.25) {
    simulation.sample(t, worlds);
    frames.push(worlds.flatMap((m) => m.toArray()));
  }
  return { simulation, frames };
}

test('the ragdoll is deterministic, rests on the floor and keeps its joint', () => {
  const a = run(0.5),
    b = run(0.5);
  expect(a.frames).toEqual(b.frames);
  const last = a.frames.at(-1)!;
  const torso = new Matrix4().fromArray(last.slice(0, 16)),
    head = new Matrix4().fromArray(last.slice(16, 32));
  // Resting: the torso capsule lies on the floor, not in it.
  const position = new Vector3().setFromMatrixPosition(torso);
  expect(position.y).toBeGreaterThan(0.1);
  expect(position.y).toBeLessThan(0.3);
  // The neck joint holds: the head stays where the torso's frame puts it.
  const neck = new Vector3(0, 0.6, 0).applyMatrix4(torso);
  expect(neck.distanceTo(new Vector3().setFromMatrixPosition(head))).toBeLessThan(0.03);
  expect(a.simulation.settled).toBe(true);
});

test('a body starting inside the floor is eased out instead of launched', () => {
  const { frames } = run(-0.12);
  const heights = frames.map(
    (frame) => new Vector3().setFromMatrixPosition(new Matrix4().fromArray(frame.slice(0, 16))).y,
  );
  expect(Math.max(...heights)).toBeLessThan(0.35);
});

test('ragdoll data is validated before use', () => {
  expect(validRagdoll(ragdoll)).toBe(ragdoll);
  expect(validRagdoll({ ...ragdoll, schemaVersion: 2 })).toBeUndefined();
  expect(
    validRagdoll({ ...ragdoll, joints: [{ ...ragdoll.joints[0], body2: 7 }] }),
  ).toBeUndefined();
  expect(
    validRagdoll({
      ...ragdoll,
      bodies: [{ ...ragdoll.bodies[0], shapes: [{ a: [0, 0, 0], b: [0, 1e9, 0], radius: 0.1 }] }],
    }),
  ).toBeUndefined();
  expect(new Quaternion(...ragdoll.joints[0].frame1.rotation).length()).toBeCloseTo(1, 6);
});
