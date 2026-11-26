import {
  Box3,
  Camera,
  Color,
  Data3DTexture,
  HalfFloatType,
  RGBAFormat,
  RedFormat,
  WebGL3DRenderTarget,
  DepthStencilFormat,
  DepthTexture,
  Frustum,
  Group,
  LinearFilter,
  Matrix4,
  Mesh,
  NearestFilter,
  NoBlending,
  NotEqualStencilFunc,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  UnsignedInt248Type,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderTarget,
  type WebGLRenderer,
} from 'three';
import {
  GRID,
  HALF_GRID,
  MAX_HOLES,
  SMOKE_STEP,
  type SmokeField,
  type SmokeSample,
} from './smoke-field';
import {
  LIGHT_CELLS,
  compositeFragment,
  lightFragment,
  marchFragment,
  quadVertex,
} from './smoke-volume-shaders';

import { cropSmokeCamera, SmokeDepthPass, type SmokeRect as Rect } from './smoke-depth';
import { smokeNoise } from './smoke-noise';
export type SmokeDraw = SmokeSample & {
  key: string;
  recorded: boolean;
};
/** The map's probe-volume uniforms (see world/actor-lighting.ts) and its sun, in scene axes. */
export type SmokeLighting = {
  /** Absent without a native world: the volume uses a neutral constant light. */
  probes?: Record<string, { value: unknown }>;
  sunDirection: Vector3;
  sunColor: Color;
};

