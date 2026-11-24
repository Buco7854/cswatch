import {
  BufferAttribute,
  InterleavedBufferAttribute,
  InstancedInterleavedBuffer,
  Mesh,
  StaticDrawUsage,
  type BufferGeometry,
  type InterleavedBuffer,
  type Object3D,
} from 'three';

// The copy lives alongside the decoded source and is charged by mapModelResources.
const maxPackedBytes = 1024 * 1024;

/** GLTFLoader creates separate GPU buffers for float attributes and integer joints
 * in a mixed vertex stream. Upload only the joint indices in the second buffer. */
export function packEquipmentJoints(scenes: readonly Object3D[]) {
  const geometries = new Set<BufferGeometry>();
  const otherInputs = new Set<InterleavedBuffer>();
  for (const scene of scenes)
    scene.traverse((node) => {
      if (!(node instanceof Mesh) || geometries.has(node.geometry)) return;
      const geometry: BufferGeometry = node.geometry;
      geometries.add(geometry);
      for (const [name, attribute] of Object.entries(geometry.attributes)) {
        if (name !== 'skinIndex' && attribute instanceof InterleavedBufferAttribute)
          otherInputs.add(attribute.data);
      }
      for (const targets of Object.values(geometry.morphAttributes))
        for (const attribute of targets || [])
          if (attribute instanceof InterleavedBufferAttribute) otherInputs.add(attribute.data);
    });
  let remaining = maxPackedBytes;
  const packed = new Map<InterleavedBufferAttribute, BufferAttribute>();
  for (const geometry of geometries) {
    const joints = geometry.getAttribute('skinIndex');
    if (
      !(joints instanceof InterleavedBufferAttribute) ||
      joints.normalized ||
      joints.itemSize !== 4 ||
      joints.data.usage !== StaticDrawUsage ||
      joints.data instanceof InstancedInterleavedBuffer ||
      !Number.isInteger(joints.count) ||
      joints.offset + 4 > joints.data.stride ||
      joints.data.stride <= joints.itemSize ||
      otherInputs.has(joints.data)
    )
      continue;
    const source = joints.data.array;
    if (!(source instanceof Uint8Array || source instanceof Uint16Array)) continue;
    let replacement = packed.get(joints);
    if (!replacement) {
      const length = joints.count * joints.itemSize;
      const bytes = length * source.BYTES_PER_ELEMENT;
      if (bytes > remaining) continue;
      const values =
        source instanceof Uint8Array ? new Uint8Array(length) : new Uint16Array(length);
      for (
        let out = 0, input = joints.offset;
        out < length;
        out += 4, input += joints.data.stride
      ) {
        values[out] = source[input];
        values[out + 1] = source[input + 1];
        values[out + 2] = source[input + 2];
        values[out + 3] = source[input + 3];
      }
      replacement = new BufferAttribute(values, 4);
      replacement.name = joints.name;
      packed.set(joints, replacement);
      remaining -= bytes;
    }
    geometry.setAttribute('skinIndex', replacement);
  }
}
