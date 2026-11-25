import {
  Component,
  Suspense,
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  type RefObject,
  type ReactNode,
} from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Box3, Euler, Matrix4, Vector3, type Object3D } from 'three';
import type { PoseTiming } from '../player-pose';
import type { PreviousPose } from '../recorded-motion';
import { fitPovAttachment, staticPovAttachment } from '../pov-camera';
import { fitWeaponGrip, nativeWeaponFrame, type WeaponAnchor } from '../agent-attachment';
import { prepareEquipmentModel, disposeEquipmentInstance } from '../equipment-model';
import type {
  EquipmentModel,
  EquipmentModelCatalog,
  EquipmentModelTransform,
} from '../../../shared/equipment-models';
import type { Position } from '../types';
import type { SceneTrace } from '../world/queries';
import type { PresentItem } from '../item-state';
import { itemPose } from '../item-state';
import { equipmentIconKey } from '../equipment-icons';
import { useEquipmentGLTF, useEquipmentScope } from '../equipment-loader';
import type { ModelScope } from '../model-cache';
import { assertBaseColorTextures } from '../model-textures';
import { EquipmentMuzzle, useEquipmentFire } from './EquipmentFire';

export type EquipmentInstanceStatus = 'pending' | 'ready' | 'error';
type EquipmentContextValue = {
  catalog: EquipmentModelCatalog;
  identity: object;
  report: (instance: string, status: EquipmentInstanceStatus | null) => void;
};
export const EquipmentModels = createContext<EquipmentContextValue | null>(null);

class EquipmentBoundary extends Component<
  { scope: ModelScope; failed: () => void; fallback: ReactNode; children: ReactNode },
  { error: boolean }
