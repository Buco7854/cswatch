import {
  Camera,
  Light,
  Matrix4,
  Mesh,
  Object3D,
  Scene,
  SkinnedMesh,
  type BufferGeometry,
  type Texture,
  type WebGLRenderer,
} from 'three';
import { StaticMapGroup } from './static-map-group';

type Signature = (object | string | number | boolean | null | undefined)[];
const unchanged = (a: Signature | undefined, b: Signature) =>
  Boolean(a && a.length === b.length && a.every((value, index) => value === b[index]));
const matrix = (out: Signature, value: Matrix4) => out.push(...value.elements);
const texture = (out: Signature, value: Texture | null | undefined) => {
  out.push(value, value?.version);
  if (value)
    out.push(
      value.offset.x,
      value.offset.y,
      value.repeat.x,
      value.repeat.y,
      value.center.x,
      value.center.y,
      value.rotation,
      value.wrapS,
      value.wrapT,
      value.matrixAutoUpdate,
      ...value.matrix.elements,
    );
};
const material = (out: Signature, value: Mesh['material']) => {
  for (const item of Array.isArray(value) ? value : [value]) {
    out.push(
      item,
      item.version,
      item.visible,
      item.side,
      item.shadowSide,
      item.clipShadows,
      item.clipIntersection,
      item.alphaToCoverage,
      item.opacity,
    );
    for (const plane of item.clippingPlanes || [])
      out.push(...plane.normal.toArray(), plane.constant);
    const alpha = item as typeof item & {
      alphaTest?: number;
      alphaMap?: Texture | null;
      map?: Texture | null;
      displacementMap?: Texture | null;
      displacementScale?: number;
      displacementBias?: number;
      wireframe?: boolean;
    };
    out.push(alpha.alphaTest, alpha.displacementScale, alpha.displacementBias, alpha.wireframe);
    texture(out, alpha.map);
    texture(out, alpha.alphaMap);
    texture(out, alpha.displacementMap);
  }
};

/**
 * Cache static map shadows, never changing casters. Called after Three updates
 * world matrices and before its shadow pass. No PVS or hidden-geometry guesswork.
 */
export class MapShadowCache {
  private previous = new Map<Object3D, Signature>();
  private rendererState: Signature | undefined;

  update(scene: Scene, camera: Camera, renderer: WebGLRenderer): boolean {
    const state: Signature = [
      renderer.shadowMap.type,
      renderer.shadowMap.enabled,
      camera.layers.mask,
      renderer.localClippingEnabled,
    ];
    for (const plane of renderer.clippingPlanes)
      state.push(...plane.normal.toArray(), plane.constant);
    let changed = !unchanged(this.rendererState, state);
    this.rendererState = state;
    const next = new Map<Object3D, Signature>(),
      stack: Object3D[] = [scene];
    let inspected = 0;
    while (stack.length) {
      const object = stack.pop()!;
      if (++inspected > 100_000) {
        // A surprising scene must fall back to ordinary rendering, not stale shadows.
        this.previous.clear();
        renderer.shadowMap.needsUpdate = true;
        return true;
      }
      if (!object.visible) continue;
      const signature: Signature = [object.layers.mask];
      if (object instanceof StaticMapGroup) {
        if (!object.immutableDescendants) {
          // Animated/unsupported map branches keep the original shadow pass;
          // do not turn a large mutable asset into a per-mesh snapshot cache.
          changed = true;
          continue;
        }
        matrix(signature, object.matrixWorld);
        next.set(object, signature);
        if (!unchanged(this.previous.get(object), signature)) changed = true;
        continue;
      }
      if (object instanceof Light && object.castShadow && 'shadow' in object) {
        const light = object as Light & {
          target?: Object3D;
          distance?: number;
          angle?: number;
          shadow: {
            needsUpdate: boolean;
            autoUpdate: boolean;
            radius: number;
            blurSamples: number;
            map: object | null;
            mapSize: { x: number; y: number };
            camera: Camera & {
              near: number;
              far: number;
              left?: number;
              right?: number;
              top?: number;
              bottom?: number;
              fov?: number;
              aspect?: number;
            };
          };
        };
        const shadow = light.shadow,
          view = shadow.camera;
        matrix(signature, object.matrixWorld);
        matrix(signature, view.projectionMatrix);
        if (light.target) matrix(signature, light.target.matrixWorld);
        signature.push(
          shadow.autoUpdate,
          shadow.map,
          shadow.mapSize.x,
          shadow.mapSize.y,
          shadow.radius,
          shadow.blurSamples,
          view.near,
          view.far,
          view.left,
          view.right,
          view.top,
          view.bottom,
          view.fov,
          view.aspect,
          light.distance,
          light.angle,
        );
        if (shadow.needsUpdate) changed = true;
        next.set(object, signature);
      }
      if (object instanceof Mesh && object.castShadow) {
        const geometry = object.geometry as BufferGeometry;
        matrix(signature, object.matrixWorld);
        signature.push(
          object.geometry,
          object.geometry.index?.version,
          object.geometry.drawRange.start,
          object.geometry.drawRange.count,
          object.customDepthMaterial,
          object.customDistanceMaterial,
        );
        for (const group of object.geometry.groups)
          signature.push(group.start, group.count, group.materialIndex);
        for (const attribute of Object.values(geometry.attributes))
          signature.push(
            attribute,
            'data' in attribute ? attribute.data.version : attribute.version,
          );
        for (const attributes of Object.values(geometry.morphAttributes))
          for (const attribute of attributes || [])
            signature.push(
              attribute,
              'data' in attribute ? attribute.data.version : attribute.version,
            );
        material(signature, object.material);
        if (object.customDepthMaterial) material(signature, object.customDepthMaterial);
        if (object.customDistanceMaterial) material(signature, object.customDistanceMaterial);
        if (object.morphTargetInfluences) {
          if (object.morphTargetInfluences.length > 256) changed = true;
          else for (const influence of object.morphTargetInfluences) signature.push(influence);
        }
        if (object instanceof SkinnedMesh) {
          const bones = object.skeleton.bones;
          if (bones.length > 2048) changed = true;
          else for (const bone of bones) matrix(signature, bone.matrixWorld);
          if (object.skeleton.boneInverses.length > 2048) changed = true;
          else for (const inverse of object.skeleton.boneInverses) matrix(signature, inverse);
          signature.push(object.bindMode);
          matrix(signature, object.bindMatrix);
          matrix(signature, object.bindMatrixInverse);
        }
        if ('instanceMatrix' in object)
          signature.push((object.instanceMatrix as { version: number }).version);
        // Application-authored depth callbacks/uniforms can change without a
        // Three version bump; retain ordinary updates rather than guess.
        if (
          object.onBeforeShadow !== Object3D.prototype.onBeforeShadow ||
          object.onBeforeRender !== Object3D.prototype.onBeforeRender ||
          object.customDepthMaterial ||
          object.customDistanceMaterial
        )
          changed = true;
        next.set(object, signature);
      }
      if (next.has(object) && !unchanged(this.previous.get(object), signature)) changed = true;
      for (const child of object.children) stack.push(child);
    }
    if (next.size !== this.previous.size) changed = true;
    else for (const object of this.previous.keys()) if (!next.has(object)) changed = true;
    this.previous = next;
    if (changed) renderer.shadowMap.needsUpdate = true;
    return changed;
  }
}
