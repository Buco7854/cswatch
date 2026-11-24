import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Bone, Group, Vector3 } from '../../frontend/node_modules/three/build/three.module.js';
import { createAgentFootLock } from '../../frontend/src/agent-feet.js';
import { recordedAirWeight } from '../../frontend/src/agent-vertical.js';

test('a foot plant stays in one world position across seeks and preserves both leg lengths', () => {
  const actor = new Group();
  const joints = ['L', 'R'].map((side, index) => {
    const offsets = [
      [0, 0.79, 0.15 * (index ? -1 : 1)],
      [0.1, -0.39, 0],
      [-0.11, -0.35, 0],
      [0.12, -0.02, 0],
    ];
    let parent: Group | Bone = actor;
    return ['leg_upper_', 'leg_lower_', 'ankle_', 'ball_'].map((prefix, joint) => {
      const bone = new Bone();
      bone.name = prefix + side;
      bone.position.fromArray(offsets[joint]);
      parent.add(bone);
      parent = bone;
      return bone;
    });
  });
  const footLock = createAgentFootLock(actor);
  assert.ok(footLock);
  const reset = () => {
    for (const leg of joints) for (const bone of leg) bone.quaternion.identity();
    return true;
  };
  const at = (tick: number) => tick / 64;
  const positionAt = (tick: number) => ({ x: tick * 0.012, y: 0, z: 0, yaw: 0, weapon: 'knife' });
  const [hip, knee, ankle, ball] = joints[0];
  const top = knee.position.length();
  const bottom = ankle.position.length();
  const point = (bone: Bone) => bone.getWorldPosition(new Vector3());
  const sample = (tick: number) => {
    actor.position.x = positionAt(tick).x;
    reset();
    footLock.prepare(actor, tick, 64, at(tick), 1, 0, at, positionAt, reset);
    reset();
    footLock.apply();
    const upper = point(knee).sub(point(hip));
    const lower = point(ankle).sub(point(knee));
    assert.ok(Math.abs(upper.length() - top) < 1e-9);
    assert.ok(Math.abs(lower.length() - bottom) < 1e-9);
    const axis = upper.clone().add(lower).normalize();
    assert.ok(upper.addScaledVector(axis, -upper.dot(axis)).x > 0);
    return point(ball);
  };
  const first = sample(14);
  assert.ok(first.distanceTo(sample(19)) < 1e-9);
  sample(78);
  assert.ok(first.distanceTo(sample(14)) < 1e-9);
});

test('one steep step and a steady climb leave the ballistic foot-lock guard inactive', () => {
  const path = (height: (seconds: number) => number) => ({
    tickRate: 64,
    rounds: [],
    frames: Array.from({ length: 10 }, (_, i) => ({
      tick: 4 * i,
      players: [
        {
          id: '1',
          x: 0,
          y: 0,
          z: height(i / 16),
          yaw: 0,
          pitch: 0,
          alive: true,
          team: 3,
          health: 100,
          weapon: 'knife',
        },
      ],
    })),
  });
  const jump = path((seconds) => 260 * seconds - 400 * seconds * seconds);
  assert.equal(recordedAirWeight(jump, '1', 2), 0);
  assert.equal(recordedAirWeight(jump, '1', 3), 1);
  assert.equal(recordedAirWeight({ ...jump, rounds: [{ number: 2, tick: 8 }] }, '1', 4), 0);
  const broken = structuredClone(jump);
  broken.frames[2].players[0].team = 2;
  assert.equal(recordedAirWeight(broken, '1', 4), 0);
  const separated = path(() => 0);
  // Gravity-like decelerations separated by a constant-speed interval.
  const heights = [0, 20, 37, 54, 68];
  heights.forEach((z, i) => (separated.frames[i].players[0].z = z));
  assert.equal(recordedAirWeight(separated, '1', 4), 0);
  const landed = path((t) => Math.max(0, 160 * t - 400 * t * t));
  const exit = landed.frames.map((_, i) => recordedAirWeight(landed, '1', i));
  assert.equal(exit[6], 1);
  assert.ok(exit[8] > 0 && exit[8] < exit[7] && exit[7] < exit[6]);
  assert.equal(exit[9], 0);
  assert.equal(
    recordedAirWeight(
      path((seconds) => seconds * 120),
      '1',
      4,
    ),
    0,
  );
  assert.equal(
    recordedAirWeight(
      path((seconds) => (seconds > 0.2 ? 30 : 0)),
      '1',
      4,
    ),
    0,
  );
});
