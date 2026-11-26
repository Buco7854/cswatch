// Mesh bindings and tangent frames adapted from ValveResourceFormat 21.1 (MIT).
// Copyright (c) 2015 ValveResourceFormat Contributors. See THIRD_PARTY_NOTICES.txt.
import {
  Matrix4,
  Vector3,
  Euler,
  Quaternion,
  DataUtils,
} from '../../frontend/node_modules/three/build/three.module.js';

export const stride = 60;
const direction = new Vector3();
const origin = new Vector3();
const identity = new Matrix4();
const vec = (value) => (typeof value === 'string' ? value.trim().split(/\s+/).map(Number) : value);
const matrix = (rows) => (rows ? new Matrix4().set(...rows.flat(), 0, 0, 0, 1) : identity);
function placement(entity) {
  const [pitch, yaw, roll] = vec(entity.angles ?? [0, 0, 0]).map((a) => (a * Math.PI) / 180);
  return new Matrix4().compose(
    new Vector3(...vec(entity.origin)),
    new Quaternion().setFromEuler(new Euler(roll, pitch, yaw, 'ZYX')),
    new Vector3(...vec(entity.scales ?? [1, 1, 1])),
  );
}

function frame(buffer, offset, format) {
  if (format === 'R8G8B8A8_UNORM') {
    const unpack = (a, b) => {
      const half = (c) => (c < 128 ? 127 - c : c - 128);
      const sign = (c) => (c < 128 ? -1 : 1);
      const x = half(a) - 64,
        y = half(b) - 64;
      const ax = (x < 0 ? -x - 1 : x) / 63,
        ay = (y < 0 ? -y - 1 : y) / 63;
      return new Vector3(
        ax * (x < 0 ? -1 : 1),
        ay * (y < 0 ? -1 : 1),
        (1 - ax - ay) * sign(a),
      ).normalize();
    };
    return [
      unpack(buffer[offset], buffer[offset + 1]),
      unpack(buffer[offset + 2], buffer[offset + 3]),
      buffer[offset + 3] < 128 ? -1 : 1,
    ];
  }
  if (format !== 'R32_UINT') throw Error('Unsupported tangent frame ' + format);
  const bits = buffer.readUInt32LE(offset),
    x = ((bits >>> 12) & 1023) / 511.5 - 1,
    y = (bits >>> 22) / 511.5 - 1;
  const z = 1 - Math.abs(x) - Math.abs(y),
    k = Math.max(0, -z);
  const n = new Vector3(x + (x < 0 ? k : -k), y + (y < 0 ? k : -k), z).normalize();
  const sign = n.z < 0 ? -1 : 1,
    inv = sign / (sign + n.z);
  const u = new Vector3(1 - inv * n.x * n.x, -inv * n.x * n.y, -sign * n.x);
  const angle = (((bits >>> 1) & 2047) / 2047) * 2 * Math.PI;
  const tangent = new Vector3()
    .crossVectors(n, u)
    .multiplyScalar(Math.sin(angle))
    .addScaledVector(u, Math.cos(angle));
  return [n, tangent, bits & 1 ? 1 : -1];
}

function readUv(field, i) {
  if (!field) return [0, 0];
  const { bytes, stride, offset, format } = field,
    p = i * stride + offset;
  switch (format) {
    case 'R32G32_FLOAT':
      return [bytes.readFloatLE(p), bytes.readFloatLE(p + 4)];
    case 'R16G16_FLOAT':
      return [
        DataUtils.fromHalfFloat(bytes.readUInt16LE(p)),
        DataUtils.fromHalfFloat(bytes.readUInt16LE(p + 2)),
      ];
    case 'R16G16_SNORM':
      return [
        Math.max(-1, bytes.readInt16LE(p) / 32767),
        Math.max(-1, bytes.readInt16LE(p + 2) / 32767),
      ];
    case 'R16G16_UNORM':
      return [bytes.readUInt16LE(p) / 65535, bytes.readUInt16LE(p + 2) / 65535];
    default:
      throw Error('Unsupported UV field ' + format);
  }
}

/** Triangles per model at its finest and coarser LOD, for budget planning. */
export function modelTriangles(model) {
  const count = (meshes) =>
    (meshes ?? []).reduce(
      (sum, mesh) => sum + mesh.draws.reduce((n, draw) => n + draw.m_nIndexCount / 3, 0),
      0,
    );
  return { fine: count(model.meshes), coarse: model.coarse ? count(model.coarse) : undefined };
}

