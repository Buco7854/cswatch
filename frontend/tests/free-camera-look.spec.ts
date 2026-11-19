import { expect, test } from '@playwright/test';
import { PerspectiveCamera, Vector3 } from 'three';
import { turnFreeCamera } from '../src/free-camera-look';

test('free camera turns in place, keeps the horizon level and permits looking above it', () => {
  const camera = new PerspectiveCamera();
  camera.position.set(12, 3, -7);
  camera.lookAt(30, 3, -7);
  const position = camera.position.clone(),
    initial = camera.getWorldDirection(new Vector3());
  turnFreeCamera(camera, 200, -200);
  expect(camera.position.toArray()).toEqual(position.toArray());
  const direction = camera.getWorldDirection(new Vector3());
  expect(direction.distanceTo(initial)).toBeGreaterThan(0.1);
  expect(direction.y).toBeGreaterThan(0);
  expect(camera.rotation.z).toBe(0);
  turnFreeCamera(camera, 0, -100000);
  expect(camera.rotation.x).toBeLessThan(Math.PI / 2);
  expect(camera.getWorldDirection(new Vector3()).y).toBeGreaterThan(0.99);
  const saved = camera.quaternion.toArray();
  turnFreeCamera(camera, Number.NaN, 10);
  expect(camera.quaternion.toArray()).toEqual(saved);
});
