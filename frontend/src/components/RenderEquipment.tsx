import {
  Component,
  Suspense,
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  type ReactNode,
} from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Group, MathUtils } from 'three';
import {
  prepareEquipmentModel,
  disposeEquipmentInstance,
  fitPovAttachment,
} from '../equipment-model';
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
}: {
  asset: EquipmentModel;
  scope: ModelScope;
  ready: () => void;
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
  return <primitive object={model} dispose={null} />;
}
function AvailableEquipment({
  asset,
  instance,
  fallback,
}: {
  asset: EquipmentModel;
  instance: string;
  fallback: ReactNode;
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
        <LoadedEquipment asset={asset} scope={scope} ready={callbacks.ready} />
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
}: {
  equipment: string;
  instance: string;
  fallback?: ReactNode;
}) {
  const context = useContext(EquipmentModels),
    key = equipmentIconKey(equipment);
  const asset = key && context?.catalog.items[key];
  return asset ? (
    <AvailableEquipment asset={asset} instance={instance} fallback={fallback} />
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
export function HeldEquipment({ position }: { position: Position }) {
  const context = useContext(EquipmentModels),
    key = equipmentIconKey(position.weapon);
  const asset = key && context?.catalog.items[key];
  if (!asset || !position.alive) return null;
  return (
    <group
      name={'held-equipment:' + position.id + ':' + key}
      position={[
        asset.attachments.hold.position[0],
        asset.attachments.hold.position[1] - (position.duck ?? 0) * 0.7,
        asset.attachments.hold.position[2],
      ]}
    >
      <group rotation={[0, 0, -MathUtils.degToRad(position.pitch)]}>
        <group rotation={asset.attachments.hold.rotation} scale={asset.attachments.hold.scale}>
          <EquipmentModelInstance
            equipment={position.weapon}
            instance={'held:' + position.id + ':' + key}
          />
        </group>
      </group>
    </group>
  );
}
/** A static model uses an explicit approximate eye-relative preset, without invented arm/recoil animation. */
export function PovEquipment({
  position,
  next,
  alpha,
}: {
  position: Position;
  next?: Position;
  alpha: number;
}) {
  const context = useContext(EquipmentModels),
    key = equipmentIconKey(position.weapon);
  const asset = key && context?.catalog.items[key];
  const { size } = useThree();
  const preset = useMemo(
    () => (asset ? fitPovAttachment(asset.attachments.pov, size.width / size.height) : null),
    [asset, size.width, size.height],
  );
  const root = useMemo(() => new Group(), []);
  useFrame(() => {
    const to = next && next.alive === position.alive ? next : position;
    root.position.set(
      (position.x + (to.x - position.x) * alpha) * 0.0254,
      (position.z + (to.z - position.z) * alpha) * 0.0254 + 1.65 - (position.duck ?? 0) * 0.7,
      -(position.y + (to.y - position.y) * alpha) * 0.0254,
    );
    root.rotation.set(
      0,
      MathUtils.degToRad(position.yaw),
      -MathUtils.degToRad(position.pitch),
      'YZX',
    );
  });
  if (!asset || !preset || !position.alive) return null;
  return (
    <primitive object={root} dispose={null} name={'pov-equipment:' + position.id + ':' + key}>
      <Preset value={preset}>
        <EquipmentModelInstance
          equipment={position.weapon}
          instance={'pov:' + position.id + ':' + key}
        />
      </Preset>
    </primitive>
  );
}
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
