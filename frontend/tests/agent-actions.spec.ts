import { test, expect } from '@playwright/test';
import { Bone, Matrix4, Quaternion, Vector3 } from 'three';
import { solveTwoBone, createGripRig } from '../src/agent-grip';
import { flinchRole } from '../src/agent-evidence';
import { readActionBank } from '../src/agent-actions';
import {
  agentActionRoles,
  agentActionKind,
  agentActionDeclarations,
} from '../../shared/agent-actions.mjs';

function arm() {
  const root = new Bone();
  const upper = new Bone(),
    lower = new Bone(),
    hand = new Bone();
  upper.position.set(0, 1.4, 0);
  lower.position.set(0.3, 0, 0);
  hand.position.set(0.28, 0, 0);
  root.add(upper);
  upper.add(lower);
  lower.add(hand);
  // A slightly bent elbow defines the bending plane.
  lower.quaternion.setFromAxisAngle(new Vector3(0, 0, 1), -0.3);
  root.updateWorldMatrix(true, true);
  return { root, upper, lower, hand };
}

test('two-bone IK places the hand on a reachable target with the requested rotation', () => {
  const { upper, lower, hand } = arm();
  const rotation = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.7);
  const target = new Matrix4().compose(new Vector3(0.35, 1.2, 0.2), rotation, new Vector3(1, 1, 1));
  const lengths = [lower.position.length(), hand.position.length()];
  solveTwoBone(upper, lower, hand, target, 1);
  const reached = hand.getWorldPosition(new Vector3());
  expect(reached.distanceTo(new Vector3(0.35, 1.2, 0.2))).toBeLessThan(1e-4);
  expect(hand.getWorldQuaternion(new Quaternion()).angleTo(rotation)).toBeLessThan(1e-4);
  // Bone lengths never change: IK only rotates joints.
  expect(lower.position.length()).toBeCloseTo(lengths[0], 9);
  expect(hand.position.length()).toBeCloseTo(lengths[1], 9);
  // An unreachable target straightens the arm toward it without stretching.
  solveTwoBone(upper, lower, hand, new Matrix4().makeTranslation(3, 1.4, 0), 1);
  const far = hand.getWorldPosition(new Vector3());
  expect(far.distanceTo(upper.getWorldPosition(new Vector3()))).toBeLessThanOrEqual(0.58 + 1e-6);
  expect(far.y).toBeCloseTo(1.4, 3);
});

test('zero IK weight leaves the authored pose untouched', () => {
  const { upper, lower, hand } = arm();
  const before = [upper, lower, hand].map((bone) => bone.quaternion.clone());
  solveTwoBone(upper, lower, hand, new Matrix4().makeTranslation(0.2, 1, 0.3), 0);
  [upper, lower, hand].forEach((bone, index) =>
    expect(bone.quaternion.equals(before[index])).toBe(true),
  );
});

test('grip rig requires the authored weapon bone and both arm chains', () => {
  const { root } = arm();
  expect(createGripRig(root)).toBeUndefined();
});

test('recorded hitgroups and shot sides select Valve flinch clips that exist in the bank', () => {
  expect(flinchRole('head', 'rear')).toBe('flinch:head-rear');
  expect(flinchRole('head', 'front')).toBe('flinch:head');
  expect(flinchRole('chest', 'left')).toBe('flinch:chest-left');
  expect(flinchRole('stomach', 'left')).toBe('flinch:stomach');
  expect(flinchRole('stomach', 'rear')).toBe('flinch:stomach-rear');
  expect(flinchRole('left_leg', 'front')).toBe('flinch:leg-left');
  expect(flinchRole('generic', 'right')).toBe('flinch:chest-right');
  for (const group of [
    'head',
    'neck',
    'chest',
    'stomach',
    'left_arm',
    'right_arm',
    'left_leg',
    'right_leg',
    'generic',
  ])
    for (const side of ['front', 'left', 'right', 'rear'])
      expect(agentActionRoles).toContain(flinchRole(group, side));
});

test('the action bank requires its complete declared role set', () => {
  const declarations = agentActionRoles.map((role) => ({
    name: 'cswatch:' + role,
    extras: {
      cswatch: {
        kind: 'native-agent-action',
        schemaVersion: 1,
        role,
        blend: agentActionKind(role),
        ...(role.startsWith('ladder') ? { climbMeters: 1 } : {}),
      },
    },
  }));
  expect(agentActionDeclarations(declarations)?.size).toBe(agentActionRoles.length);
  expect(agentActionDeclarations(declarations.slice(1))).toBeUndefined();
  const wrongBlend = structuredClone(declarations);
  wrongBlend[0].extras.cswatch.blend = 'full';
  expect(agentActionDeclarations(wrongBlend)).toBeUndefined();
  const noClimb = structuredClone(declarations);
  delete (
    noClimb.find((item) => item.name.startsWith('cswatch:ladder'))!.extras.cswatch as {
      climbMeters?: number;
    }
  ).climbMeters;
  expect(agentActionDeclarations(noClimb)).toBeUndefined();
  // Clip and declaration counts must agree before any curve is bound.
  expect(readActionBank([], declarations)).toBeUndefined();
});

