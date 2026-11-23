import { Bone, MathUtils, Quaternion, Vector3, type Object3D } from 'three';
import { strideDisplacement } from '../../shared/stride-distance.mjs';
import { frameAt } from './playback';
import { shortestAngle } from './player-pose';
import type { Playback } from './types';
import type { FollowCamera } from './follow-camera';

type FootTrace = (ray: Pick<FollowCamera, 'target' | 'position'>) => FollowCamera['position'];
export type FootPose = { x: number; y: number; z: number; yaw: number; weapon: string };
export type FootPoseAt = (id: string, tick: number) => FootPose | undefined;

/** Use the spatial trail's coarse yaw for both warm playback and cold chunk seeks. */
export function recordedFootPose(
  data: Pick<Playback, 'frames' | 'rounds' | 'tickRate'>,
): FootPoseAt {
  return (id, tick) => {
    const first = data.frames[0]?.tick;
    if (first === undefined || tick < first || tick > data.frames.at(-1)!.tick) return;
    const { frame, next, alpha } = frameAt(data, tick);
    const from = frame.players.find((player) => player.id === id);
    const to = next.players.find((player) => player.id === id);
    if (
      !from?.alive ||
      !to?.alive ||
      !strideDisplacement(from, to, (next.tick - frame.tick) / data.tickRate) ||
      data.rounds.some((round) => round.tick > frame.tick && round.tick <= next.tick)
    )
      return;
    return {
      x: MathUtils.lerp(from.x, to.x, alpha) * 0.0254,
      y: MathUtils.lerp(from.z, to.z, alpha) * 0.0254,
      z: -MathUtils.lerp(from.y, to.y, alpha) * 0.0254,
      yaw: MathUtils.degToRad(from.yaw + shortestAngle(from.yaw, to.yaw) * alpha),
      weapon: from.weapon,
    };
  };
}

const cycle = (phase: number) => phase - Math.floor(phase);
const smooth = (fraction: number) => MathUtils.smoothstep(fraction, 0, 1);

function plantTick(phaseAt: (tick: number) => number, tick: number, rate: number, phase: number) {
  let first = tick - 0.9 * rate;
  let last = tick;
  if (phaseAt(first) >= phase) return;
  for (let step = 0; step < 14; step++) {
    const middle = (first + last) / 2;
    if (phaseAt(middle) < phase) first = middle;
    else last = middle;
  }
  return Math.round(last * 32) / 32;
}

