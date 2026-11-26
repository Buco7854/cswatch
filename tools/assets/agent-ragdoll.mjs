/** The agent model's own ragdoll (VPhysXAggregateData_t from its PHYS block), converted to the
 * prepared skeleton's glTF bone space in metres. Layout after ValveResourceFormat 21.1
 * PhysAggregateData and PhysSceneNode (MIT): parts are bodies placed by `m_bindPose` in model
 * inches; shapes and joint frames are local to their body. */

/** A bounded parser for S2V's KV3 text output. */
export function parseKv3Text(text) {
  if (typeof text !== 'string' || text.length > 4 * 1024 ** 2)
    throw Error('KV3 text exceeds 4 MiB.');
  // The `<!-- kv3 encoding:... -->` header carries braces in its version GUIDs.
  const header = text.indexOf('-->');
  const start = text.indexOf('{', header < 0 ? 0 : header + 3);
  if (start < 0) throw Error('KV3 text has no root object.');
  let i = start;
  const space = () => {
    for (;;) {
      while (i < text.length && /\s|,/.test(text[i])) i++;
      if (text.startsWith('//', i)) i = text.indexOf('\n', i) + 1 || text.length;
      else return;
    }
  };
  let depth = 0;
  function value() {
    space();
    const c = text[i];
    if (c === '{') {
      if (++depth > 64) throw Error('KV3 nesting exceeds its bound.');
      i++;
      const object = {};
      for (;;) {
        space();
        if (text[i] === '}') {
          i++;
          depth--;
          return object;
        }
        const key = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(text.slice(i, i + 200))?.[0];
        if (!key) throw Error('Invalid KV3 key.');
        i += key.length;
        space();
        if (text[i] !== '=') throw Error('Invalid KV3 assignment.');
        i++;
        object[key] = value();
      }
    }
    if (c === '[') {
      if (++depth > 64) throw Error('KV3 nesting exceeds its bound.');
      i++;
      const array = [];
      for (;;) {
        space();
        if (text[i] === ']') {
          i++;
          depth--;
          return array;
        }
        if (array.length >= 100000) throw Error('KV3 array exceeds its bound.');
        array.push(value());
      }
    }
    if (c === '"') {
      const end = text.indexOf('"', i + 1);
      const result = text.slice(i + 1, end);
      i = end + 1;
      return result;
    }
    const token = /^[^\s,\]\}]+/.exec(text.slice(i, i + 64))?.[0];
    if (!token) throw Error('Invalid KV3 value.');
    i += token.length;
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (token === 'null') return null;
    const number = Number(token);
    if (!Number.isFinite(number)) throw Error('Invalid KV3 number.');
    return number;
  }
  return value();
}

const multiply = (a, b) =>
  Array.from({ length: 16 }, (_, k) => {
    const row = k % 4,
      column = Math.floor(k / 4);
    let sum = 0;
    for (let n = 0; n < 4; n++) sum += a[n * 4 + row] * b[column * 4 + n];
    return sum;
  });
const transform = (m, p, w = 1) =>
  [0, 1, 2].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r] * w);
function invertAffine(m) {
  const [a, b, c, d, e, f, g, h, k] = [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]];
  const det = a * (e * k - f * h) - b * (d * k - f * g) + c * (d * h - e * g);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) throw Error('Singular ragdoll transform.');
  const inv = [
    (e * k - f * h) / det,
    (c * h - b * k) / det,
    (b * f - c * e) / det,
    (f * g - d * k) / det,
    (a * k - c * g) / det,
    (c * d - a * f) / det,
    (d * h - e * g) / det,
    (b * g - a * h) / det,
    (a * e - b * d) / det,
  ];
  const out = [
    inv[0],
    inv[3],
    inv[6],
    0,
    inv[1],
    inv[4],
    inv[7],
    0,
    inv[2],
    inv[5],
    inv[8],
    0,
    0,
    0,
    0,
    1,
  ];
  const t = transform(out, [m[12], m[13], m[14]], 1);
  out[12] = -t[0];
  out[13] = -t[1];
  out[14] = -t[2];
  return out;
}
/** Column-major 4x4 from a VRF row-major 3x4. */
const fromRows = (r) => [
  r[0],
  r[4],
  r[8],
  0,
  r[1],
  r[5],
  r[9],
  0,
  r[2],
  r[6],
  r[10],
  0,
  r[3],
  r[7],
  r[11],
  1,
];
function quaternionFromMatrix(m) {
  // Normalise the basis (it carries the inches-to-metres scale), then extract.
  const columns = [0, 1, 2].map((c) => {
    const v = [m[c * 4], m[c * 4 + 1], m[c * 4 + 2]];
    const l = Math.hypot(...v);
    return v.map((x) => x / l);
  });
  const [m00, m10, m20] = columns[0],
    [m01, m11, m21] = columns[1],
    [m02, m12, m22] = columns[2];
  const trace = m00 + m11 + m22;
  let x, y, z, w;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    w = 0.25 / s;
    x = (m21 - m12) * s;
    y = (m02 - m20) * s;
    z = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    w = (m21 - m12) / s;
    x = 0.25 * s;
    y = (m01 + m10) / s;
    z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    w = (m02 - m20) / s;
    x = (m01 + m10) / s;
    y = 0.25 * s;
    z = (m12 + m21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    w = (m10 - m01) / s;
    x = (m02 + m20) / s;
    y = (m12 + m21) / s;
    z = 0.25 * s;
  }
  const l = Math.hypot(x, y, z, w);
  return [x / l, y / l, z / l, w / l];
}
const quaternionMultiply = ([ax, ay, az, aw], [bx, by, bz, bw]) => [
  aw * bx + ax * bw + ay * bz - az * by,
  aw * by - ax * bz + ay * bw + az * bx,
  aw * bz + ax * by - ay * bx + az * bw,
  aw * bw - ax * bx - ay * by - az * bz,
];
const round = (v) => Math.round(v * 1e5) / 1e5;