test('recorded footsteps follow the authored distance curve and stop where the game does', async () => {
  const { authoredDistanceGain } = await import('../src/sound-distance');
  expect(authoredDistanceGain('CT_Concrete.StepLeft', 116.563)).toBeCloseTo(1, 3);
  expect(authoredDistanceGain('ct_concrete.stepleft', 402.286)).toBeCloseTo(0.489, 3);
  expect(authoredDistanceGain('CT_Concrete.StepLeft', 1100)).toBe(0);
  expect(authoredDistanceGain('CT_Concrete.StepLeft', 5000)).toBe(0);
  expect(authoredDistanceGain('Player.Death', 1400)).toBe(0);
  expect(authoredDistanceGain('Weapon_AK47.Single', 300)).toBeUndefined();
  expect(authoredDistanceGain(undefined, 300)).toBeUndefined();
});

function standing(yaws: number[], extra: (i: number) => object = () => ({})) {
  return {
    tickRate: 64,
    rounds: [],
    events: [],
    capabilities: { pawnMovement: true },
    frames: yaws.map((yaw, i) => ({
      tick: i * 4,
      players: [
        {
          id: 'p',
          x: 0,
          y: 0,
          z: 0,
          yaw,
          pitch: 0,
          alive: true,
          team: 2,
          health: 100,
          weapon: 'ak47',
          ...extra(i),
        },
      ],
    })),
  } as unknown as Parameters<typeof import('../src/agent-evidence').recordedTwist>[0];
}

test('standing feet keep their yaw within the aim cone and turn once the aim leaves it', async () => {
  const { recordedTwist } = await import('../src/agent-evidence');
  // Aim sweeps 0 -> 40 degrees: inside the cone the spine carries all of it.
  const small = standing([0, 10, 20, 30, 40, 40]);
  expect(recordedTwist(small, 'p', 20, 40)).toBeCloseTo(40, 6);
  // A quick 120 degree turn: the feet follow and settle within 12 degrees of the aim.
  const large = standing([0, 60, 120, 120, 120, 120, 120, 120, 120, 120, 120, 120, 120]);
  const settled = recordedTwist(large, 'p', 48, 120);
  expect(Math.abs(settled)).toBeLessThanOrEqual(12);
  // Deterministic for any seek order.
  expect(recordedTwist(large, 'p', 48, 120)).toBe(settled);
  expect(recordedTwist(large, 'p', 8, 120)).toBe(recordedTwist(large, 'p', 8, 120));
  // A moving player faces the aim.
  const moving = standing([0, 90, 90], (i) => ({ x: i * 40 }));
  expect(recordedTwist(moving, 'p', 8, 90)).toBe(0);
});

test('a standing turn reports its side, the angle turned and the settle after the feet stop', async () => {
  const { recordedStance } = await import('../src/agent-evidence');
  // Inside the cone: no step.
  expect(recordedStance(standing([0, 10, 20, 30, 40, 40]), 'p', 20, 40).turn).toBeUndefined();
  // Aim swings 90 degrees to the left (Source yaw grows to the left).
  const left = standing([0, 90, 90, 90, 90, 90, 90, 90, 90]);
  const during = recordedStance(left, 'p', 5, 90).turn!;
  expect(during.side).toBe('left');
  expect(during.restAge).toBeUndefined();
  const later = recordedStance(left, 'p', 24, 90);
  expect(later.turn!.side).toBe('left');
  expect(later.turn!.turned).toBeGreaterThan(during.turned);
  expect(later.turn!.turned).toBeCloseTo(90 - Math.abs(later.twist), 6);
  expect(later.turn!.restAge).toBeGreaterThan(0);
  expect(recordedStance(left, 'p', 24, 90)).toEqual(later);
  const right = standing([90, 0, 0, 0, 0, 0]);
  expect(recordedStance(right, 'p', 12, 0).turn!.side).toBe('right');
  // A moving player takes no standing step.
  expect(
    recordedStance(
      standing([0, 90, 90], (i) => ({ x: i * 40 })),
      'p',
      8,
      90,
    ).turn,
  ).toBeUndefined();
});

test('airborne weight and landing age come from the recorded ground flag', async () => {
  const { recordedAir } = await import('../src/agent-evidence');
  const data = standing([0, 0, 0, 0, 0, 0], (i) => (i >= 2 && i <= 3 ? { airborne: true } : {}));
  expect(recordedAir(data, 'p', 4)?.weight).toBe(0);
  const air = recordedAir(data, 'p', 12)!;
  expect(air.jumpAge).toBeCloseTo(4 / 64, 6);
  expect(air.weight).toBeGreaterThan(0);
  const landed = recordedAir(data, 'p', 18)!;
  expect(landed.landAge).toBeCloseTo(2 / 64, 6);
  // Without the recorded capability the state stays unknown.
  expect(recordedAir({ ...data, capabilities: undefined }, 'p', 12)).toBeUndefined();
});