export function createAgentFootLock(root: Object3D) {
  const legs = ['L', 'R'].flatMap((side, index) => {
    const [hip, knee, ankle, ball] = ['leg_upper_', 'leg_lower_', 'ankle_', 'ball_'].map((name) =>
      root.getObjectByName(name + side),
    );
    if (
      !(
        hip instanceof Bone &&
        knee instanceof Bone &&
        ankle instanceof Bone &&
        ball instanceof Bone
      ) ||
      knee.parent !== hip ||
      ankle.parent !== knee ||
      ball.parent !== ankle
    )
      return [];
    return [
      {
        hip,
        knee,
        ankle,
        ball,
        offset: index * 0.5,
        anchor: new Vector3(),
        tick: -Infinity,
        weight: 0,
        clearance: 0,
      },
    ];
  });
  if (legs.length !== 2) return;
  const h = new Vector3(),
    k = new Vector3(),
    a = new Vector3(),
    b = new Vector3();
  const target = new Vector3(),
    direction = new Vector3(),
    bend = new Vector3();
  const kneeGoal = new Vector3(),
    from = new Vector3(),
    to = new Vector3();
  const up = new Vector3(0, 1, 0),
    origin = new Vector3();
  const parent = new Quaternion(),
    inverse = new Quaternion(),
    delta = new Quaternion(),
    ankleRotation = new Quaternion();
  let activeTrace: FootTrace | undefined;

  function rotate(joint: Bone, current: Vector3, desired: Vector3) {
    joint.parent!.getWorldQuaternion(parent);
    delta.setFromUnitVectors(current.normalize(), desired.normalize());
    inverse.copy(parent).invert();
    joint.quaternion.premultiply(delta.premultiply(inverse).multiply(parent)).normalize();
  }

  return {
    prepare(
      actor: Object3D,
      tick: number,
      rate: number,
      phase: number,
      speed: number,
      duck: number,
      phaseAt: (tick: number) => number,
      positionAt: (tick: number) => FootPose | undefined,
      sample: (tick: number, phase: number, pose: FootPose) => boolean,
      trace?: FootTrace,
      airborne = 0,
    ) {
      if (activeTrace !== trace) {
        for (const leg of legs) leg.tick = -Infinity;
        activeTrace = trace;
      }
      actor.getWorldPosition(origin);
      // Slower and crouched cycles support a boot for more of the step.
      const slow = Math.max(duck, 1 - smooth((speed - 3.2) / 1.6));
      const support = MathUtils.lerp(0.44, 0.59, slow);
      for (const leg of legs) {
        const elapsed = cycle(phase - leg.offset - 0.08);
        leg.weight = 0;
        leg.clearance = 0;
        if (speed < 0.38) continue;
        const start = phase - elapsed;
        const at = plantTick(phaseAt, tick, rate, start);
        if (at === undefined) continue;
        if (leg.tick !== at) {
          const pose = positionAt(at);
          if (!pose || !sample(at, start, pose)) continue;
          leg.ball.getWorldPosition(leg.anchor);
          actor.worldToLocal(leg.anchor);
          leg.anchor.applyAxisAngle(up, pose.yaw);
          leg.anchor.x += pose.x;
          leg.anchor.z += pose.z;
          leg.anchor.y = pose.y + 0.033;
          if (trace) {
            const { x, z } = leg.anchor;
            const down: FollowCamera['position'] = [x, pose.y - 0.22, z];
            const surface = trace({ target: [x, pose.y + 0.22, z], position: down });
            if (surface !== down) leg.anchor.y = surface[1] + 0.033;
          }
          leg.tick = at;
        }
        const grounded = smooth((0.43 - Math.abs(origin.y - leg.anchor.y)) / 0.18);
        const strength = grounded * smooth((speed - 0.38) / 0.32) * (1 - airborne);
        const contact = smooth(elapsed / 0.045) * smooth((support - elapsed) / 0.08);
        leg.weight = strength * smooth(contact / 0.64);
        // Release horizontal planting as the boot lifts. The original
        // crouch and backward blends can swing at floor height.
        leg.clearance = strength * MathUtils.lerp(0.062, 0.102, slow) * (1 - contact);
      }
    },
    apply() {
      for (const { hip, knee, ankle, ball, anchor, weight, clearance } of legs) {
        if (!weight && !clearance) continue;
        hip.getWorldPosition(h);
        knee.getWorldPosition(k);
        ankle.getWorldPosition(a);
        ball.getWorldPosition(b);
        const distance = b.distanceTo(anchor);
        const grip = weight * smooth((0.68 - distance) / 0.2);
        target.copy(a).addScaledVector(direction.subVectors(anchor, b), grip);
        const lift = Math.max(clearance, (weight - grip) * 0.055);
        if (lift) {
          const y = MathUtils.lerp(origin.y + 0.033, anchor.y, grip);
          target.y = Math.max(target.y, a.y + y + lift - b.y);
        }
        const upper = h.distanceTo(k),
          lower = k.distanceTo(a);
        if (upper < 0.05 || lower < 0.05) continue;
        direction.subVectors(target, h);
        const length = MathUtils.clamp(
          direction.length(),
          Math.abs(upper - lower) + 0.035,
          upper + lower - 0.008,
        );
        direction.normalize();
        // Retain the authored bend side. A degenerate hint leaves the clip untouched.
        bend.subVectors(k, h);
        bend.addScaledVector(direction, -bend.dot(direction));
        if (bend.lengthSq() < 0.0001) continue;
        const span = (upper * upper + length * length - lower * lower) / (2 * length);
        const height = Math.sqrt(Math.max(0, upper * upper - span * span));
        kneeGoal.copy(h).addScaledVector(direction, span).addScaledVector(bend.normalize(), height);
        target.copy(h).addScaledVector(direction, length);
        ankle.getWorldQuaternion(ankleRotation);
        rotate(hip, from.subVectors(k, h), to.subVectors(kneeGoal, h));
        ankle.getWorldPosition(a);
        rotate(knee, from.subVectors(a, kneeGoal), to.subVectors(target, kneeGoal));
        knee.getWorldQuaternion(parent).invert();
        ankle.quaternion.copy(parent.multiply(ankleRotation)).normalize();
      }
    },
  };
}