// Models in `coarse` use their next coarser LOD; `instances` counts whole-model placements.
// With `visit`, each range is handed over as it is decoded instead of being retained, so memory
// holds one draw's vertices at a time.
export function geometry(
  scene,
  read,
  materialId,
  density = new Map(),
  coarse = new Set(),
  instances = new Map(),
  visit = undefined,
) {
  const ranges = [],
    entities = [],
    environments = [];
  let totalVertices = 0;
  for (const [worldName, world] of Object.entries(scene.worlds)) {
    const sky = worldName !== `maps/${scene.map}`;
    let root = new Matrix4();
    if (sky) {
      const camera = world.entities.find((e) => e.classname === 'sky_camera');
      // Each sky world is placed by the enabled reference that names it.
      const ref = scene.worlds[`maps/${scene.map}`].entities.find(
        (e) =>
          e.classname === 'skybox_reference' &&
          !e.startdisabled &&
          e.targetmapname === worldName + '.vmap',
      );
      root = placement(ref)
        .multiply(new Matrix4().makeScale(camera.scale, camera.scale, camera.scale))
        .multiply(placement(camera).invert());
    }
    const probes = world.entities
      .filter((e) => e.cubemaptexture && e.array_index != null)
      .map((e) => {
        const m = placement(e),
          center = new Vector3(),
          min = new Vector3(Infinity, Infinity, Infinity),
          max = min.clone().negate();
        for (let mask = 0; mask < 8; mask++) {
          const point = new Vector3(
            ...[0, 1, 2].map((i) => vec(mask & (1 << i) ? e.box_maxs : e.box_mins)[i]),
          ).applyMatrix4(m);
          min.min(point);
          max.max(point);
        }
        center.addVectors(min, max).multiplyScalar(0.5);
        return { e, min, max, center, origin: new Vector3().setFromMatrixPosition(m) };
      });
    environments.push({
      world: worldName,
      sky,
      transform: root.toArray(),
      lighting: world.lighting,
      entities: world.entities.filter((e) => !e.model || e.postprocessing),
    });
    function submit(name, transform, tint, binding, fragment, entityIndex = -1) {
      if (!name) return;
      const model = scene.models[name];
      if (!model && scene.missingResources?.includes(name)) return;
      const placement = transform.equals(identity) ? undefined : transform.toArray();
      if (fragment === null) instances.set(name, (instances.get(name) ?? 0) + 1);
      // Aggregate fragments address LOD 0 draws, so they keep it.
      const meshes =
        fragment === null && coarse.has(name) && model.coarse ? model.coarse : model.meshes;
      for (const mesh of meshes) {
        const draws = fragment === null ? mesh.draws : [mesh.draws[fragment]];
        for (const draw of draws) {
          if (!draw) throw Error('Unknown fragment draw in ' + name);
          const matName = draw.m_material || draw.m_pMaterial;
          const mat = scene.materials[matName];
          if (!mat && scene.missingResources?.includes(matName)) continue;
          if (!mat) throw Error('Unresolved draw material in ' + name + ': ' + matName);
          if (mat.attrs['tools.toolsmaterial']) continue;
          const fields = new Map();
          for (const handle of draw.m_vertexBuffers) {
            const vb = mesh.vertices[handle.m_hBuffer],
              bytes = read(vb.file);
            for (const f of vb.fields)
              fields.set(f.name + f.index, {
                ...f,
                stride: vb.stride,
                bytes,
                offset: f.offset + handle.m_nBindOffsetBytes,
              });
          }
          const pos = fields.get('POSITION0'),
            normal = fields.get('NORMAL0');
          if (!pos || !normal) throw Error('Missing renderable vertex frame ' + name);
          const remap = new Map(),
            indices = Buffer.alloc(draw.m_nIndexCount * 4);
          const ib = mesh.indices[draw.m_indexBuffer.m_hBuffer],
            raw = read(ib.file);
          for (let j = 0; j < draw.m_nIndexCount; j++) {
            const off =
              (j + draw.m_nStartIndex) * ib.stride + draw.m_indexBuffer.m_nBindOffsetBytes;
            const idx = raw.readUIntLE(off, ib.stride);
            if (idx >= draw.m_nVertexCount)
              throw Error('Index outside draw ' + name + ' ' + idx + '/' + draw.m_nVertexCount);
            if (!remap.has(idx)) remap.set(idx, remap.size);
            indices.writeUInt32LE(remap.get(idx), j * 4);
          }
          const count = remap.size,
            v = Buffer.alloc(count * stride);
          totalVertices += count;
          if (totalVertices * stride > (visit ? 8192 : 768) * 1024 * 1024)
            throw Error('Geometry exceeds decoded budget');
          const placed = new Float32Array(count * 3),
            uvs = new Float32Array(count * 2);
          const min = new Vector3(Infinity, Infinity, Infinity),
            max = min.clone().negate();
          const localMin = min.clone(),
            localMax = max.clone();
          for (const [relative, j] of remap) {
            const i = relative + draw.m_nBaseVertex,
              p = i * pos.stride + pos.offset,
              o = j * stride;
            origin.set(
              pos.bytes.readFloatLE(p),
              pos.bytes.readFloatLE(p + 4),
              pos.bytes.readFloatLE(p + 8),
            );
            localMin.min(origin);
            localMax.max(origin);
            v.writeFloatLE(origin.x, o);
            v.writeFloatLE(origin.y, o + 4);
            v.writeFloatLE(origin.z, o + 8);
            origin.applyMatrix4(transform);
            origin.toArray(placed, j * 3);
            min.min(origin);
            max.max(origin);
            const [n, t, sign] = frame(
              normal.bytes,
              i * normal.stride + normal.offset,
              normal.format,
            );

            for (const [d, at] of [
              [n, 12],
              [t, 16],
            ])
              for (let c = 0; c < 3; c++)
                v.writeInt8(Math.round(d.getComponent(c) * 127), o + at + c);
            v.writeInt8(sign * (transform.determinant() < 0 ? -127 : 127), o + 19);
            const uv = readUv(fields.get('TEXCOORD0'), i),
              lm = readUv(fields.get('TEXCOORD3'), i),
              uv1 = readUv(fields.get('TEXCOORD1'), i);
            uvs[j * 2] = uv[0];
            uvs[j * 2 + 1] = uv[1];
            for (let c = 0; c < 2; c++) {
              v.writeFloatLE(uv[c], o + 20 + c * 4);
              v.writeUInt16LE(Math.round(lm[c] * 65535), o + 28 + c * 2);
              v.writeFloatLE(uv1[c], o + 40 + c * 4);
            }
            for (const [k, at, empty] of [
              ['COLOR0', 32, 255],
              ['TEXCOORD4', 36, 0],
            ]) {
              const f = fields.get(k);
              if (f) f.bytes.copy(v, o + at, i * f.stride + f.offset, i * f.stride + f.offset + 4);
              else v.fill(empty, o + at, o + at + 4);
            }
            v.writeUInt16LE(materialId(matName), o + 48);
            v[o + 52] = draw.m_bHasBakedLightingFromLightMap ? 1 : 0;
            for (let c = 0; c < 4; c++) {
              const val =
                (tint[c] ?? 1) *
                (c < 3
                  ? Math.pow((draw.m_vTintColor ?? [1, 1, 1])[c], 1 / 2.2)
                  : (draw.m_flAlpha ?? 1));
              v[o + 56 + c] = Math.round(Math.min(1, Math.max(0, val)) * 255);
            }
          }
          // Placed surface and UV0 areas give each material's texels per inch at a given size.
          const area = density.get(matName) ?? { world: 0, uv: 0 };
          density.set(matName, area);
          for (let j = 0; j < indices.length; j += 12) {
            const [a, b, c] = [0, 4, 8].map((k) => indices.readUInt32LE(j + k));
            const e = [0, 1, 2].map((k) => placed[b * 3 + k] - placed[a * 3 + k]),
              f = [0, 1, 2].map((k) => placed[c * 3 + k] - placed[a * 3 + k]);
            area.world +=
              Math.hypot(
                e[1] * f[2] - e[2] * f[1],
                e[2] * f[0] - e[0] * f[2],
                e[0] * f[1] - e[1] * f[0],
              ) / 2;
            area.uv +=
              Math.abs(
                (uvs[b * 2] - uvs[a * 2]) * (uvs[c * 2 + 1] - uvs[a * 2 + 1]) -
                  (uvs[c * 2] - uvs[a * 2]) * (uvs[b * 2 + 1] - uvs[a * 2 + 1]),
              ) / 2;
          }
          const center = new Vector3().addVectors(min, max).multiplyScalar(0.5);
          const sourceCenter = center.clone().applyMatrix4(root.clone().invert());
          let probe = probes.find(
            (p) =>
              binding.m_nCubeMapPrecomputedHandshake &&
              p.e.handshake === binding.m_nCubeMapPrecomputedHandshake,
          );
          const lightOrigin = binding.m_vLightingOrigin;
          if (lightOrigin)
            probe =
              probes.find(
                (p) => p.origin.distanceToSquared(direction.fromArray(lightOrigin)) < 0.01,
              ) || probe;
          if (!probe) {
            const overlap = probes.filter(
              (p) =>
                sky ||
                [0, 1, 2].every(
                  (c) =>
                    p.min.getComponent(c) <= max.getComponent(c) &&
                    p.max.getComponent(c) >= min.getComponent(c),
                ),
            );
            overlap.sort(
              (a, b) =>
                (b.e.indoor_outdoor_level ?? 0) - (a.e.indoor_outdoor_level ?? 0) ||
                a.center.distanceToSquared(sourceCenter) - b.center.distanceToSquared(sourceCenter),
            );
            probe = overlap[0];
          }
          let lpv = probes.find(
            (p) =>
              binding.m_nLightProbeVolumePrecomputedHandshake &&
              p.e.handshake === binding.m_nLightProbeVolumePrecomputedHandshake,
          );
          if (!lpv) {
            const point = lightOrigin ? new Vector3(...lightOrigin) : sourceCenter;
            const reach = min.distanceToSquared(center) / (sky ? root.elements[0] ** 2 : 1);
            let best;
            for (const p of probes) {
              const outside = (v) =>
                [0, 1, 2].reduce(
                  (v2, c) =>
                    v2 +
                    Math.max(
                      p.min.getComponent(c) - v.getComponent(c),
                      0,
                      v.getComponent(c) - p.max.getComponent(c),
                    ) **
                      2,
                  0,
                );
              const distance = outside(point),
                inside = distance === 0,
                priority = Number(p.e.indoor_outdoor_level ?? 0);
              if (!inside && outside(sourceCenter) > reach) continue;
              const score = inside ? p.origin.distanceToSquared(point) : distance;
              if (
                !best ||
                (inside && !best.inside) ||
                (inside === best.inside &&
                  ((inside && priority > best.priority) ||
                    ((!inside || priority === best.priority) && score < best.score)))
              ) {
                lpv = p;
                best = { inside, priority, score };
              }
            }
          }
          for (let j = 0; j < count; j++) {
            v.writeUInt16LE(probe?.e.array_index ?? 0, j * stride + 50);
            v.writeUInt16LE(lpv?.e.array_index ?? 65535, j * stride + 54);
          }
          const family = mat.shader.includes('water')
            ? 'water'
            : mat.shader === 'csgo_static_overlay.vfx' && mat.ints.F_BLEND_MODE === 3
              ? 'modulate'
              : mat.ints.F_ADDITIVE_BLEND
                ? 'additive'
                : mat.shader === 'csgo_glass.vfx'
                  ? 'glass'
                  : mat.ints.F_OVERLAY || mat.shader === 'csgo_static_overlay.vfx'
                    ? 'overlay'
                    : mat.ints.F_TRANSLUCENT || mat.shader === 'csgo_effects.vfx'
                      ? 'blended'
                      : mat.ints.F_ALPHA_TEST
                        ? 'cutout'
                        : 'opaque';
          (visit ?? ((range) => ranges.push(range)))({
            v,
            indices,
            mat: materialId(matName),
            family,
            side: !!mat.ints.F_RENDER_BACKFACES,
            sky,
            entityIndex,
            model: name,
            whole: fragment === null,
            localBounds: [...localMin.toArray(), ...localMax.toArray()],
            placement,
            cubeHandshake: binding.m_nCubeMapPrecomputedHandshake ?? 0,
            probeHandshake: binding.m_nLightProbeVolumePrecomputedHandshake ?? 0,
            bounds: [...min.toArray(), ...max.toArray()],
            cell: center
              .toArray()
              .map((x) => Math.floor(x / (sky ? 32768 : 1536)))
              .join(','),
          });
        }
      }
    }
    for (const node of world.nodes) {
      for (const o of node.objects)
        submit(
          o.m_renderableModel,
          root.clone().multiply(matrix(o.m_vTransform)),
          o.m_vTintColor?.[3] ? o.m_vTintColor : [1, 1, 1, 1],
          o,
          null,
        );
      for (const a of node.aggregates) {
        let t = 0;
        for (const f of a.m_aggregateMeshes) {
          const transform = f.m_bHasTransform ? matrix(a.m_fragmentTransforms[t++]) : identity;
          if (f.m_nLODGroupMask && !(f.m_nLODGroupMask & 1)) continue;
          submit(
            a.m_renderableModel,
            root.clone().multiply(transform),
            f.m_vTintColor.map((x) => x / 255),
            f,
            f.m_nDrawCallIndex,
          );
        }
      }
    }
    // Every entity with a model draws it, as in VRF's entity system (an unimplemented class is a
    // GenericModelEntity that draws its model): brush entities such as func_conveyor and
    // func_movelinear carry world geometry. Trigger and clip volumes use tool materials, which are
    // not drawn.
    for (const e of world.entities.filter((e) => e.model)) {
      const visible = !e.startdisabled && Number(e.rendermode ?? 0) !== 10;
      const id = entities.push({ ...e, world: worldName, initialVisibility: visible }) - 1;
      for (const [stage, model] of [e.model, ...(e.damageStages ?? [])].entries())
        submit(
          model,
          root.clone().multiply(placement(e)),
          [
            ...vec(e.rendercolor ?? [255, 255, 255])
              .slice(0, 3)
              .map((x) => x / 255),
            (e.renderamt ?? 255) / 255,
          ],
          {},
          null,
          stage === 0
            ? id
            : entities.push({
                ...e,
                model,
                world: worldName,
                initialVisibility: false,
                parentEntity: id,
              }) - 1,
        );
    }
  }
  return { ranges, entities, environments };
}
