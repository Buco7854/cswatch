import {
  Box3,
  Camera,
  Color,
  Data3DTexture,
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
  RGFormat,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderTarget,
  type WebGLRenderer,
} from 'three';
import {
  BILLOW_SPAN,
  CELL,
  GRID,
  HALF_GRID,
  MAX_HOLES,
  type SmokeField,
  type SmokeSample,
} from './smoke-field';
import { compositeFragment, marchFragment, quadVertex } from './smoke-volume-shaders';

import { cropSmokeCamera, SmokeDepthPass, type SmokeRect as Rect } from './smoke-depth';
import { smokeNoise } from './smoke-noise';
import type { FollowCamera } from './follow-camera';

export type SmokeSunTrace = (
  ray: Pick<FollowCamera, 'target' | 'position'>,
) => FollowCamera['position'];
export type SmokeDraw = SmokeSample & {
  key: string;
  tint: Color;
  drift: number;
  recorded: boolean;
};

function upload(field: SmokeField) {
  const texture = new Data3DTexture(field.texels, GRID, GRID, GRID);
  texture.format = RGFormat;
  texture.minFilter = texture.magFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

class Surface {
  private previous: SmokeField;
  private current: SmokeField;
  readonly from: Data3DTexture;
  readonly to: Data3DTexture;
  readonly target = new WebGLRenderTarget(1, 1, {
    minFilter: NearestFilter,
    magFilter: NearestFilter,
    depthBuffer: false,
  });
  readonly uniforms = {
    clipRect: { value: new Vector4() },
    depthRect: { value: new Vector4() },
    marched: { value: this.target.texture },
    opaqueDepth: { value: null as DepthTexture | null },
    cameraRange: { value: new Vector2() },
    marchSize: { value: new Vector2() },
    targetSize: { value: new Vector2() },
    sceneLightScale: { value: 1 },
  };
  readonly surfaceMaterial = new ShaderMaterial({
    uniforms: this.uniforms,
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
  readonly mesh: Mesh;

  constructor(smoke: SmokeDraw, geometry: PlaneGeometry, parent: Group) {
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

  dispose() {
    this.mesh.removeFromParent();
    this.surfaceMaterial.dispose();
    this.target.dispose();
    this.from.dispose();
    this.to.dispose();
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

function smokeDepthExtent(required: number, current: number, limit: number) {
  if (required <= current) return Math.min(current, limit);
  return Math.min(limit, Math.max(Math.ceil(required / 32) * 32, current * 2));
}

export class SmokeVolumePass {
  private readonly geometry = new PlaneGeometry();
  private readonly surfaces = new Map<string, Surface>();
  private readonly sunlight = new Map<string, number>();
  private reserveDepthStorage = true;
  private targetStatus = new WeakMap<
    WebGLRenderTarget,
    {
      width: number;
      height: number;
      complete: boolean;
    }
  >();
  private readonly depth = new WebGLRenderTarget(1, 1, {
    minFilter: NearestFilter,
    magFilter: NearestFilter,
    depthTexture: new DepthTexture(1, 1),
  });
  private readonly depthPass = new SmokeDepthPass();
  private readonly depthCamera = new PerspectiveCamera();
  private readonly detail = smokeNoise();
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
    detailField: { value: this.detail },
    opaqueDepth: { value: this.depth.depthTexture },
    previousField: { value: null as Data3DTexture | null },
    currentField: { value: null as Data3DTexture | null },
    inverseProjection: { value: new Matrix4() },
    cameraWorld: { value: new Matrix4() },
    cameraRange: { value: new Vector2() },
    origin: { value: new Vector3() },
    boxMin: { value: new Vector3() },
    boxMax: { value: new Vector3() },
    tint: { value: new Color() },
    sunColor: { value: new Color() },
    sunVisibility: { value: 1 },
    sunDirection: { value: new Vector3() },
    fieldMix: { value: 0 },
    amount: { value: 0 },
    recorded: { value: false },
    fieldScale: { value: 1 },
    drift: { value: 0 },
    stepSize: { value: CELL * 0.3 },
    blastHoles: { value: Array.from({ length: MAX_HOLES }, () => new Vector4()) },
    blastStrength: { value: new Float32Array(MAX_HOLES) },
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

  constructor(
    private readonly group: Group,
    private readonly sun: Vector3,
    private readonly sunTrace?: SmokeSunTrace,
  ) {
    const quad = new Mesh(this.geometry, this.marchMaterial);
    quad.frustumCulled = false;
    this.quadScene.add(quad);
  }

  render(
    gl: WebGLRenderer,
    world: Scene,
    camera: PerspectiveCamera,
    smoke: SmokeDraw[],
    sunColor: Color,
    low: boolean,
    xray: boolean,
    sceneLightScale = 1,
  ) {
    this.hide();
    const keys = new Set(smoke.map(({ key }) => key));
    for (const [key, surface] of this.surfaces) {
      if (!keys.has(key)) {
        surface.dispose();
        this.surfaces.delete(key);
        this.sunlight.delete(key);
      }
    }
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
      cropSmokeCamera(this.depthCamera, camera, crop, this.size.x, this.size.y, far + 0.01);
      if (!this.bindTarget(gl, this.depth)) {
        if (width === crop.width && height === crop.height) return false;
        // A tight allocation can still succeed under GPU memory pressure.
        this.reserveDepthStorage = false;
        this.depth.setSize(crop.width, crop.height);
        if (!this.bindTarget(gl, this.depth)) return false;
      }
      this.depthPass.render(gl, world, this.depthCamera);
      gl.autoClear = false;
      const rendered = [];
      for (const [i, { cloud, rect }] of visible.entries()) {
        const surface = this.renderCloud(
          gl,
          camera,
          cloud,
          rect,
          crop,
          sunColor,
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
    // Procedural event clouds can displace their edge beyond the grid's trilinear support.
    if (!smoke.recorded) this.box.expandByScalar(BILLOW_SPAN * 0.5 * smoke.scale);
    this.box.min.max(this.gridMin.setScalar(-HALF_GRID * smoke.scale));
    this.box.max.min(this.gridMax.setScalar(HALF_GRID * smoke.scale));
    this.box.translate(this.marchUniforms.origin.value.fromArray(smoke.origin));
  }

  private sunVisibility(cloud: SmokeDraw) {
    if (!this.sunTrace) return 1;
    const cached = this.sunlight.get(cloud.key);
    if (cached !== undefined) return cached;
    const [x, y, z] = cloud.origin;
    let open = 0;
    // The main map trace is shared with the shoulder camera. A few static
    // probes distinguish a covered cloud from a sunlit one on every tier,
    // without updating a shadow map or tracing once per frame.
    for (const lateral of [-0.9, 0, 0.9]) {
      const target: FollowCamera['target'] = [x + lateral, y + 1.0, z - lateral * 0.55];
      const position: FollowCamera['position'] = [
        target[0] + this.sun.x * 48,
        target[1] + this.sun.y * 48,
        target[2] + this.sun.z * 48,
      ];
      const end = this.sunTrace({ target, position });
      open += Number(
        Math.hypot(end[0] - position[0], end[1] - position[1], end[2] - position[2]) < 0.02,
      );
    }
    const visible = open / 3;
    this.sunlight.set(cloud.key, visible);
    return visible;
  }

  private renderCloud(
    gl: WebGLRenderer,
    camera: PerspectiveCamera,
    cloud: SmokeDraw,
    rect: Rect,
    crop: Rect,
    sunColor: Color,
    low: boolean,
    xray: boolean,
    order: number,
  ) {
    let surface = this.surfaces.get(cloud.key);
    if (!surface) {
      surface = new Surface(cloud, this.geometry, this.group);
      this.surfaces.set(cloud.key, surface);
    }
    surface.update(cloud);
    const scale = low ? 0.35 : 0.5;
    const width = Math.ceil(rect.width * scale),
      height = Math.ceil(rect.height * scale);
    const { target } = surface;
    // Grow in blocks to avoid allocating a new texture on every camera move.
    if (width > target.width || height > target.height)
      target.setSize(
        Math.max(target.width, Math.ceil(width / 32) * 32),
        Math.max(target.height, Math.ceil(height / 32) * 32),
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
    u.sunDirection.value.copy(this.sun);
    u.sunColor.value.copy(sunColor);
    u.sunVisibility.value = this.sunVisibility(cloud);
    u.tint.value.copy(cloud.tint);
    u.amount.value = cloud.amount;
    u.recorded.value = cloud.recorded;
    u.fieldMix.value = cloud.mix;
    u.fieldScale.value = cloud.scale;
    u.drift.value = cloud.drift;
    u.stepSize.value = CELL * (low ? 0.43 : 0.3);
    u.blastStrength.value.fill(0);
    cloud.holes.forEach(({ position, radius, strength }, i) => {
      u.blastHoles.value[i].set(...position, radius);
      u.blastStrength.value[i] = strength;
    });
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
    for (const surface of this.surfaces.values()) surface.dispose();
    this.surfaces.clear();
    this.sunlight.clear();
    this.depth.dispose();
    this.revalidateTargets();
    this.depthPass.dispose();
    this.detail.dispose();
    this.marchMaterial.dispose();
    this.geometry.dispose();
  }
}
