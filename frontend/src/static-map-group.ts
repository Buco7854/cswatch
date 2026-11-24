import {
  Bone,
  Group,
  Light,
  Mesh,
  SkinnedMesh,
  Object3D,
  Scene,
  Matrix4,
  type AnimationClip,
} from 'three';

/**
 * Prepared map descendants are immutable; only their placement can change. Three's
 * normal scene update otherwise walks and recomposes every glTF node every frame.
 * Keep normal root/parent placement and leave potentially animated trees alone.
 * This owns no geometry, materials or textures and does not change visibility.
 */
export class StaticMapGroup extends Group {
  private sealed = false;
  private trackRigCasters = false;
  private settled = false;
  private readonly placedLocal = new Matrix4();
  private readonly placedParent = new Matrix4();
  private hadParent = false;

  get immutableDescendants(): boolean {
    return this.sealed;
  }

  // Clip-free maps with bound prop rigs stay mutable. The shadow cache can
  // inspect their casters normally instead of invalidating every frame.
  get canTrackRigCasters(): boolean {
    return this.trackRigCasters;
  }

  seal(clips: readonly AnimationClip[]): void {
    if (clips.length || this.sealed) return;
    let eligible = true;
    let hasRig = false;
    let hasBone = false;
    this.traverse((object) => {
      if (object.constructor === Bone) hasBone = true;
      const boundRig = object instanceof SkinnedMesh && Boolean(object.skeleton?.bones.length);
      if (boundRig) hasRig = true;
      if (
        object.animations.length ||
        ('isInstancedMesh' in object && object.isInstancedMesh) ||
        (object instanceof Mesh && object.morphTargetInfluences?.length) ||
        !(
          object.constructor === Object3D ||
          object.constructor === Group ||
          object.constructor === Scene ||
          object.constructor === Mesh ||
          object.constructor === Bone ||
          boundRig ||
          object === this ||
          object instanceof Light
        )
      )
        eligible = false;
    });
    if (!eligible) return;
    if (hasRig || hasBone) {
      // Group and bone counts alone do not measure shadow cache cost. The cache
      // bounds the visited hierarchy and retained caster data as it inspects them.
      this.trackRigCasters = hasRig;
      return;
    }
    this.traverse((object) => {
      if (object === this) return;
      if (object.matrixAutoUpdate) object.updateMatrix();
      object.matrixAutoUpdate = false;
    });
    this.sealed = true;
    this.settled = false;
  }

  override updateMatrixWorld(force?: boolean): void {
    if (!this.sealed) {
      super.updateMatrixWorld(force);
      return;
    }
    if (this.matrixAutoUpdate) this.updateMatrix();
    const parent = this.parent;
    if (
      this.settled &&
      this.placedLocal.equals(this.matrix) &&
      this.hadParent === Boolean(parent) &&
      (!parent || this.placedParent.equals(parent.matrixWorld))
    ) {
      this.matrixWorldNeedsUpdate = false;
      return;
    }
    // Reparenting and root/ancestor changes still propagate to every descendant.
    super.updateMatrixWorld(true);
    this.placedLocal.copy(this.matrix);
    if (parent) this.placedParent.copy(parent.matrixWorld);
    this.hadParent = Boolean(parent);
    this.settled = true;
  }
}
