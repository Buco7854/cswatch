import { Matrix3, Matrix4, Quaternion, Triangle, Vector3, type Bone, type Object3D } from 'three';

/** The agent model's own ragdoll (bodies, capsules and limited joints from its PHYS block),
 * in skeleton bone space, metres. Prepared with the action bank. */
export type RagdollData = {
  schemaVersion: 1;
  bodies: {
    bone: string;
    mass: number;
    linearDamping: number;
    angularDamping: number;
    shapes: { a: number[]; b: number[]; radius: number }[];
  }[];
  joints: {
    body1: number;
    body2: number;
    frame1: { position: number[]; rotation: number[] };
    frame2: { position: number[]; rotation: number[] };
    swing: number[] | null;
    twist: number[] | null;
    friction: number;
  }[];
};

const finite = (values: unknown, length: number) =>
  Array.isArray(values) &&
  values.length === length &&
  values.every((v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 100);
export function validRagdoll(value: unknown): RagdollData | undefined {
  const data = value as RagdollData;
  if (
    !data ||
    data.schemaVersion !== 1 ||
    !Array.isArray(data.bodies) ||
    !data.bodies.length ||
    data.bodies.length > 32 ||
    !Array.isArray(data.joints) ||
    data.joints.length > 64 ||
    data.bodies.some(
      (body) =>
        typeof body?.bone !== 'string' ||
        !(body.mass > 0 && body.mass < 1000) ||
        !Array.isArray(body.shapes) ||
        !body.shapes.length ||
        body.shapes.length > 8 ||
        body.shapes.some(
          (shape) =>
            !finite(shape.a, 3) || !finite(shape.b, 3) || !(shape.radius > 0 && shape.radius < 1),
        ),
    ) ||
    data.joints.some(
      (joint) =>
        ![joint.body1, joint.body2].every(
          (b) => Number.isInteger(b) && b >= 0 && b < data.bodies.length,
        ) ||
        !finite(joint.frame1?.position, 3) ||
        !finite(joint.frame2?.position, 3) ||
        !finite(joint.frame1?.rotation, 4) ||
        !finite(joint.frame2?.rotation, 4) ||
        (joint.swing !== null && !finite(joint.swing, 2)) ||
        (joint.twist !== null && !finite(joint.twist, 2)),
    )
  )
    return;
  return data;
}
const ragdolls = new WeakMap<object, RagdollData | null>();
export function agentRagdoll(gltf: { parser: { json: { extras?: unknown } } }) {
  if (!ragdolls.has(gltf)) {
    const extras = gltf.parser.json.extras as { cswatch?: { kind?: string; ragdoll?: unknown } };
    ragdolls.set(
      gltf,
      (extras?.cswatch?.kind === 'native-agent-ragdoll' && validRagdoll(extras.cswatch.ragdoll)) ||
        null,
    );
  }
  return ragdolls.get(gltf) ?? undefined;
}

/** World collision the ragdoll needs: triangles near a point. */
export type RagdollWorld = {
  nearby(origin: Vector3, radius: number, accept: (triangle: Triangle) => void): void;
};
export type RagdollStart = {
  /** World matrices of the posed bones at the death tick. */
  bones: Map<string, Matrix4>;
  /** Recorded velocity at death (m/s, viewer axes). */
  velocity: Vector3;
  /** The recorded shot: the body it hit, its world direction and the speed it gives that
   * body (m/s); the rest of the body takes a share of it. */
  impulse?: { body: number; direction: Vector3; speed: number };
};

export const ragdollStep = 1 / 64;
const substeps = 8;
const gravity = -9.81;
const sleepSpeed = 0.04;
const maxSeconds = 4;
/** Bounds that keep a body starting in contact from being launched (m per substep, m/s, rad/s). */
const maxPush = 0.004;
const maxSpeed = 9;
const maxSpin = 25;

type Body = {
  x: Vector3;
  q: Quaternion;
  v: Vector3;
  w: Vector3;
  previousX: Vector3;
  previousQ: Quaternion;
  invMass: number;
  invInertia: Matrix3;
  com: Vector3;
  spheres: { local: Vector3; radius: number }[];
  linearDamping: number;
  angularDamping: number;
  triangles: Triangle[];
  bound: number;
};

const scratch = {
  a: new Vector3(),
  b: new Vector3(),
  c: new Vector3(),
  d: new Vector3(),
  e: new Vector3(),
  r1: new Vector3(),
  r2: new Vector3(),
  n: new Vector3(),
  q: new Quaternion(),
  q2: new Quaternion(),
  m: new Matrix3(),
  m2: new Matrix3(),
  closest: new Vector3(),
};

const rotationMatrix = new Matrix4(),
  transposed = new Matrix3();
function worldInverseInertia(body: Body, target: Matrix3) {
  const r = scratch.m2.setFromMatrix4(rotationMatrix.makeRotationFromQuaternion(body.q));
  return target.copy(r).multiply(body.invInertia).multiply(transposed.copy(r).transpose());
}
/** Generalised inverse mass along `n` at offset `r` from the centre of mass. */
function positionalWeight(body: Body, r: Vector3, n: Vector3) {
  if (!body.invMass) return 0;
  const rn = scratch.c.crossVectors(r, n);
  const inertia = worldInverseInertia(body, scratch.m);
  return body.invMass + rn.dot(scratch.d.copy(rn).applyMatrix3(inertia));
}
function applyPositional(body: Body, r: Vector3, impulse: Vector3, sign: number) {
  if (!body.invMass) return;
  body.x.addScaledVector(impulse, body.invMass * sign);
  const inertia = worldInverseInertia(body, scratch.m);
  const spin = scratch.e.crossVectors(r, impulse).applyMatrix3(inertia).multiplyScalar(sign);
  rotate(body.q, spin);
}
/** q += 0.5 * (spin, 0) * q */
function rotate(q: Quaternion, spin: Vector3) {
  const dq = scratch.q.set(spin.x, spin.y, spin.z, 0).multiply(q);
  q.set(q.x + 0.5 * dq.x, q.y + 0.5 * dq.y, q.z + 0.5 * dq.z, q.w + 0.5 * dq.w).normalize();
}
function angularWeight(body: Body, n: Vector3) {
  if (!body.invMass) return 0;
  const inertia = worldInverseInertia(body, scratch.m);
  return n.dot(scratch.d.copy(n).applyMatrix3(inertia));
}
function applyAngular(body: Body, axisAngle: Vector3, sign: number) {
  if (!body.invMass) return;
  const inertia = worldInverseInertia(body, scratch.m);
  rotate(body.q, scratch.e.copy(axisAngle).applyMatrix3(inertia).multiplyScalar(sign));
}
/** Rotate the two bodies by `correction` (axis * angle), shared by their angular weights. */
function solveAngular(a: Body, b: Body, correction: Vector3) {
  const angle = correction.length();
  if (angle < 1e-7) return;
  const n = scratch.n.copy(correction).divideScalar(angle);
  const w = angularWeight(a, n) + angularWeight(b, n);
  if (!(w > 0)) return;
  const lambda = scratch.r1.copy(n).multiplyScalar(angle / w);
  applyAngular(a, lambda, 1);
  applyAngular(b, lambda, -1);
}

/** Deterministic articulated ragdoll: fixed 1/64 s steps of eight XPBD substeps (Müller et al.,
 * "Detailed rigid body simulation with extended position based dynamics", 2020) with the
 * model's own bodies, joint anchors and swing/twist limits, and sphere contacts against the
 * world. The result is a bone world-transform per step, so any replay time looks it up. */
export function createRagdollSimulation(
  data: RagdollData,
  start: RagdollStart,
  world: RagdollWorld,
) {
  const bodies: Body[] = data.bodies.map((definition) => {
    const bone = start.bones.get(definition.bone)!;
    const position = new Vector3(),
      rotation = new Quaternion();
    bone.decompose(position, rotation, new Vector3());
    const com = new Vector3();
    const spheres: Body['spheres'] = [];
    let axis = new Vector3(1, 0, 0),
      length = 0,
      radius = 0;
    for (const shape of definition.shapes) {
      const a = new Vector3(...shape.a),
        b = new Vector3(...shape.b);
      com.add(a).add(b);
      const span = b.clone().sub(a);
      if (span.length() > length) {
        length = span.length();
        axis = span.lengthSq() > 1e-8 ? span.normalize() : axis;
      }
      radius = Math.max(radius, shape.radius);
      const count = Math.max(2, Math.ceil(a.distanceTo(b) / shape.radius) + 1);
      for (let i = 0; i < count; i++)
        spheres.push({ local: a.clone().lerp(b, i / (count - 1)), radius: shape.radius });
    }
    com.divideScalar(definition.shapes.length * 2);
    for (const sphere of spheres) sphere.local.sub(com);
    // A capsule's inertia about its own axis and across it, in bone space.
    const m = definition.mass;
    const along = 0.5 * m * radius * radius,
      across = (m * (3 * radius * radius + length * length)) / 12;
    const u = axis;
    const inertia = new Matrix3().set(
      across + (along - across) * u.x * u.x,
      (along - across) * u.x * u.y,
      (along - across) * u.x * u.z,
      (along - across) * u.y * u.x,
      across + (along - across) * u.y * u.y,
      (along - across) * u.y * u.z,
      (along - across) * u.z * u.x,
      (along - across) * u.z * u.y,
      across + (along - across) * u.z * u.z,
    );
    const x = com.clone().applyQuaternion(rotation).add(position);
    return {
      x,
      q: rotation,
      v: start.velocity.clone(),
      w: new Vector3(),
      previousX: x.clone(),
      previousQ: rotation.clone(),
      invMass: 1 / m,
      invInertia: inertia.invert(),
      com,
      spheres,
      linearDamping: definition.linearDamping,
      angularDamping: definition.angularDamping,
      triangles: [],
      bound: length / 2 + radius,
    };
  });
  if (start.impulse) {
    const direction = start.impulse.direction.clone().normalize();
    bodies.forEach((body, index) => {
      const share = index === start.impulse!.body ? 1 : 0.3;
      body.v.addScaledVector(direction, start.impulse!.speed * share);
    });
    const body = bodies[start.impulse.body];
    if (body) {
      // The shot lands above the body's centre, so it also turns the body.
      const spin = new Vector3(0, 1, 0).cross(direction).multiplyScalar(start.impulse.speed * 2);
      body.w.add(spin);
    }
  }
  const joints = data.joints.map((joint) => ({
    ...joint,
    local1: new Vector3(...joint.frame1.position).sub(bodies[joint.body1].com),
    local2: new Vector3(...joint.frame2.position).sub(bodies[joint.body2].com),
    rotation1: new Quaternion(...joint.frame1.rotation),
    rotation2: new Quaternion(...joint.frame2.rotation),
  }));
  const frames: Float32Array[] = [];
  let asleep = 0;
  function record() {
    const frame = new Float32Array(bodies.length * 7);
    bodies.forEach((body, i) => {
      // Bone origin = centre of mass minus the rotated offset.
      const origin = scratch.a.copy(body.com).applyQuaternion(body.q).negate().add(body.x);
      frame.set([origin.x, origin.y, origin.z, body.q.x, body.q.y, body.q.z, body.q.w], i * 7);
    });
    frames.push(frame);
  }
  function gather() {
    for (const body of bodies) {
      body.triangles.length = 0;
      world.nearby(body.x, body.bound + 0.25, (triangle) => {
        if (body.triangles.length < 96) body.triangles.push(triangle.clone());
      });
    }
  }
  const contacts: { body: Body; r: Vector3; n: Vector3 }[] = [];
  const contactPoint = new Vector3(),
    contactNormal = new Vector3();
  const t1 = new Vector3(),
    t2 = new Vector3(),
    y1 = new Vector3(),
    y2 = new Vector3();
  function substep(h: number) {
    for (const body of bodies) {
      body.previousX.copy(body.x);
      body.previousQ.copy(body.q);
      body.v.y += gravity * h;
      body.v.multiplyScalar(1 / (1 + h * body.linearDamping));
      body.w.multiplyScalar(1 / (1 + h * body.angularDamping));
      body.x.addScaledVector(body.v, h);
      rotate(body.q, scratch.a.copy(body.w).multiplyScalar(h));
    }
    for (const joint of joints) {
      const a = bodies[joint.body1],
        b = bodies[joint.body2];
      // Anchors coincide.
      const r1 = scratch.r1.copy(joint.local1).applyQuaternion(a.q);
      const r2 = scratch.r2.copy(joint.local2).applyQuaternion(b.q);
      const delta = scratch.b.copy(b.x).add(r2).sub(a.x).sub(r1);
      const error = delta.length();
      if (error > 1e-6) {
        const n = delta.divideScalar(error);
        const w = positionalWeight(a, r1, n) + positionalWeight(b, r2, n);
        if (w > 0) {
          const impulse = n.clone().multiplyScalar(error / w);
          applyPositional(a, r1, impulse, 1);
          applyPositional(b, scratch.r2.copy(joint.local2).applyQuaternion(b.q), impulse, -1);
        }
      }
      // Frames in the world: the twist axis is each frame's x.
      const f1 = scratch.q2.copy(a.q).multiply(joint.rotation1);
      t1.set(1, 0, 0).applyQuaternion(f1);
      y1.set(0, 1, 0).applyQuaternion(f1);
      const f2 = scratch.q.copy(b.q).multiply(joint.rotation2);
      t2.set(1, 0, 0).applyQuaternion(f2);
      y2.set(0, 1, 0).applyQuaternion(f2);
      if (joint.swing) {
        const cone = Math.acos(Math.min(1, Math.max(-1, t1.dot(t2))));
        const limit = Math.max(Math.abs(joint.swing[0]), Math.abs(joint.swing[1]));
        if (cone > limit) {
          const axis = scratch.d.crossVectors(t1, t2);
          if (axis.lengthSq() > 1e-12)
            solveAngular(a, b, axis.normalize().multiplyScalar(cone - limit));
        }
      }
      if (joint.twist) {
        // Twist: the angle between the frames' y axes about their mean twist axis.
        const n = scratch.d.copy(t1).add(t2).normalize();
        const p1 = y1.addScaledVector(n, -y1.dot(n)).normalize();
        const p2 = y2.addScaledVector(n, -y2.dot(n)).normalize();
        const angle = Math.atan2(scratch.e.crossVectors(p1, p2).dot(n), p1.dot(p2));
        const clamped = Math.min(joint.twist[1], Math.max(joint.twist[0], angle));
        if (angle !== clamped) solveAngular(a, b, n.clone().multiplyScalar(angle - clamped));
      }
    }
    // Contacts: every sample sphere is pushed out of the gathered world triangles.
    for (const body of bodies) {
      if (!body.triangles.length) continue;
      for (const sphere of body.spheres) {
        const r = scratch.r1.copy(sphere.local).applyQuaternion(body.q);
        const centre = scratch.a.copy(body.x).add(r);
        for (const triangle of body.triangles) {
          triangle.closestPointToPoint(centre, scratch.closest);
          const offset = scratch.b.copy(centre).sub(scratch.closest);
          const distance = offset.length();
          if (distance >= sphere.radius) continue;
          const n =
            distance > 1e-6
              ? contactNormal.copy(offset).divideScalar(distance)
              : triangle.getNormal(contactNormal);
          // A body that starts inside geometry leaves it gradually: a whole correction in one
          // substep would turn into a launch when velocities are taken from positions.
          const depth = Math.min(sphere.radius - distance, maxPush);
          const contact = contactPoint.copy(r).addScaledVector(n, -sphere.radius);
          const w = positionalWeight(body, contact, n);
          if (!(w > 0)) continue;
          applyPositional(body, contact, n.clone().multiplyScalar(depth / w), 1);
          if (contacts.length < 256) contacts.push({ body, r: contact.clone(), n: n.clone() });
          centre.copy(body.x).add(r.copy(sphere.local).applyQuaternion(body.q));
          // Friction: hold the contact against sliding along the surface this substep.
          const moved = scratch.d
            .copy(centre)
            .sub(
              scratch.e
                .copy(body.previousX)
                .add(scratch.r2.copy(sphere.local).applyQuaternion(body.previousQ)),
            );
          const tangential = moved.addScaledVector(n, -moved.dot(n));
          const slip = tangential.length();
          if (slip > 1e-7) {
            const hold = Math.min(slip, depth * 0.9);
            applyPositional(body, contact, tangential.multiplyScalar(-hold / slip / w), 1);
          }
        }
      }
    }
    for (const body of bodies) {
      body.v.copy(body.x).sub(body.previousX).divideScalar(h);
      const dq = scratch.q.copy(body.previousQ).invert().premultiply(body.q);
      const sign = dq.w >= 0 ? 2 : -2;
      body.w.set(dq.x, dq.y, dq.z).multiplyScalar(sign / h);
      if (body.v.length() > maxSpeed) body.v.setLength(maxSpeed);
      if (body.w.length() > maxSpin) body.w.setLength(maxSpin);
    }
    // Velocity pass (restitution 0): pushing a body out of the world moves it without
    // throwing it, so the separating speed a contact correction created is removed.
    for (const { body, r, n } of contacts) {
      const normal = scratch.a.crossVectors(body.w, r).add(body.v).dot(n);
      if (normal <= 0) continue;
      const w = positionalWeight(body, r, n);
      if (!(w > 0)) continue;
      const impulse = scratch.b.copy(n).multiplyScalar(-normal / w);
      body.v.addScaledVector(impulse, body.invMass);
      body.w.add(
        scratch.e.crossVectors(r, impulse).applyMatrix3(worldInverseInertia(body, scratch.m)),
      );
    }
    contacts.length = 0;
  }
  function step() {
    gather();
    for (let i = 0; i < substeps; i++) substep(ragdollStep / substeps);
    record();
    const fastest = Math.max(...bodies.map((body) => body.v.length()));
    asleep = fastest < sleepSpeed ? asleep + 1 : 0;
  }
  record();
  return {
    /** Advance until `seconds` is covered or the body rests; bounded to four seconds. */
    advanceTo(seconds: number, budget = Infinity) {
      const target = Math.min(maxSeconds, seconds) / ragdollStep;
      let steps = 0;
      while (frames.length - 1 < target && asleep < 32 && steps < budget) {
        step();
        steps++;
      }
      return steps;
    },
    get settled() {
      return asleep >= 32 || frames.length - 1 >= maxSeconds / ragdollStep;
    },
    bones: data.bodies.map((body) => body.bone),
    /** Bone world transforms at `seconds` (the last computed frame if beyond). */
    sample(seconds: number, target: Matrix4[]) {
      const index = Math.min(frames.length - 1, Math.max(0, seconds / ragdollStep));
      const lower = Math.floor(index),
        upper = Math.min(frames.length - 1, lower + 1),
        t = index - lower;
      const a = frames[lower],
        b = frames[upper];
      const p = new Vector3(),
        qa = new Quaternion(),
        qb = new Quaternion();
      for (let i = 0; i < bodies.length; i++) {
        const o = i * 7;
        p.set(a[o], a[o + 1], a[o + 2]).lerp(scratch.a.set(b[o], b[o + 1], b[o + 2]), t);
        qa.set(a[o + 3], a[o + 4], a[o + 5], a[o + 6]);
        qb.set(b[o + 3], b[o + 4], b[o + 5], b[o + 6]);
        target[i].compose(p, qa.slerp(qb, t), scratch.b.set(1, 1, 1));
      }
    },
    get frames() {
      return frames.length;
    },
  };
}
export type RagdollSimulation = ReturnType<typeof createRagdollSimulation>;

/** Pose the skeleton from simulated bone world transforms, parents first. Bones the ragdoll
 * does not own keep their own local transforms and follow their parents. */
export function applyRagdollPose(root: Object3D, bones: Bone[], worlds: Matrix4[]) {
  const order = bones
    .map((bone, index) => ({ bone, index, depth: depthOf(bone) }))
    .sort((a, b) => a.depth - b.depth);
  const parent = new Matrix4(),
    scale = new Vector3();
  root.updateWorldMatrix(true, false);
  for (const { bone, index } of order) {
    bone.parent!.updateWorldMatrix(true, false);
    parent.copy(bone.parent!.matrixWorld).invert().multiply(worlds[index]);
    parent.decompose(bone.position, bone.quaternion, scale);
    bone.updateMatrixWorld(true);
  }
}
function depthOf(node: Object3D) {
  let depth = 0;
  for (let n = node.parent; n; n = n.parent) depth++;
  return depth;
}
