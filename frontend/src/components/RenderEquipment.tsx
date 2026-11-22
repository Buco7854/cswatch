import {
  Component,
  Suspense,
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type RefObject,
  type ReactNode,
} from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Group, MathUtils, Matrix4, type Object3D } from 'three';
import type { PoseTiming } from '../player-pose';
import type { PreviousPose } from '../recorded-motion';
import { fitPovAttachment } from '../pov-camera';
import { nativeWeaponFrame } from '../agent-attachment';
import { prepareEquipmentModel, disposeEquipmentInstance } from '../equipment-model';
import type {
  EquipmentModel,
  EquipmentModelCatalog,
  EquipmentModelTransform,
} from '../../../shared/equipment-models';
import type { Position } from '../types';
import type { PresentItem } from '../item-state';
import { itemPose } from '../item-state';
import { equipmentIconKey } from '../equipment-icons';
import { useEquipmentGLTF, useEquipmentScope } from '../equipment-loader';
import type { ModelScope } from '../model-cache';
import { assertMapBaseColorTextures } from '../map-model';
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
}: {
  asset: EquipmentModel;
  scope: ModelScope;
  ready: () => void;
  presentation?: (model: Object3D) => ReactNode;
}) {
  const gltf = useEquipmentGLTF(asset.model);
  const { invalidate } = useThree();
  useLayoutEffect(() => scope.acquire(), [scope]);
  const model = useMemo(() => {
    const instance = prepareEquipmentModel(gltf.scene);
    assertMapBaseColorTextures({ scene: instance, parser: gltf.parser });
    return instance;
  }, [gltf]);
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
}: {
  asset: EquipmentModel;
  instance: string;
  fallback: ReactNode;
  presentation?: (model: Object3D) => ReactNode;
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
      <Suspense fallback={<PendingEquipment instance={instance}>{fallback}</PendingEquipment>}>
        <LoadedEquipment
          asset={asset}
          scope={scope}
          ready={callbacks.ready}
          presentation={presentation}
        />
      </Suspense>
    </EquipmentBoundary>
  );
}
function PendingEquipment({ instance, children }: { instance: string; children: ReactNode }) {
  const context = useContext(EquipmentModels)!;
  useLayoutEffect(() => context.report(instance, 'pending'), [context.report, instance]);
  return children;
}
export function EquipmentModelInstance({
  equipment,
  instance,
  fallback = null,
  presentation,
}: {
  equipment: string;
  instance: string;
  fallback?: ReactNode;
  presentation?: (model: Object3D) => ReactNode;
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
export function HeldEquipment({
  position,
  anchor,
  posedByAgent,
}: {
  position: Position;
  anchor?: RefObject<Object3D | null>;
  posedByAgent?: RefObject<boolean>;
}) {
  const context = useContext(EquipmentModels),
    key = equipmentIconKey(position.weapon);
  const asset = key && context?.catalog.items[key];
  const fire = useEquipmentFire(position);
  const transform = useRef<Group>(null),
    pitch = useRef<Group>(null),
    recoil = useRef<Group>(null),
    matrix = useMemo(() => new Matrix4(), []);
  useFrame(() => {
    const node = transform.current;
    if (!node || !asset || !node.parent) return;
    if (!nativeWeaponFrame(matrix, node.parent, anchor?.current || null)) {
      const [x, y, z] = asset.attachments.hold.position;
      matrix.makeTranslation(x, y - (position.duck ?? 0) * 0.7, z);
    }
    const rigid = posedByAgent?.current && anchor?.current;
    if (pitch.current) pitch.current.rotation.z = rigid ? 0 : -MathUtils.degToRad(position.pitch);
    if (recoil.current) {
      const kick = rigid ? 0 : fire?.kick || 0;
      recoil.current.position.x = -kick * 0.025;
      recoil.current.rotation.z = kick * 0.035;
    }
    node.matrix.copy(matrix);
    node.matrixWorldNeedsUpdate = true;
  }, -1);
  if (!asset || !position.alive) return null;
  return (
    <group
      ref={transform}
      matrixAutoUpdate={false}
      name={'held-equipment:' + position.id + ':' + key}
    >
      <group ref={pitch}>
        <group rotation={asset.attachments.hold.rotation} scale={asset.attachments.hold.scale}>
          <group ref={recoil}>
            <EquipmentModelInstance
              equipment={position.weapon}
              instance={'held:' + position.id + ':' + key}
              presentation={(model) => (
                <EquipmentMuzzle asset={asset} position={position} model={model} />
              )}
            />
          </group>
        </group>
      </group>
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
      <Preset value={fitPovAttachment(asset.attachments.pov, aspect)}>
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
export function RecordedEquipment({ items }: { items: PresentItem[] }) {
  return (
    <>
      {items.map((item) => {
        const pose = itemPose(item);
        return (
          <group
            key={item.id}
            name={'recorded-item:' + item.id + ':' + item.kind + ':' + item.equipment}
            position={pose.position}
            rotation={pose.rotation ? [...pose.rotation, 'YZX'] : undefined}
          >
            <EquipmentModelInstance
              equipment={item.equipment}
              instance={'item:' + item.id + ':' + item.equipment}
              fallback={item.kind === 'projectile' ? <ProjectileFallback /> : null}
            />
          </group>
        );
      })}
    </>
  );
}
export function ProjectileFallback() {
  return (
    <mesh>
      <sphereGeometry args={[0.13, 8, 8]} />
      <meshBasicMaterial color="#e4b575" />
    </mesh>
  );
}
