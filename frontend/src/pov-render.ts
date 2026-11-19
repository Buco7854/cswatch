import type { Camera, Scene, WebGLRenderer } from 'three';
import { withSceneEnvironment } from './map-ibl';

/** A viewmodel has its own depth, so nearby map walls cannot cut through it. */
export function renderPovEquipment(
  renderer: WebGLRenderer,
  world: Scene,
  equipment: Scene,
  camera: Camera,
  worldAlreadyRendered: boolean,
): void {
  const autoClear = renderer.autoClear;
  try {
    if (!worldAlreadyRendered) renderer.render(world, camera);
    renderer.autoClear = false;
    renderer.clearDepth();
    withSceneEnvironment(world, equipment, () => renderer.render(equipment, camera));
  } finally {
    renderer.autoClear = autoClear;
  }
}