> {
  state = { error: false };
  static getDerivedStateFromError() {
    return { error: true };
  }
  componentDidCatch() {
    this.props.failed();
    this.props.scope.invalidate();
  }
  render() {
    return this.state.error ? this.props.fallback : this.props.children;
  }
}
function LoadedEquipment({
  asset,
  scope,
  ready,
  presentation,
  projectile,
}: {
  asset: EquipmentModel;
  scope: ModelScope;
  ready: () => void;
  presentation?: (model: Object3D) => ReactNode;
  projectile?: boolean;
}) {
  const gltf = useEquipmentGLTF(asset.model);
  const { invalidate } = useThree();
  useLayoutEffect(() => scope.acquire(), [scope]);
  const model = useMemo(() => {
    const instance = prepareEquipmentModel(gltf.scene);
    if (projectile && asset.model.endsWith('/molotov.glb')) {
      // The native model contains the off-hand lighter on a separate skin branch.
      instance.getObjectByName('weapon_hand_l')?.scale.setScalar(0);
    }
    assertBaseColorTextures({ scene: instance, parser: gltf.parser });
    return instance;
  }, [gltf, asset.model, projectile]);
  useEffect(() => () => disposeEquipmentInstance(model), [model]);
  useLayoutEffect(() => {
    if (scope.isCurrent()) {
      ready();
      invalidate();
    }
  }, [scope, ready, invalidate]);
  return (
    <primitive object={model} dispose={null}>
      {presentation?.(model)}
    </primitive>
  );
}
function AvailableEquipment({
  asset,
  instance,
  fallback,
  presentation,
  projectile,
}: {
  asset: EquipmentModel;
  instance: string;
  fallback: ReactNode;
  presentation?: (model: Object3D) => ReactNode;
  projectile?: boolean;
}) {
  const context = useContext(EquipmentModels)!;
  const scope = useEquipmentScope(asset.model, context.identity);
  const { invalidate } = useThree();
  const callbacks = useMemo(
    () => ({
      ready: () => {
        if (scope.isCurrent()) context.report(instance, 'ready');
      },
      failed: () => {
        if (scope.isCurrent()) context.report(instance, 'error');
        invalidate();
      },
    }),
    [context.report, instance, scope, invalidate],
  );
  useLayoutEffect(() => () => context.report(instance, null), [context.report, instance]);
  return (
    <EquipmentBoundary
      key={asset.model + asset.assetVersion}
      scope={scope}
      failed={callbacks.failed}
      fallback={fallback}
    >
      <Suspense
        fallback={
          <EquipmentInstanceState instance={instance} status="pending">
            {fallback}
          </EquipmentInstanceState>
        }
      >
        <LoadedEquipment
          asset={asset}
          scope={scope}
          ready={callbacks.ready}
          presentation={presentation}
          projectile={projectile}
        />
      </Suspense>
    </EquipmentBoundary>
  );
}
export function EquipmentInstanceState({
  instance,
  status,
  children,
}: {
  instance: string;
  status: EquipmentInstanceStatus;
  children: ReactNode;
}) {
  const { report } = useContext(EquipmentModels)!;
  useLayoutEffect(() => {
    report(instance, status);
    return () => report(instance, null);
  }, [report, instance, status]);
  return children;
}
export function EquipmentModelInstance({
  equipment,
  instance,
  fallback = null,
  presentation,
  projectile,
}: {
  equipment: string;
  instance: string;
  fallback?: ReactNode;
  presentation?: (model: Object3D) => ReactNode;
  projectile?: boolean;
}) {
  const context = useContext(EquipmentModels),
    key = equipmentIconKey(equipment);
  const asset = key && context?.catalog.items[key];
  return asset ? (
    <AvailableEquipment
      asset={asset}
      instance={instance}
      fallback={fallback}
      presentation={presentation}
      projectile={projectile}
    />
  ) : (
    fallback
  );
}
function Preset({ value, children }: { value: EquipmentModelTransform; children: ReactNode }) {
  return (
    <group position={value.position} rotation={value.rotation} scale={value.scale}>
      {children}
    </group>
  );
}
function MountedEquipment({
  model,
  position,
  asset,
  anchor,
  leftGrip,
}: {
  model: Object3D;
  position: Position;
  asset: EquipmentModel;
  anchor: RefObject<WeaponAnchor | null>;
  leftGrip?: string;
}) {
  const grip = model.getObjectByName('ag1_hand_r') ?? model.getObjectByName('weapon');
  const otherGrip = leftGrip ? model.getObjectByName(leftGrip) : undefined;
  const otherHand = otherGrip && model.getObjectByName('weapon_hand_l');
  const scratch = useMemo<[Vector3, Vector3, Vector3, Matrix4]>(
    () => [new Vector3(), new Vector3(), new Vector3(), new Matrix4()],
    [],
  );
  const frame = useMemo(() => new Matrix4(), []);
  useLayoutEffect(() => {
    model.matrixAutoUpdate = false;
    model.visible = false;
  }, [model]);
  useFrame(() => {
    const rig = anchor.current;
    // The named equipment group is identity transformed. Its parent owns both
    // the character rig and the equipment, so resolve the bone in that frame.
    const actor = model.parent?.parent;
    model.visible = Boolean(rig && actor && nativeWeaponFrame(frame, actor, rig.weapon));
    if (!model.visible || !rig || !actor) return;
    if (grip && rig.right) fitWeaponGrip(frame, grip, model, actor, rig.right, scratch);
    model.matrix.copy(frame);
    model.matrixWorldNeedsUpdate = true;
    if (otherGrip && otherHand?.parent && rig.left) {
      const [target, middle, offset] = scratch;
      rig.left[0].getWorldPosition(target).lerp(rig.left[1].getWorldPosition(middle), 0.5);
      otherGrip.getWorldPosition(offset);
      otherHand.parent.worldToLocal(target);
      otherHand.parent.worldToLocal(offset);
      otherHand.position.add(target.sub(offset));
    }
  }, -1);
  return <EquipmentMuzzle asset={asset} position={position} model={model} />;
}

