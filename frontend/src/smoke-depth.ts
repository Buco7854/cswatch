import {
  BackSide,
  DoubleSide,
  FrontSide,
  type Material,
  Mesh,
  MeshDepthMaterial,
  NoBlending,
  NormalBlending,
  PerspectiveCamera,
  type Object3D,
  type Scene,
  type Side,
  type Texture,
  type WebGLRenderer,
} from 'three';

export type SmokeRect = { x: number; y: number; width: number; height: number };

/** Crop in clip space to keep the original camera's exact rays and lens offsets.
 * Rectangles use bottom-left drawing-buffer coordinates. */
export function cropSmokeCamera(
  output: PerspectiveCamera,
  source: PerspectiveCamera,
  crop: SmokeRect,
  width: number,
  height: number,
  far: number,
) {
  output.copy(source, false);
  output.matrixWorld.copy(source.matrixWorld);
  output.matrixWorldInverse.copy(source.matrixWorldInverse);
  output.matrixWorldAutoUpdate = false;
  output.far = Math.min(source.far, Math.max(source.near + 0.01, far));
  const projection = output.projectionMatrix.elements;
  const sx = width / crop.width;
  const sy = height / crop.height;
  // The asymmetric perspective offsets multiply view z (= -clip w).
  projection[0] *= sx;
  projection[5] *= sy;
  projection[8] = projection[8] * sx + sx * ((2 * crop.x) / width - 1) + 1;
  projection[9] = projection[9] * sy + sy * ((2 * crop.y) / height - 1) + 1;
  projection[10] = -(output.far + output.near) / (output.far - output.near);
  projection[14] = (-2 * output.far * output.near) / (output.far - output.near);
  output.projectionMatrixInverse.copy(output.projectionMatrix).invert();
}

type SurfaceMaterial = Material & {
  map?: Texture | null;
  alphaMap?: Texture | null;
  displacementMap?: Texture | null;
  displacementScale?: number;
  displacementBias?: number;
  wireframe?: boolean;
  transmission?: number;
};

/** Reuse the actual world meshes so posed skinning, instance buffers and map
 * culling work exactly as in the normal render. Only this synchronous pass
 * sees the replacement materials. Sky and viewmodel live in other scenes. */
export class SmokeDepthPass {
  private readonly shared = [FrontSide, BackSide, DoubleSide].map((side) =>
    this.depthMaterial(side),
  );
  private readonly masked = new Map<Material, { version: number; depth: MeshDepthMaterial }>();
  private readonly skipped = new MeshDepthMaterial({ visible: false });
  private readonly meshes: [Mesh, Material | Material[]][] = [];
  private readonly layers: [Object3D, number][] = [];

  private depthMaterial(side: Side) {
    return new MeshDepthMaterial({ side, colorWrite: false, blending: NoBlending });
  }

  private depthFor(source: SurfaceMaterial) {
    if (
      !source.visible ||
      source.transparent ||
      !source.depthWrite ||
      !source.depthTest ||
      (source.blending !== NormalBlending && source.blending !== NoBlending) ||
      (source.transmission ?? 0) > 0
    )
      return this.skipped;
    if (
      !source.alphaTest &&
      !source.alphaHash &&
      !source.displacementMap &&
      !source.clippingPlanes?.length &&
      !source.wireframe &&
      !source.polygonOffset
    )
      return this.shared[source.side];

    let cached = this.masked.get(source);
    if (!cached) {
      cached = { depth: this.depthMaterial(source.side), version: -1 };
      this.masked.set(source, cached);
    }
    const { depth } = cached;
    const map = source.alphaTest || source.alphaHash ? (source.map ?? null) : null;
    const alphaMap = source.alphaTest || source.alphaHash ? (source.alphaMap ?? null) : null;
    if (
      cached.version !== source.version ||
      depth.map !== map ||
      depth.alphaMap !== alphaMap ||
      depth.side !== source.side
    ) {
      cached.version = source.version;
      depth.needsUpdate = true;
    }
    depth.side = source.side;
    depth.map = map;
    depth.alphaMap = alphaMap;
    depth.alphaTest = source.alphaTest;
    depth.alphaHash = source.alphaHash;
    depth.opacity = source.opacity;
    depth.displacementMap = source.displacementMap ?? null;
    depth.displacementScale = source.displacementScale ?? 1;
    depth.displacementBias = source.displacementBias ?? 0;
    depth.clippingPlanes = source.clippingPlanes;
    depth.clipIntersection = source.clipIntersection;
    depth.wireframe = source.wireframe ?? false;
    depth.polygonOffset = source.polygonOffset;
    depth.polygonOffsetFactor = source.polygonOffsetFactor;
    depth.polygonOffsetUnits = source.polygonOffsetUnits;
    return depth;
  }

  render(gl: WebGLRenderer, world: Scene, camera: PerspectiveCamera) {
    const background = world.background;
    const before = world.onBeforeRender;
    const shadows = gl.shadowMap.enabled;
    try {
      world.traverseVisible((object) => {
        if (object instanceof Mesh) {
          const material = object.material;
          this.meshes.push([object, material]);
          object.material = Array.isArray(material)
            ? material.map((item) => this.depthFor(item))
            : this.depthFor(material);
        } else if (object.layers.mask && ('material' in object || 'isLight' in object)) {
          this.layers.push([object, object.layers.mask]);
          object.layers.mask = 0;
        }
      });
      world.background = null;
      world.onBeforeRender = () => {};
      gl.shadowMap.enabled = false;
      gl.autoClear = false;
      gl.clear(false, true, false);
      gl.render(world, camera);
    } finally {
      for (const [mesh, material] of this.meshes) mesh.material = material;
      for (const [object, mask] of this.layers) object.layers.mask = mask;
      this.meshes.length = this.layers.length = 0;
      gl.shadowMap.enabled = shadows;
      world.background = background;
      world.onBeforeRender = before;
    }
  }

  dispose() {
    for (const material of this.shared) material.dispose();
    for (const { depth } of this.masked.values()) depth.dispose();
    this.masked.clear();
    this.skipped.dispose();
  }
}
