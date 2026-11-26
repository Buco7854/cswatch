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