/** The signed axis permutation (with inches to metres) that best maps the physics bind
 * pose onto the skeleton's bind pose. */
function fitAxes(pairs) {
  let best;
  const permutations = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ];
  for (const order of permutations)
    for (let signs = 0; signs < 8; signs++) {
      const s = [0, 1, 2].map((k) => (signs & (1 << k) ? -1 : 1));
      const matrix = Array(16).fill(0);
      order.forEach((from, to) => (matrix[from * 4 + to] = s[to] * 0.0254));
      matrix[15] = 1;
      let error = 0;
      for (const [source, target] of pairs) {
        const p = transform(matrix, source);
        error += (p[0] - target[0]) ** 2 + (p[1] - target[1]) ** 2 + (p[2] - target[2]) ** 2;
      }
      const rms = Math.sqrt(error / pairs.length);
      if (!best || rms < best.rms) best = { matrix, rms };
    }
  return best;
}

/** `phys`: parsed PHYS KV3. `bind`: Map of skeleton bone name -> column-major bind world
 * matrix (glTF metres, model space). */
export function convertRagdoll(phys, bind) {
  const names = phys?.m_boneNames;
  const parts = phys?.m_parts,
    joints = phys?.m_joints ?? [],
    poses = phys?.m_bindPose;
  if (
    !Array.isArray(names) ||
    !Array.isArray(parts) ||
    !Array.isArray(poses) ||
    !names.length ||
    names.length > 32 ||
    parts.length !== names.length ||
    poses.length !== names.length ||
    !Array.isArray(joints) ||
    joints.length > 64
  )
    throw Error('Unsupported native ragdoll layout.');
  const lower = new Map([...bind.keys()].map((name) => [name.toLowerCase(), name]));
  const bones = names.map((name) => {
    const bone = lower.get(String(name).toLowerCase());
    if (!bone) throw Error(`Ragdoll body ${name} has no matching skeleton bone.`);
    return bone;
  });
  const sources = poses.map((rows) => {
    if (!Array.isArray(rows) || rows.length !== 12 || rows.some((v) => !Number.isFinite(v)))
      throw Error('Invalid ragdoll bind pose.');
    return fromRows(rows);
  });
  const axes = fitAxes(
    sources.map((m, p) => [[m[12], m[13], m[14]], bind.get(bones[p]).slice(12, 15)]),
  );
  if (!(axes.rms < 0.02)) throw Error('Ragdoll bind pose does not match the skeleton.');
  // Body-local inches -> bone-local metres for every part.
  const local = sources.map((source, p) =>
    multiply(invertAffine(bind.get(bones[p])), multiply(axes.matrix, source)),
  );
  const point = (p, v) => transform(local[p], v).map(round);
  const bodies = parts.map((part, p) => {
    const shape = part?.m_rnShape ?? {};
    const capsules = (shape.m_capsules ?? []).map((item) => {
      const [a, b] = item.m_Capsule.m_vCenter;
      return { a: point(p, a), b: point(p, b), radius: round(item.m_Capsule.m_flRadius * 0.0254) };
    });
    const spheres = (shape.m_spheres ?? []).map((item) => ({
      a: point(p, item.m_Sphere.m_vCenter),
      b: point(p, item.m_Sphere.m_vCenter),
      radius: round(item.m_Sphere.m_flRadius * 0.0254),
    }));
    const shapes = [...capsules, ...spheres];
    if (!shapes.length || shapes.length > 8 || !(part.m_flMass > 0 && part.m_flMass < 1000))
      throw Error('Unsupported ragdoll body.');
    return {
      bone: bones[p],
      mass: part.m_flMass,
      linearDamping: part.m_flLinearDamping ?? 0,
      angularDamping: part.m_flAngularDamping ?? 0,
      shapes,
    };
  });
  const frame = (p, values) => {
    const position = point(p, values.slice(0, 3));
    const rotation = quaternionMultiply(quaternionFromMatrix(local[p]), values.slice(4, 8));
    return { position, rotation: rotation.map(round) };
  };
  const limits = (limit) => [round(limit?.m_flMin ?? 0), round(limit?.m_flMax ?? 0)];
  return {
    schemaVersion: 1,
    axesFitMeters: round(axes.rms),
    bodies,
    joints: joints.map((joint) => {
      const body1 = joint.m_nBody1,
        body2 = joint.m_nBody2;
      if (![body1, body2].every((b) => Number.isInteger(b) && b >= 0 && b < bodies.length))
        throw Error('Invalid ragdoll joint.');
      return {
        body1,
        body2,
        frame1: frame(body1, joint.m_Frame1),
        frame2: frame(body2, joint.m_Frame2),
        swing: joint.m_bEnableSwingLimit ? limits(joint.m_SwingLimit) : null,
        twist: joint.m_bEnableTwistLimit ? limits(joint.m_TwistLimit) : null,
        friction: round(joint.m_flFriction ?? 0),
      };
    }),
  };
}
