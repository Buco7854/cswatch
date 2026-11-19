import { Group, Light, Mesh, Object3D, Scene, Matrix4, type AnimationClip } from 'three';

/**
 * Prepared map descendants are immutable; only their placement can change. Three's
 * normal scene update otherwise walks and recomposes every glTF node every frame.
 * Keep normal root/parent placement and leave potentially animated trees alone.
 * This owns no geometry, materials or textures and does not change visibility.
 */
export class StaticMapGroup extends Group {
  private sealed = false;
  private settled = false;
  private readonly placedLocal = new Matrix4();
  private readonly placedParent = new Matrix4();
  private hadParent = false;

  get immutableDescendants(): boolean {
    return this.sealed;
  }

  seal(clips: readonly AnimationClip[]): void {
    if (clips.length || this.sealed) return;
    let eligible = true;
    this.traverse((object) => {
      if (
        object.animations.length ||
        ('isSkinnedMesh' in object && object.isSkinnedMesh) ||
        ('isBone' in object && object.isBone) ||
        ('isInstancedMesh' in object && object.isInstancedMesh) ||
        (object instanceof Mesh && object.morphTargetInfluences?.length) ||
        !(
          object.constructor === Object3D ||
          object.constructor === Group ||
          object.constructor === Scene ||
          object.constructor === Mesh ||
          object === this ||
          object instanceof Light
        )
      )
        eligible = false;
    });
    if (!eligible) return;
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
