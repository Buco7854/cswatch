import { Group, type Object3D } from 'three';
import { prepareEquipmentModel } from './equipment-model';

/** Operator agents retain S2V meters/Y-up axes. The viewer applies its one +90°Y correction. */
export function prepareAgentModel(source: Object3D) {
  const root = new Group(),
    instance = prepareEquipmentModel(source);
  root.rotation.y = Math.PI / 2;
  root.add(instance);
  return { root, instance };
}
