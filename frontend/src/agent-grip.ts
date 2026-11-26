import { Bone, MathUtils, Matrix4, Quaternion, Vector3, type Object3D } from 'three';

const a = new Vector3(),
  b = new Vector3(),
  c = new Vector3(),
  t = new Vector3(),
  ac = new Vector3(),
  ab = new Vector3(),
  at = new Vector3(),
  ba = new Vector3(),
  bc = new Vector3(),
  axis0 = new Vector3(),
  axis1 = new Vector3(),
  local = new Vector3(),
  parentRotation = new Quaternion(),
  rotation = new Quaternion(),
  before = new Quaternion(),
  targetRotation = new Quaternion(),
  scale = new Vector3(),
  goal = new Matrix4();
const angle = (x: Vector3, y: Vector3) =>
  Math.acos(MathUtils.clamp(x.dot(y) / Math.max(x.length() * y.length(), 1e-9), -1, 1));

/** Rotate `bone` by `radians` about a world-space axis, in its parent's frame. */
function rotateWorld(bone: Object3D, worldAxis: Vector3, radians: number) {
  if (!radians || !Number.isFinite(radians) || worldAxis.lengthSq() < 1e-12) return;
  bone.getWorldQuaternion(parentRotation).invert();
  local.copy(worldAxis).normalize().applyQuaternion(parentRotation);
  bone.quaternion.multiply(rotation.setFromAxisAngle(local, radians));
  bone.updateWorldMatrix(false, true);
}

/** Analytic two-bone IK (shoulder, elbow, hand) that keeps the current elbow plane,
 * then sets the hand's world rotation. `weight` blends from the incoming pose. */
export function solveTwoBone(upper: Bone, lower: Bone, end: Bone, target: Matrix4, weight: number) {
  if (!(weight > 0)) return;
  const saved = [upper.quaternion.clone(), lower.quaternion.clone(), end.quaternion.clone()];
  upper.updateWorldMatrix(true, true);
  target.decompose(t, targetRotation, scale);
  upper.getWorldPosition(a);
  lower.getWorldPosition(b);
  end.getWorldPosition(c);
  const lab = b.distanceTo(a),
    lcb = c.distanceTo(b);
  const lat = MathUtils.clamp(t.distanceTo(a), 1e-4, (lab + lcb) * 0.9999);
  ac.subVectors(c, a);
  ab.subVectors(b, a);
  at.subVectors(t, a);
  ba.subVectors(a, b);
  bc.subVectors(c, b);
  const acab0 = angle(ac, ab),
    babc0 = angle(ba, bc),
    acat0 = angle(ac, at);
  const acab1 = Math.acos(
    MathUtils.clamp((lcb * lcb - lab * lab - lat * lat) / (-2 * lab * lat), -1, 1),
  );
  const babc1 = Math.acos(
    MathUtils.clamp((lat * lat - lab * lab - lcb * lcb) / (-2 * lab * lcb), -1, 1),
  );
  axis0.crossVectors(ac, ab);
  if (axis0.lengthSq() < 1e-10) axis0.crossVectors(ac, bc);
  axis1.crossVectors(ac, at);
  rotateWorld(upper, axis0, acab1 - acab0);
  rotateWorld(lower, axis0, babc1 - babc0);
  rotateWorld(upper, axis1, acat0);
  end.parent!.getWorldQuaternion(parentRotation).invert();
  end.quaternion.copy(parentRotation.multiply(targetRotation));
  if (weight < 1)
    [upper, lower, end].forEach((bone, index) => {
      before.copy(saved[index]);
      bone.quaternion.copy(before.slerp(bone.quaternion, weight));
    });
  upper.updateWorldMatrix(false, true);
}

export type GripRig = ReturnType<typeof createGripRig>;
/** Both hands on the held weapon: each hand returns to its authored transform in the
 * weapon bone's frame, read from that weapon's own idle pose. */
export function createGripRig(root: Object3D) {
  const bone = (name: string) => {
    const node = root.getObjectByName(name);
    return node instanceof Bone ? node : undefined;
  };
  const weapon = bone('wpn');
  const arms = (['L', 'R'] as const).map((side) => {
    const chain = [bone('arm_upper_' + side), bone('arm_lower_' + side), bone('hand_' + side)];
    return chain.every(Boolean) && chain[1]!.parent === chain[0] && chain[2]!.parent === chain[1]
      ? (chain as [Bone, Bone, Bone])
      : undefined;
  });
  if (!weapon || arms.some((arm) => !arm)) return;
  const offsets = new Map<string, [Matrix4, Matrix4] | null>();
  return {
    /** Cache the authored hand-in-weapon transforms for one weapon. */
    offsets(key: string, read: (hand: string, target: Matrix4) => boolean) {
      if (!offsets.has(key)) {
        const left = new Matrix4(),
          right = new Matrix4();
        offsets.set(key, read('hand_L', left) && read('hand_R', right) ? [left, right] : null);
      }
      return offsets.get(key) ?? undefined;
    },
    apply(grip: [Matrix4, Matrix4], left: number, right: number) {
      weapon.updateWorldMatrix(true, false);
      for (const [index, amount] of [
        [1, right],
        [0, left],
      ] as const) {
        if (!(amount > 0)) continue;
        goal.multiplyMatrices(weapon.matrixWorld, grip[index]);
        const [upper, lower, end] = arms[index]!;
        solveTwoBone(upper, lower, end, goal, amount);
      }
    },
  };
}
