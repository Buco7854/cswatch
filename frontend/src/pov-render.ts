import type { Camera, PerspectiveCamera, Scene, WebGLRenderer } from 'three';
import { withSceneEnvironment } from './map-ibl';
import { povProjection } from './pov-camera';

/** Share the world eye pose without inheriting its FOV, zoom or clip planes. */
export function updatePovCamera(world: Camera, equipment: PerspectiveCamera, aspect: number) {
  world.updateWorldMatrix(true, false);
  world.matrixWorld.decompose(equipment.position, equipment.quaternion, equipment.scale);
  equipment.updateMatrixWorld();
  const projection = povProjection(aspect);
  if (equipment.aspect !== projection.aspect || equipment.fov !== projection.fov) {
    equipment.aspect = projection.aspect;
    equipment.fov = projection.fov;
    equipment.updateProjectionMatrix();
  }
}

/** A viewmodel has its own depth, so nearby map walls cannot cut through it. */
export function renderPovEquipment(
  renderer: WebGLRenderer,
  world: Scene,
  equipment: Scene,
  worldCamera: Camera,
  equipmentCamera: Camera,
  worldAlreadyRendered: boolean,
  skyExposure: number,
  beforeEquipment?: () => void,
): void {
  const autoClear = renderer.autoClear;
  try {
    if (!worldAlreadyRendered) renderer.render(world, worldCamera);
    renderer.autoClear = false;
    renderer.clearDepth();
    withSceneEnvironment(world, equipment, () => {
      equipment.environmentIntensity *= skyExposure;
      beforeEquipment?.();
      renderer.render(equipment, equipmentCamera);
    });
  } finally {
    renderer.autoClear = autoClear;
  }
}
