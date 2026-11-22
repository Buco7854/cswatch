import {
  createContext,
  useContext,
  useMemo,
  useRef,
  useEffect,
  useLayoutEffect,
  type ReactNode,
} from 'react';
import { useFrame } from '@react-three/fiber';
import { Matrix4, Vector3, type Group, type Object3D } from 'three';
import type { EquipmentModel } from '../../../shared/equipment-models';
import type { Playback, Position } from '../types';
import {
  indexWeaponFire,
  nativeWeaponPose,
  weaponFireAt,
  type WeaponFireIndex,
} from '../weapon-fire';
import { nativeMuzzleFrame } from '../equipment-model';
import { createMuzzleResources } from '../muzzle-resources';
import { useReducedMotion } from '../reduced-motion';

type Muzzle = { read: (out: Vector3) => boolean };
type FireContext = {
  muzzles: Map<string, Muzzle> | undefined;
  index: WeaponFireIndex;
  tick: number;
  rate: number;
  low: boolean;
  enabled: boolean;
  reducedMotion: boolean;
};
const Context = createContext<FireContext | null>(null);

export default function EquipmentFire({
  data,
  tick,
  low,
  enabled = true,
  tracers = false,
  children,
}: {
  data: Playback;
  tick: number;
  low: boolean;
  enabled?: boolean;
  tracers?: boolean;
  children: ReactNode;
}) {
  const index = useMemo(() => indexWeaponFire(data), [data.events, data.players, data.sample]);
  const reducedMotion = useReducedMotion();
  const muzzles = useMemo(
    () => (tracers && !reducedMotion ? new Map<string, Muzzle>() : undefined),
    [tracers, reducedMotion],
  );
  const value = useMemo(
    () => ({ index, tick, rate: data.tickRate, low, enabled, reducedMotion, muzzles }),
    [index, tick, data.tickRate, low, enabled, reducedMotion, muzzles],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useTracerEvidence() {
  return useContext(Context);
}

export function useEquipmentFire(position: Position) {
  const context = useContext(Context);
  return context?.enabled
    ? weaponFireAt(context.index, position, context.tick, context.rate, context.reducedMotion)
    : undefined;
}

export function useNativeWeaponPose(
  position: Position,
  fireDuration: number,
  reloadDuration: number,
) {
  const context = useContext(Context);
  if (!context || context.reducedMotion) return {};
  return nativeWeaponPose(
    context.index,
    position,
    context.tick,
    context.rate,
    fireDuration,
    reloadDuration,
    context.enabled,
  );
}

/** Depth-tested analytical fire geometry. An admitted native muzzle
 * frame supplies the anchor. Missing attachment data uses the model bounds. */
export function EquipmentMuzzle({
  asset,
  position,
  model,
  pov = false,
}: {
  asset?: EquipmentModel;
  position: Position;
  model: Object3D;
  pov?: boolean;
}) {
  const context = useContext(Context),
    fire = useEquipmentFire(position),
    flash = fire?.flash || 0;
  const origin = useMemo<[number, number, number] | undefined>(
    () =>
      asset && [
        asset.bounds.max[0] + 0.015,
        (asset.bounds.max[1] + asset.bounds.min[1]) / 2,
        (asset.bounds.max[2] + asset.bounds.min[2]) / 2,
      ],
    [asset],
  );
  const transform = useRef<Group>(null),
    marker = useMemo(() => {
      const node = model.getObjectByName('cswatch_native_muzzle');
      return node?.userData.cswatchNativeAttachment === 'muzzle_flash' ? node : undefined;
    }, [model]),
    matrix = useMemo(() => new Matrix4(), []);
  const muzzles = context?.muzzles;
  useLayoutEffect(() => {
    if (!muzzles || (!marker && !origin)) return;
    const muzzle: Muzzle = {
      read: (out) => {
        if (marker && nativeMuzzleFrame(matrix, model, marker)) {
          out.setFromMatrixPosition(marker.matrixWorld);
          return true;
        }
        if (!origin) return false;
        out.fromArray(origin);
        model.localToWorld(out);
        return true;
      },
    };
    muzzles.set(position.id, muzzle);
    return () => {
      if (muzzles.get(position.id) === muzzle) muzzles.delete(position.id);
    };
  }, [marker, matrix, model, muzzles, origin, position.id]);
  const resources = useMemo(createMuzzleResources, []);
  useEffect(() => resources.acquire(), [resources]);
  useLayoutEffect(() => {
    resources.outer.uniforms.strength.value = flash;
    resources.outer.uniforms.variant.value = fire ? fire.tick % 11 : 0;
    resources.inner.opacity = flash;
  }, [resources, flash, fire?.tick]);
  useFrame(() => {
    // The flash and optional light have no output while idle. Keep the light
    // mounted for the shader layout, and resolve the anchor only during a shot.
    if (!transform.current || flash <= 0) return;
    const anchored = nativeMuzzleFrame(matrix, model, marker);
    transform.current.visible = anchored || Boolean(origin);
    if (!anchored && origin) matrix.makeTranslation(...origin);
    transform.current.matrix.copy(matrix);
    transform.current.matrixWorldNeedsUpdate = true;
  });
  if (!marker && !origin) return null;
  // The light stays mounted at zero intensity between shots so shooting does
  // not continually change the scene's shader light count. Only one watched
  // POV gets a local light; low quality keeps visible flash geometry only.
  return (
    <group
      ref={transform}
      matrixAutoUpdate={false}
      name={(marker ? 'native-muzzle:' : 'analytical-muzzle:') + position.id}
    >
      <group visible={flash > 0} rotation={[fire ? ((fire.tick % 7) * Math.PI) / 7 : 0, 0, 0]}>
        <mesh
          geometry={resources.flame}
          material={resources.outer}
          position={[0.035, 0, 0]}
          rotation={[0, Math.PI / 2, 0]}
          dispose={null}
        />
        <mesh
          geometry={resources.core}
          material={resources.inner}
          scale={[0.095, 0.025, 0.025]}
          position={[0.04, 0, 0]}
          dispose={null}
        />
      </group>
      {pov && !context?.low && (
        <pointLight color="#ffc173" intensity={flash * 1.6} distance={1.6} decay={2} />
      )}
    </group>
  );
}
