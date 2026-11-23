import {
  Camera,
  DoubleSide,
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

type Slot = object | string | number | boolean | null | undefined;
const slotLimit = 512 * 1024;
const limitExceeded = Symbol('shadow signature budget');

/** Compare and update persistent slots as they are visited. Stable frames never
 * allocate a fresh signature or retain a second copy of all caster matrices. */
class SignatureWriter {
  changed = false;
  private slots: Slot[] = [];
  private cursor = 0;
  private remaining = slotLimit;

  reset() {
    this.changed = false;
    this.remaining = slotLimit;
  }
  start(slots: Slot[]) {
    this.slots = slots;
    this.cursor = 0;
  }
  write(value: Slot) {
    if (this.cursor >= this.remaining) throw limitExceeded;
    if (this.slots[this.cursor] !== value || this.cursor >= this.slots.length) {
      this.slots[this.cursor] = value;
      this.changed = true;
    }
    this.cursor++;
  }
  numbers(values: ArrayLike<number>) {
    if (this.cursor + values.length > this.remaining) throw limitExceeded;
    for (let i = 0; i < values.length; i++) {
      if (this.slots[this.cursor] !== values[i]) {
        this.slots[this.cursor] = values[i];
        this.changed = true;
      }
      this.cursor++;
    }
  }
  finish() {
    if (this.cursor !== this.slots.length) {
      this.slots.length = this.cursor;
      this.changed = true;
    }
    this.remaining -= this.cursor;
  }
}
const matrix = (out: SignatureWriter, value: Matrix4) => out.numbers(value.elements);
const texture = (out: SignatureWriter, value: Texture | null | undefined) => {
  out.write(value);
  out.write(value?.version);
  if (value) {
    out.write(value.offset.x);
    out.write(value.offset.y);
    out.write(value.repeat.x);
    out.write(value.repeat.y);
    out.write(value.center.x);
    out.write(value.center.y);
    out.write(value.rotation);
    out.write(value.wrapS);
    out.write(value.wrapT);
    out.write(value.matrixAutoUpdate);
    out.numbers(value.matrix.elements);
  }
};
const material = (out: SignatureWriter, value: Mesh['material']) => {
  if (Array.isArray(value)) {
    for (const item of value) material(out, item);
    return;
  }
  const item = value;
  // Three bumps the color material's version twice per transparent two-sided
  // draw. Its generated depth material reads the shadow fields below.
  out.write(item);
  out.write(
    item.transparent && item.side === DoubleSide && !item.forceSinglePass ? null : item.version,
  );
  out.write(item.visible);
  out.write(item.side);
  out.write(item.shadowSide);
  out.write(item.clipShadows);
  out.write(item.clipIntersection);
  out.write(item.alphaToCoverage);
  out.write(item.opacity);
  if (item.clippingPlanes)
    for (const plane of item.clippingPlanes) {
      out.write(plane.normal.x);
      out.write(plane.normal.y);
      out.write(plane.normal.z);
      out.write(plane.constant);
    }
  const alpha = item as typeof item & {
    alphaTest?: number;
    alphaMap?: Texture | null;
    map?: Texture | null;
    displacementMap?: Texture | null;
    displacementScale?: number;
    displacementBias?: number;
    wireframe?: boolean;
    wireframeLinewidth?: number;
    linewidth?: number;
  };
  out.write(alpha.alphaTest);
  out.write(alpha.displacementScale);
  out.write(alpha.displacementBias);
  out.write(alpha.wireframe);
  out.write(alpha.wireframeLinewidth);
  out.write(alpha.linewidth);
  texture(out, alpha.map);
  texture(out, alpha.alphaMap);
  texture(out, alpha.displacementMap);
};

/**
 * Cache static map shadows, never changing casters. Called after Three updates
 * world matrices and before its shadow pass. No PVS or hidden-geometry guesswork.
 */
export class MapShadowCache {
  private readonly previous = new Map<Object3D, { values: Slot[]; frame: number }>();
  private readonly rendererState: Slot[] = [];
  private readonly signature = new SignatureWriter();
  private frame = 0;
  private uncachedScene?: Scene;

  update(scene: Scene, camera: Camera, renderer: WebGLRenderer): boolean {
    if (this.uncachedScene !== scene) {
      try {
        return this.collect(scene, camera, renderer);
      } catch (error) {
        if (error !== limitExceeded) throw error;
        // Release partial snapshots; this scene uses ordinary shadow draws.
        this.uncachedScene = scene;
        this.previous.clear();
        this.rendererState.length = 0;
        this.signature.start(this.rendererState);
      }
    }
    renderer.shadowMap.needsUpdate = true;
    return true;
  }

  private collect(scene: Scene, camera: Camera, renderer: WebGLRenderer): boolean {
    const signature = this.signature;
    this.frame++;
    signature.reset();
    signature.start(this.rendererState);
    signature.write(renderer.shadowMap.type);
    signature.write(renderer.shadowMap.enabled);
    signature.write(camera.layers.mask);
    signature.write(renderer.localClippingEnabled);
    for (const plane of renderer.clippingPlanes) {
      signature.write(plane.normal.x);
      signature.write(plane.normal.y);
      signature.write(plane.normal.z);
      signature.write(plane.constant);
    }
    signature.finish();
    let changed = false;
    const stack: Object3D[] = [scene];
    let inspected = 0;
    while (stack.length) {
      const object = stack.pop()!;
      if (++inspected > 100_000) throw limitExceeded;
      if (!object.visible) continue;
      const staticMap = object instanceof StaticMapGroup && !object.canTrackRigCasters;
      const casterLight = object instanceof Light && object.castShadow && 'shadow' in object;
      const casterMesh = object instanceof Mesh && object.castShadow;
      if (!(staticMap || casterLight || casterMesh)) {
        for (let i = 0; i < object.children.length; i++) stack.push(object.children[i]);
        continue;
      }
      let stored = this.previous.get(object);
      if (!stored) {
        stored = { values: [], frame: this.frame };
        this.previous.set(object, stored);
        changed = true;
      }
      stored.frame = this.frame;
      signature.start(stored.values);
      signature.write(object.layers.mask);
      if (staticMap) {
        if (!object.immutableDescendants) {
          // Animated/unsupported map branches keep the original shadow pass;
          // do not turn a large mutable asset into a per-mesh snapshot cache.
          changed = true;
          signature.finish();
          continue;
        }
        matrix(signature, object.matrixWorld);
        signature.finish();
        continue;
      }
      if (casterLight) {
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
        signature.write(shadow.autoUpdate);
        signature.write(shadow.map);
        signature.write(shadow.mapSize.x);
        signature.write(shadow.mapSize.y);
        signature.write(shadow.radius);
        signature.write(shadow.blurSamples);
        signature.write(view.near);
        signature.write(view.far);
        signature.write(view.left);
        signature.write(view.right);
        signature.write(view.top);
        signature.write(view.bottom);
        signature.write(view.fov);
        signature.write(view.aspect);
        signature.write(light.distance);
        signature.write(light.angle);
        if (shadow.needsUpdate) changed = true;
      }
      if (casterMesh) {
        const geometry = object.geometry as BufferGeometry;
        matrix(signature, object.matrixWorld);
        signature.write(object.geometry);
        signature.write(object.geometry.index?.version);
        signature.write(object.geometry.drawRange.start);
        signature.write(object.geometry.drawRange.count);
        signature.write(object.customDepthMaterial);
        signature.write(object.customDistanceMaterial);
        for (const group of object.geometry.groups) {
          signature.write(group.start);
          signature.write(group.count);
          signature.write(group.materialIndex);
        }
        for (const key in geometry.attributes) {
          const attribute = geometry.attributes[key];
          signature.write(attribute);
          signature.write('data' in attribute ? attribute.data.version : attribute.version);
        }
        for (const key in geometry.morphAttributes) {
          const attributes = geometry.morphAttributes[key as keyof typeof geometry.morphAttributes];
          for (const attribute of attributes || []) {
            signature.write(attribute);
            signature.write('data' in attribute ? attribute.data.version : attribute.version);
          }
        }
        material(signature, object.material);
        if (object.customDepthMaterial) material(signature, object.customDepthMaterial);
        if (object.customDistanceMaterial) material(signature, object.customDistanceMaterial);
        if (object.morphTargetInfluences) {
          if (object.morphTargetInfluences.length > 256) changed = true;
          else for (const influence of object.morphTargetInfluences) signature.write(influence);
        }
        if (object instanceof SkinnedMesh) {
          const bones = object.skeleton.bones;
          if (bones.length > 2048) changed = true;
          else for (const bone of bones) matrix(signature, bone.matrixWorld);
          if (object.skeleton.boneInverses.length > 2048) changed = true;
          else for (const inverse of object.skeleton.boneInverses) matrix(signature, inverse);
          signature.write(object.bindMode);
          matrix(signature, object.bindMatrix);
          matrix(signature, object.bindMatrixInverse);
        }
        if ('instanceMatrix' in object)
          signature.write((object.instanceMatrix as { version: number }).version);
        // Application-authored depth callbacks/uniforms can change without a
        // Three version bump; retain ordinary updates rather than guess.
        if (
          object.onBeforeShadow !== Object3D.prototype.onBeforeShadow ||
          object.onBeforeRender !== Object3D.prototype.onBeforeRender ||
          object.customDepthMaterial ||
          object.customDistanceMaterial
        )
          changed = true;
      }
      signature.finish();
      for (let i = 0; i < object.children.length; i++) stack.push(object.children[i]);
    }
    this.previous.forEach((row, object) => {
      if (row.frame === this.frame) return;
      this.previous.delete(object);
      changed = true;
    });
    changed ||= signature.changed;
    if (changed) renderer.shadowMap.needsUpdate = true;
    return changed;
  }
}