function upload(field: SmokeField) {
  const texture = new Data3DTexture(field.texels, GRID, GRID, GRID);
  texture.format = RedFormat;
  texture.minFilter = texture.magFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

const marchTarget = () =>
  new WebGLRenderTarget(1, 1, {
    minFilter: NearestFilter,
    magFilter: NearestFilter,
    depthBuffer: false,
  });

function compositeUniforms(target: WebGLRenderTarget) {
  return {
    clipRect: { value: new Vector4() },
    depthRect: { value: new Vector4() },
    marched: { value: target.texture },
    opaqueDepth: { value: null as DepthTexture | null },
    cameraRange: { value: new Vector2() },
    marchSize: { value: new Vector2() },
    targetSize: { value: new Vector2() },
    sceneLightScale: { value: 1 },
  };
}

const compositeMaterial = (uniforms: ReturnType<typeof compositeUniforms>) =>
  new ShaderMaterial({
    uniforms,
    vertexShader: quadVertex,
    fragmentShader: compositeFragment,
    transparent: true,
    premultipliedAlpha: true,
    depthTest: false,
    depthWrite: false,
    stencilFunc: NotEqualStencilFunc,
    stencilRef: 1,
    stencilWriteMask: 0,
  });

class Surface {
  private previous: SmokeField;
  private current: SmokeField;
  readonly from: Data3DTexture;
  readonly to: Data3DTexture;
  readonly uniforms: ReturnType<typeof compositeUniforms>;
  readonly surfaceMaterial: ShaderMaterial;
  readonly mesh: Mesh;
  /** The baked light volume and the lighting bundle it was baked from. */
  readonly light = new WebGL3DRenderTarget(LIGHT_CELLS, LIGHT_CELLS, LIGHT_CELLS, {
    type: HalfFloatType,
    format: RGBAFormat,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    depthBuffer: false,
  });
  bakedFrom?: SmokeLighting;

  constructor(
    smoke: SmokeDraw,
    geometry: PlaneGeometry,
    parent: Group,
    readonly target: WebGLRenderTarget,
  ) {
    this.uniforms = compositeUniforms(target);
    this.surfaceMaterial = compositeMaterial(this.uniforms);
    this.from = upload((this.previous = smoke.previous));
    this.to = upload((this.current = smoke.current));
    this.mesh = new Mesh(geometry, this.surfaceMaterial);
    this.mesh.name = 'smoke-volume';
    this.mesh.frustumCulled = false;
    this.mesh.raycast = () => {};
    this.mesh.visible = false;
    parent.add(this.mesh);
  }

  update(smoke: SmokeDraw) {
    if (this.previous !== smoke.previous) {
      this.from.image.data = smoke.previous.texels;
      this.from.needsUpdate = true;
      this.previous = smoke.previous;
    }
    if (this.current !== smoke.current) {
      this.to.image.data = smoke.current.texels;
      this.to.needsUpdate = true;
      this.current = smoke.current;
    }
  }

  /** The pass keeps the march target for the next cloud. */
  dispose() {
    this.mesh.removeFromParent();
    this.surfaceMaterial.dispose();
    this.from.dispose();
    this.to.dispose();
    this.light.dispose();
  }
}

/** Conservative pixel bounds, including the box edges sliced by the near plane.
 * This stays finite when a corner is behind the eye. */
function screenBounds(
  box: Box3,
  matrix: Matrix4,
  corners: Vector4[],
  size: Vector2,
): Rect | undefined {
  let left = 1,
    bottom = 1,
    right = -1,
    top = -1;
  const add = (x: number, y: number, w: number) => {
    const nx = x / w,
      ny = y / w;
    left = Math.min(left, nx);
    right = Math.max(right, nx);
    bottom = Math.min(bottom, ny);
    top = Math.max(top, ny);
  };
  for (let i = 0; i < 8; i++) {
    corners[i]
      .set(
        i & 1 ? box.max.x : box.min.x,
        i & 2 ? box.max.y : box.min.y,
        i & 4 ? box.max.z : box.min.z,
        1,
      )
      .applyMatrix4(matrix);
  }
  for (let i = 0; i < 8; i++) {
    const a = corners[i],
      da = a.z + a.w;
    if (da >= 0) add(a.x, a.y, a.w);
    for (const bit of [1, 2, 4]) {
      if (i & bit) continue;
      const b = corners[i | bit],
        db = b.z + b.w;
      if (da >= 0 === db >= 0) continue;
      const t = da / (da - db);
      add(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.w + (b.w - a.w) * t);
    }
  }
  const x = Math.max(0, Math.floor((left * 0.5 + 0.5) * size.x));
  const y = Math.max(0, Math.floor((bottom * 0.5 + 0.5) * size.y));
  const width = Math.min(size.x, Math.ceil((right * 0.5 + 0.5) * size.x)) - x;
  const height = Math.min(size.y, Math.ceil((top * 0.5 + 0.5) * size.y)) - y;
  if (width > 0 && height > 0) return { x, y, width, height };
}

const MAX_SPARE_TARGETS = 8;

function marchExtent(required: number, current: number, limit: number) {
  const block = (value: number) => Math.ceil(value / 32) * 32;
  return Math.max(current, block(required), Math.min(block(limit), block(current * 1.5)));
}

function smokeDepthExtent(required: number, current: number, limit: number) {
  if (required <= current) return Math.min(current, limit);
  return Math.min(limit, Math.max(Math.ceil(required / 32) * 32, current * 2));
}

export class SmokeVolumePass {
  private readonly geometry = new PlaneGeometry();
  private readonly surfaces = new Map<string, Surface>();
  // March targets outlive their clouds so a later smoke needs no new
  // allocation or completeness check.
  private readonly spareTargets: WebGLRenderTarget[] = [];
  private warmed = false;
  private reserveDepthStorage = true;
  private targetStatus = new WeakMap<
    WebGLRenderTarget,
    {
      width: number;
      height: number;
      complete: boolean;
    }
  >();
  // Matches the compositor's depth-stencil target: depth blits require identical formats.
  private readonly depth = new WebGLRenderTarget(1, 1, {
    minFilter: NearestFilter,
    magFilter: NearestFilter,
    stencilBuffer: true,
    depthTexture: Object.assign(new DepthTexture(1, 1, UnsignedInt248Type), {
      format: DepthStencilFormat,
    }),
  });
  private readonly depthPass = new SmokeDepthPass();
  private readonly depthCamera = new PerspectiveCamera();
  private readonly worley = smokeNoise();
  // A uniform neutral light for scenes without a probe volume.
  private readonly constantLight = Object.assign(
    new Data3DTexture(new Uint8Array([89, 89, 89, 255]), 1, 1, 1),
    { format: RGBAFormat, needsUpdate: true },
  );
  private lightMaterial?: { probes: SmokeLighting['probes']; material: ShaderMaterial };
  private readonly quadScene = new Scene();
  private readonly quadCamera = new Camera();
  private readonly size = new Vector2();
  private readonly projection = new Matrix4();
  private readonly frustum = new Frustum();
  private readonly box = new Box3();
  private readonly gridMin = new Vector3();
  private readonly gridMax = new Vector3();
  private readonly eye = new Vector3();
  private readonly corners = Array.from({ length: 8 }, () => new Vector4());
  private readonly marchUniforms = {
    clipRect: { value: new Vector4(-1, -1, 1, 1) },
    screenRect: { value: new Vector4() },
    depthRect: { value: new Vector4() },
    worley: { value: this.worley },
    lightVolume: { value: this.constantLight as Data3DTexture | WebGL3DRenderTarget['texture'] },
    opaqueDepth: { value: this.depth.depthTexture },
    previousField: { value: null as Data3DTexture | null },
    currentField: { value: null as Data3DTexture | null },
    inverseProjection: { value: new Matrix4() },
    cameraWorld: { value: new Matrix4() },
    cameraRange: { value: new Vector2() },
    origin: { value: new Vector3() },
    boxMin: { value: new Vector3() },
    boxMax: { value: new Vector3() },
    sunColor: { value: new Color() },
    sunDirection: { value: new Vector3() },
    fieldMix: { value: 0 },
    amount: { value: 0 },
    fieldScale: { value: 1 },
    age: { value: 0 },
    stepSize: { value: SMOKE_STEP },
    blasts: { value: Array.from({ length: MAX_HOLES }, () => new Vector4(0, 0, 0, -1)) },
  };
  private readonly marchMaterial = new ShaderMaterial({
    vertexShader: quadVertex,
    fragmentShader: marchFragment,
    uniforms: this.marchUniforms,
    depthTest: false,
    depthWrite: false,
    blending: NoBlending,
    toneMapped: false,
  });
  private readonly keeperTarget = marchTarget();
  private readonly keeper = compositeMaterial(compositeUniforms(this.keeperTarget));

  constructor(private readonly group: Group) {
    const quad = new Mesh(this.geometry, this.marchMaterial);
    quad.frustumCulled = false;
    this.quadScene.add(quad);
  }

  render(
    gl: WebGLRenderer,
    world: Scene,
    camera: PerspectiveCamera,
    smoke: SmokeDraw[],
    lighting: SmokeLighting,
    low: boolean,
    xray: boolean,
    sceneLightScale = 1,
    framebuffer?: WebGLFramebuffer,
  ) {
    this.hide();
    const keys = new Set(smoke.map(({ key }) => key));
    for (const [key, surface] of this.surfaces) {
      if (!keys.has(key)) {
        this.release(surface);
        this.surfaces.delete(key);
      }
    }
    if (lighting.probes && !gl.getContext().isContextLost()) this.lightBake(gl, lighting.probes);
    if (!smoke.length || !this.group.visible) return true;
    gl.getDrawingBufferSize(this.size);
    if (this.size.x === 0 || this.size.y === 0) return true;
    if (Math.max(this.size.x, this.size.y) > gl.capabilities.maxTextureSize) return false;
    if (gl.getContext().isContextLost()) return false;

    camera.updateMatrixWorld();
    this.eye.setFromMatrixPosition(camera.matrixWorld);
    this.frustum.setFromProjectionMatrix(
      this.projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
    );
    const visible = smoke
      .flatMap((cloud) => {
        if (cloud.amount <= 0) return [];
        this.setBox(cloud);
        if (!this.frustum.intersectsBox(this.box)) return [];
        const rect = screenBounds(this.box, this.projection, this.corners, this.size);
        if (!rect) return [];
        const distance = this.box.distanceToPoint(this.eye);
        return [
          { cloud, rect, distance, far: Math.max(...this.corners.map((corner) => corner.w)) },
        ];
      })
      .sort((a, b) => b.distance - a.distance);
    if (!visible.length) return true;
    // The depth pass and the compositor use native drawing-buffer pixels.
    // Keep a single-sampled depth texture instead of reading the canvas's
    // multisampled default depth or the independently projected sky/weapon.
    const oldTarget = gl.getRenderTarget();
    const autoClear = gl.autoClear;
    try {
      let left = this.size.x,
        bottom = this.size.y,
        right = 0,
        top = 0,
        far = camera.near;
      for (const { rect, far: cloudFar } of visible) {
        far = Math.max(far, cloudFar);
        left = Math.min(left, rect.x);
        bottom = Math.min(bottom, rect.y);
        right = Math.max(right, rect.x + rect.width);
        top = Math.max(top, rect.y + rect.height);
      }
      const crop = { x: left, y: bottom, width: right - left, height: top - bottom };
      // Camera motion changes the union of the smoke rectangles every frame.
      // Keep its storage while the crop fits. Only the exact crop is drawn and
      // sampled, and a smaller drawing buffer also lowers the capacity ceiling.
      const width = this.reserveDepthStorage
        ? smokeDepthExtent(crop.width, this.depth.width, this.size.x)
        : crop.width;
      const height = this.reserveDepthStorage
        ? smokeDepthExtent(crop.height, this.depth.height, this.size.y)
        : crop.height;
      if (width !== this.depth.width || height !== this.depth.height)
        this.depth.setSize(width, height);
      this.depth.viewport.set(0, 0, crop.width, crop.height);
      cropSmokeCamera(
        this.depthCamera,
        camera,
        crop,
        this.size.x,
        this.size.y,
        framebuffer ? camera.far : far + 0.01,
      );
      if (!this.bindTarget(gl, this.depth)) {
        if (width === crop.width && height === crop.height) return false;
        // A tight allocation can still succeed under GPU memory pressure.
        this.reserveDepthStorage = false;
        this.depth.setSize(crop.width, crop.height);
        if (!this.bindTarget(gl, this.depth)) return false;
      }
      if (framebuffer) {
        const context = gl.getContext() as WebGL2RenderingContext;
        context.bindFramebuffer(context.READ_FRAMEBUFFER, framebuffer);
        context.blitFramebuffer(
          left,
          bottom,
          right,
          top,
          0,
          0,
          crop.width,
          crop.height,
          context.DEPTH_BUFFER_BIT,
          context.NEAREST,
        );
        context.bindFramebuffer(
          context.READ_FRAMEBUFFER,
          context.getParameter(context.DRAW_FRAMEBUFFER_BINDING),
        );
        this.depthCamera.near = camera.near;
        this.depthCamera.far = camera.far;
      } else this.depthPass.render(gl, world, this.depthCamera);
      gl.autoClear = false;
      const rendered = [];
      for (const [i, { cloud, rect }] of visible.entries()) {
        const surface = this.renderCloud(
          gl,
          camera,
          cloud,
          rect,
          crop,
          lighting,
          low,
          xray,
          7 + i / visible.length,
        );
        if (!surface) return false;
        rendered.push(surface);
      }
      for (const surface of rendered) {
        surface.uniforms.sceneLightScale.value = sceneLightScale;
        surface.mesh.visible = true;
      }
      return true;
    } finally {
      gl.setRenderTarget(oldTarget);
      gl.autoClear = autoClear;
    }
  }

  hide() {
    for (const surface of this.surfaces.values()) surface.mesh.visible = false;
  }

  private release(surface: Surface) {
    surface.dispose();
    if (this.spareTargets.length < MAX_SPARE_TARGETS) this.spareTargets.push(surface.target);
    else surface.target.dispose();
  }

  /** Link both smoke programs before the first cloud. A retained composite
   * material keeps its program alive between rounds without smoke. */
  warm(gl: WebGLRenderer) {
    if (this.warmed) return;
    this.warmed = true;
    const scene = new Scene();
    scene.add(new Mesh(this.geometry, this.marchMaterial), new Mesh(this.geometry, this.keeper));
    const previous = gl.getRenderTarget();
    try {
      // Both passes draw into render targets: linear output without tone mapping.
      gl.setRenderTarget(this.depth);
      gl.compile(scene, this.quadCamera);
    } finally {
      gl.setRenderTarget(previous);
    }
  }

  revalidateTargets() {
    this.reserveDepthStorage = true;
    this.targetStatus = new WeakMap();
  }

  private bindTarget(gl: WebGLRenderer, target: WebGLRenderTarget) {
    gl.setRenderTarget(target);
    const { width, height } = target;
    const cached = this.targetStatus.get(target);
    if (cached?.width === width && cached.height === height) return cached.complete;
    const context = gl.getContext();
    const complete =
      context.checkFramebufferStatus(context.FRAMEBUFFER) === context.FRAMEBUFFER_COMPLETE;
    this.targetStatus.set(target, { width, height, complete });
    return complete;
  }

  private setBox(smoke: SmokeDraw) {
    this.box.min.fromArray(smoke.bounds.min).multiplyScalar(smoke.scale);
    this.box.max.fromArray(smoke.bounds.max).multiplyScalar(smoke.scale);
    this.box.min.max(this.gridMin.setScalar(-HALF_GRID * smoke.scale));
    this.box.max.min(this.gridMax.setScalar(HALF_GRID * smoke.scale));
    this.box.translate(this.marchUniforms.origin.value.fromArray(smoke.origin));
  }

  /** The light-bake program for this probe set, linked once when the map's lighting arrives. */
  private lightBake(gl: WebGLRenderer, probes: NonNullable<SmokeLighting['probes']>) {
    if (this.lightMaterial?.probes === probes) return this.lightMaterial.material;
    this.lightMaterial?.material.dispose();
    const material = new ShaderMaterial({
      vertexShader: quadVertex,
      fragmentShader: lightFragment,
      uniforms: {
        ...probes,
        clipRect: { value: new Vector4(-1, -1, 1, 1) },
        origin: { value: new Vector3() },
        layer: { value: 0 },
        fieldScale: { value: 1 },
      },
      depthTest: false,
      depthWrite: false,
      blending: NoBlending,
      toneMapped: false,
    });
    this.lightMaterial = { probes, material };
    const scene = new Scene();
    scene.add(new Mesh(this.geometry, material));
    const previous = gl.getRenderTarget();
    try {
      gl.setRenderTarget(this.keeperTarget);
      gl.compile(scene, this.quadCamera);
    } finally {
      gl.setRenderTarget(previous);
    }
    return material;
  }

  /** Bake the cloud's light volume once per cloud and lighting bundle. */
  private bakeLight(
    gl: WebGLRenderer,
    surface: Surface,
    cloud: SmokeDraw,
    lighting: SmokeLighting,
  ) {
    if (!lighting.probes) return this.constantLight;
    if (surface.bakedFrom === lighting) return surface.light.texture;
    const material = this.lightBake(gl, lighting.probes);
    material.uniforms.origin.value.fromArray(cloud.origin);
    material.uniforms.fieldScale.value = cloud.scale;
    const quad = this.quadScene.children[0] as Mesh;
    const march = quad.material;
    quad.material = material;
    try {
      for (let layer = 0; layer < LIGHT_CELLS; layer++) {
        material.uniforms.layer.value = layer;
        if (layer === 0) {
          if (!this.bindTarget(gl, surface.light)) return this.constantLight;
        } else gl.setRenderTarget(surface.light, layer);
        gl.render(this.quadScene, this.quadCamera);
      }
    } finally {
      quad.material = march;
    }
    // A growing analytic cloud changes scale; bake again only when it settles.
    if (cloud.recorded || cloud.scale >= 1) surface.bakedFrom = lighting;
    return surface.light.texture;
  }

  private renderCloud(
    gl: WebGLRenderer,
    camera: PerspectiveCamera,
    cloud: SmokeDraw,
    rect: Rect,
    crop: Rect,
    lighting: SmokeLighting,
    low: boolean,
    xray: boolean,
    order: number,
  ) {
    let surface = this.surfaces.get(cloud.key);
    if (!surface) {
      surface = new Surface(
        cloud,
        this.geometry,
        this.group,
        this.spareTargets.pop() ?? marchTarget(),
      );
      this.surfaces.set(cloud.key, surface);
    }
    surface.update(cloud);
    const scale = low ? 0.35 : 0.5;
    const width = Math.ceil(rect.width * scale),
      height = Math.ceil(rect.height * scale);
    const { target } = surface;
    // Grow geometrically in blocks: an approaching cloud reallocates (and
    // rechecks completeness) a few times, not on every camera move.
    if (width > target.width || height > target.height)
      target.setSize(
        marchExtent(width, target.width, Math.ceil(this.size.x * scale)),
        marchExtent(height, target.height, Math.ceil(this.size.y * scale)),
      );
    target.viewport.set(0, 0, width, height);

    const u = this.marchUniforms,
      out = surface.uniforms;
    const rectUv = u.screenRect.value.set(
      rect.x / this.size.x,
      rect.y / this.size.y,
      (rect.x + rect.width) / this.size.x,
      (rect.y + rect.height) / this.size.y,
    );
    const dx = rect.x - crop.x,
      dy = rect.y - crop.y;
    u.depthRect.value.set(
      dx / this.depth.width,
      dy / this.depth.height,
      (dx + rect.width) / this.depth.width,
      (dy + rect.height) / this.depth.height,
    );
    u.cameraRange.value.set(this.depthCamera.near, this.depthCamera.far);
    u.inverseProjection.value.copy(camera.projectionMatrixInverse);
    u.cameraWorld.value.copy(camera.matrixWorld);
    this.setBox(cloud);
    u.boxMin.value.copy(this.box.min);
    u.boxMax.value.copy(this.box.max);
    u.previousField.value = surface.from;
    u.currentField.value = surface.to;
    u.sunDirection.value.copy(lighting.sunDirection);
    // The smoke shader clamps the sun colour to [0, 1].
    u.sunColor.value.setRGB(
      Math.min(1, Math.max(0, lighting.sunColor.r)),
      Math.min(1, Math.max(0, lighting.sunColor.g)),
      Math.min(1, Math.max(0, lighting.sunColor.b)),
    );
    u.amount.value = cloud.amount;
    u.fieldMix.value = cloud.mix;
    u.fieldScale.value = cloud.scale;
    u.age.value = cloud.age;
    // Low quality halves the samples; each one stands for two of the game's steps.
    u.stepSize.value = SMOKE_STEP * (low ? 2 : 1);
    u.blasts.value.forEach((blast, i) => {
      const hole = cloud.holes[i];
      if (hole) blast.set(...hole.position, hole.since);
      else blast.set(0, 0, 0, -1);
    });
    u.lightVolume.value = this.bakeLight(gl, surface, cloud, lighting);
    if (!this.bindTarget(gl, target)) return;
    gl.render(this.quadScene, this.quadCamera);

    out.clipRect.value.copy(rectUv).multiplyScalar(2).subScalar(1);
    out.depthRect.value.copy(u.depthRect.value);
    out.cameraRange.value.copy(u.cameraRange.value);
    out.opaqueDepth.value = this.depth.depthTexture;
    out.marchSize.value.set(width, height);
    out.targetSize.value.set(target.width, target.height);
    surface.surfaceMaterial.stencilWrite = xray;
    surface.mesh.renderOrder = order;
    return surface;
  }

  dispose() {
    for (const surface of this.surfaces.values()) {
      surface.dispose();
      surface.target.dispose();
    }
    this.surfaces.clear();
    for (const target of this.spareTargets) target.dispose();
    this.spareTargets.length = 0;
    this.keeper.dispose();
    this.keeperTarget.dispose();
    this.warmed = false;
    this.lightMaterial?.material.dispose();
    this.lightMaterial = undefined;
    this.constantLight.dispose();
    this.depth.dispose();
    this.revalidateTargets();
    this.depthPass.dispose();
    this.worley.dispose();
    this.marchMaterial.dispose();
    this.geometry.dispose();
  }
}
