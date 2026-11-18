import {
  Box3,
  PerspectiveCamera,
  Vector3,
  type Camera,
  type Scene,
  type WebGLRenderer,
} from 'three';

const MAX_SKY_FAR = 1_000_000;
export function skyCameraFor(scene: Scene) {
  // Box3 uses existing geometry bounds, computing each geometry's bound only when absent.
  const box = new Box3().setFromObject(scene),
    center = box.getCenter(new Vector3()),
    radius = box.getSize(new Vector3()).length() / 2;
  return { camera: new PerspectiveCamera(), center, radius: Number.isFinite(radius) ? radius : 0 };
}
export function updateSkyCamera(
  main: PerspectiveCamera,
  sky: ReturnType<typeof skyCameraFor>,
): PerspectiveCamera {
  main.updateWorldMatrix(true, false);
  sky.camera.copy(main, false);
  main.matrixWorld.decompose(sky.camera.position, sky.camera.quaternion, sky.camera.scale);
  const distance = sky.camera.position.distanceTo(sky.center),
    extent = Number.isFinite(distance) ? distance + sky.radius + 16 : main.far;
  sky.camera.far = Math.max(main.far, Math.min(MAX_SKY_FAR, extent));
  sky.camera.updateProjectionMatrix();
  sky.camera.updateMatrixWorld(true);
  return sky.camera;
}

type Renderer = Pick<WebGLRenderer, 'autoClear' | 'clear' | 'clearDepth' | 'render'>;
/** Native 3D sky draws behind every main-world surface, regardless of relative geometry depth. */
export function renderSkyBehindMap(
  renderer: Renderer,
  main: Scene,
  sky: Scene,
  mainCamera: Camera,
  skyCamera: Camera,
) {
  const autoClear = renderer.autoClear,
    background = main.background,
    skyBackground = sky.background,
    skyIntensity = sky.backgroundIntensity,
    skyBlurriness = sky.backgroundBlurriness,
    skyRotation = sky.backgroundRotation.clone();
  try {
    renderer.autoClear = false;
    sky.background = background;
    sky.backgroundIntensity = main.backgroundIntensity;
    sky.backgroundBlurriness = main.backgroundBlurriness;
    sky.backgroundRotation.copy(main.backgroundRotation);
    renderer.clear(true, true, true);
    renderer.render(sky, skyCamera);
    renderer.clearDepth();
    main.background = null;
    renderer.render(main, mainCamera);
  } finally {
    main.background = background;
    sky.background = skyBackground;
    sky.backgroundIntensity = skyIntensity;
    sky.backgroundBlurriness = skyBlurriness;
    sky.backgroundRotation.copy(skyRotation);
    renderer.autoClear = autoClear;
  }
}
