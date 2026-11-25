import {
  Mesh,
  Texture,
  type BufferAttribute,
  type BufferGeometry,
  type InterleavedBufferAttribute,
  type Material,
} from 'three';
import type { GLTF } from 'three-stdlib';
import type { ModelResource } from './model-cache';

// The decoder allocates one real buffer per requested compressed view. The parser
// holds these buffers, including those outside the final geometry and animation arrays.
export const modelDecodedBuffers = new WeakMap<GLTF, Set<ArrayBufferLike>>();

type RenderedModel = Pick<GLTF, 'scene' | 'scenes' | 'animations'> & {
  parser: Pick<GLTF['parser'], 'json' | 'associations'>;
};

/** Equipment only reads the authored clip definitions and material associations after loading. */
export function retainEquipmentModel({ scene, scenes, animations, parser }: GLTF): RenderedModel {
  const associations: GLTF['parser']['associations'] = new Map();
  for (const root of scenes)
    root.traverse((node) => {
      if (!(node instanceof Mesh)) return;
      for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
        const entry = parser.associations.get(material);
        if (entry) associations.set(material, entry);
      }
    });
  return {
    scene,
    scenes,
    animations,
    parser: {
      associations,
      json: {
        materials: parser.json.materials,
        animations: parser.json.animations,
      },
    },
  };
}

export function equipmentModelResources(gltf: RenderedModel): ModelResource[] {
  return modelResources(gltf);
}

/** Count reachable render storage and, for maps, the parser kept for additional texture dependencies. */
function modelResources(gltf: RenderedModel, source?: GLTF): ModelResource[] {
  const resources = new Map<object, ModelResource>();
  const add = (resource: ModelResource) => {
    const old = resources.get(resource.key);
    if (!old || old.bytes < resource.bytes) resources.set(resource.key, resource);
  };
  const attribute = (attribute: BufferAttribute | InterleavedBufferAttribute) => {
    const array = 'data' in attribute ? attribute.data.array : attribute.array;
    add({ key: array.buffer, bytes: array.buffer.byteLength });
  };
  const image = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const part of value) image(part);
      return;
    }
    const candidate = value as { width?: number; height?: number; data?: ArrayBufferView };
    if (candidate.data?.buffer)
      add({ key: candidate.data.buffer, bytes: candidate.data.buffer.byteLength });
    const bytes =
      !candidate.data?.buffer &&
      typeof candidate.width === 'number' &&
      typeof candidate.height === 'number' &&
      Number.isFinite(candidate.width * candidate.height)
        ? Math.max(0, candidate.width * candidate.height * 4)
        : 0;
    add({
      key: value,
      bytes,
      dispose: () => {
        if (typeof ImageBitmap !== 'undefined' && value instanceof ImageBitmap) value.close();
      },
    });
  };
  const material = (material: Material) => {
    add({ key: material, bytes: 0, dispose: () => material.dispose() });
    for (const value of Object.values(material)) {
      if (!(value instanceof Texture)) continue;
      add({ key: value, bytes: 0, dispose: () => value.dispose() });
      image(value.source.data);
      for (const mip of value.mipmaps || []) {
        const data = (mip as { data?: ArrayBufferView }).data;
        if (data?.buffer) add({ key: data.buffer, bytes: data.buffer.byteLength });
      }
    }
  };
  for (const scene of gltf.scenes)
    scene.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      const geometry = object.geometry as BufferGeometry;
      add({ key: geometry, bytes: 0, dispose: () => geometry.dispose() });
      for (const value of Object.values(geometry.attributes)) attribute(value);
      if (geometry.index) attribute(geometry.index);
      for (const values of Object.values(geometry.morphAttributes))
        for (const value of values || []) attribute(value);
      for (const item of Array.isArray(object.material) ? object.material : [object.material])
        material(item);
      if ('instanceMatrix' in object) {
        const instance = object as Mesh & {
          instanceMatrix: BufferAttribute;
          instanceColor?: BufferAttribute;
          dispose?: () => void;
        };
        attribute(instance.instanceMatrix);
        if (instance.instanceColor) attribute(instance.instanceColor);
        add({ key: instance, bytes: 0, dispose: () => instance.dispose?.() });
      }
      if ('skeleton' in object) {
        const skeleton = object.skeleton as { dispose: () => void };
        add({ key: skeleton, bytes: 0, dispose: () => skeleton.dispose() });
      }
    });
  for (const clip of gltf.animations || [])
    for (const track of clip.tracks) {
      for (const array of [track.times, track.values])
        add({ key: array.buffer, bytes: array.buffer.byteLength });
    }
  const metadataBytes = JSON.stringify(gltf.parser.json).length * 4;
  if (!source) {
    add({ key: gltf.parser, bytes: metadataBytes });
    return [...resources.values()];
  }
  const decoded = modelDecodedBuffers.get(source);
  if (decoded) for (const buffer of decoded) add({ key: buffer, bytes: buffer.byteLength });
  const json = gltf.parser.json as {
    buffers?: {
      byteLength: number;
      uri?: string;
      extensions?: { EXT_meshopt_compression?: { fallback?: boolean } };
    }[];
    extensionsRequired?: string[];
    images?: { bufferView?: number }[];
    bufferViews?: { byteLength: number }[];
  };
  const imageViews = new Set(
      json.images
        ?.map((image) => image.bufferView)
        .filter((index): index is number => typeof index === 'number'),
    ),
    binaryBytes = (json.buffers || []).reduce((sum, buffer, index) => {
      // A required meshopt GLB can describe its decoded layout in an unbacked
      // fallback buffer. The decoder allocates the actual views counted above.
      const placeholder =
        decoded &&
        index > 0 &&
        buffer.uri === undefined &&
        buffer.extensions?.EXT_meshopt_compression?.fallback === true &&
        json.extensionsRequired?.includes('EXT_meshopt_compression');
      return sum + (!placeholder && Number.isFinite(buffer.byteLength) ? buffer.byteLength : 0);
    }, 0),
    imageCopies = [...imageViews].reduce(
      (sum, index) => sum + (json.bufferViews?.[index]?.byteLength || 0),
      0,
    );
  add({ key: gltf.parser, bytes: binaryBytes + imageCopies + metadataBytes });
  return [...resources.values()];
}