export function HeldEquipment({
  position,
  anchor,
  released,
}: {
  position: Position;
  anchor: RefObject<WeaponAnchor | null>;
  released?: boolean;
}) {
  const context = useContext(EquipmentModels);
  const key = equipmentIconKey(position.weapon);
  const asset = key && context?.catalog.items[key];
  if (!asset || !position.alive || released) return null;
  return (
    <group name={'held-equipment:' + position.id + ':' + key}>
      <EquipmentModelInstance
        equipment={position.weapon}
        instance={'held:' + position.id + ':' + key}
        presentation={(model) => (
          <MountedEquipment
            model={model}
            position={position}
            asset={asset}
            anchor={anchor}
            leftGrip={key === 'elite' ? 'ag1_hand_l' : key === 'molotov' ? 'lighter' : undefined}
          />
        )}
      />
    </group>
  );
}
/** Static eye-relative placement with a small analytical shot kick. Native
 * first-person arm/action animation is a separate asset capability. */
export function PovEquipment({ position }: { position: Position }) {
  const context = useContext(EquipmentModels),
    key = equipmentIconKey(position.weapon);
  const asset = key && context?.catalog.items[key];
  const fire = useEquipmentFire(position);
  const aspect = useThree(({ size }) => size.width / size.height);
  if (!asset || !position.alive) return null;
  return (
    <group rotation-y={Math.PI / 2} name={'pov-equipment:' + position.id + ':' + key}>
      <Preset value={fitPovAttachment(staticPovAttachment(asset.bounds), aspect)}>
        <group position-x={-(fire?.kick ?? 0) * 0.025} rotation-z={(fire?.kick ?? 0) * 0.035}>
          <EquipmentModelInstance
            equipment={position.weapon}
            instance={'pov:' + position.id + ':' + key}
            presentation={(model) => (
              <EquipmentMuzzle asset={asset} position={position} model={model} pov />
            )}
          />
        </group>
      </Preset>
    </group>
  );
}
export type PovEquipmentProps = {
  position: Position;
  next?: Position;
  previous?: PreviousPose;
  travelMeters?: number;
  alpha: number;
  timing?: PoseTiming;
};
function WorldEquipment({ item, floor }: { item: PresentItem; floor: SceneTrace | null }) {
  const context = useContext(EquipmentModels);
  const trace = useMemo(
    () => (item.kind !== 'projectile' ? floor?.fork(0) : undefined),
    [floor, item.kind],
  );
  const pose = itemPose(item);
  const id = equipmentIconKey(item.equipment);
  const bounds = id && context?.catalog.items[id]?.bounds;
  const rotation = new Euler(...(pose.rotation ?? [0, 0, 0]), 'YZX');
  if (bounds && item.kind !== 'projectile') {
    // Unknown angles default to a stable side. Airborne and angled samples
    // retain their recorded transform unless the support plane is nearby.
    if (!pose.rotation && item.kind === 'dropped') {
      const size = bounds.max.map((maximum, axis) => maximum - bounds.min[axis]);
      if (size[1] > size[0] && size[1] > size[2]) rotation.z = Math.PI / 2;
      else if (size[1] > size[2]) rotation.x = Math.PI / 2;
    }
    const support = new Box3(new Vector3(...bounds.min), new Vector3(...bounds.max)).applyMatrix4(
      new Matrix4().makeRotationFromEuler(rotation),
    );
    const [x, y, z] = pose.position;
    const bottom = y + support.min.y;
    const end: [number, number, number] = [x, bottom - 0.15, z];
    const contact = trace?.({ target: [x, bottom + 0.15, z], position: end });
    if (contact && contact !== end) pose.position[1] = contact[1] - support.min.y;
  }
  return (
    <group
      name={'recorded-item:' + item.id + ':' + item.kind + ':' + item.equipment}
      position={pose.position}
      rotation={rotation}
    >
      <EquipmentModelInstance
        equipment={item.equipment}
        instance={'item:' + item.id + ':' + item.equipment}
        fallback={item.kind === 'projectile' ? <ProjectileFallback /> : null}
        projectile={item.kind === 'projectile'}
      />
    </group>
  );
}

export function RecordedEquipment({
  items,
  floor,
}: {
  items: PresentItem[];
  floor: SceneTrace | null;
}) {
  return items.map((item) => <WorldEquipment key={item.id} item={item} floor={floor} />);
}
export function ProjectileFallback() {
  return (
    <mesh>
      <sphereGeometry args={[0.13, 8, 8]} />
      <meshBasicMaterial color="#e4b575" />
    </mesh>
  );
}
