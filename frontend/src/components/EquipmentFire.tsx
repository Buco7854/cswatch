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
import { Matrix4, type Group, type Object3D } from 'three';
import type { EquipmentModel } from '../../../shared/equipment-models';
import type { Playback, Position } from '../types';
import { indexWeaponFire, weaponFireAt, type WeaponFireIndex } from '../weapon-fire';
import { nativeMuzzleFrame } from '../equipment-model';
import { createMuzzleResources } from '../muzzle-resources';
import { useReducedMotion } from '../reduced-motion';

type FireContext = {
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
  children,
}: {
  data: Playback;
  tick: number;
  low: boolean;
  enabled?: boolean;
  children: ReactNode;
}) {
  const index = useMemo(() => indexWeaponFire(data), [data.events, data.players, data.sample]);
  const reducedMotion = useReducedMotion();
  const value = useMemo(
    () => ({ index, tick, rate: data.tickRate, low, enabled, reducedMotion }),
    [index, tick, data.tickRate, low, enabled, reducedMotion],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useEquipmentFire(position: Position) {
  const context = useContext(Context);
  return context?.enabled
    ? weaponFireAt(context.index, position, context.tick, context.rate, context.reducedMotion)
    : undefined;
}

/** Depth-tested analytical fire geometry. New prepared models carry their native
 * muzzle frame; older models explicitly retain an approximate bounds fallback. */
export function EquipmentMuzzle({
  asset,
  position,
  model,
  pov = false,
}: {
  asset: EquipmentModel;
  position: Position;
  model: Object3D;
  pov?: boolean;
}) {
  const context = useContext(Context),
    fire = useEquipmentFire(position),
    flash = fire?.flash || 0;
  const origin = useMemo<[number, number, number]>(
    () => [
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
  const resources = useMemo(createMuzzleResources, []);
  useEffect(() => resources.acquire(), [resources]);
  useLayoutEffect(() => {
    resources.outer.uniforms.strength.value = flash;
    resources.outer.uniforms.variant.value = fire ? fire.tick % 11 : 0;
    resources.inner.opacity = flash;
  }, [resources, flash, fire?.tick]);
  useFrame(() => {
    if (!transform.current) return;
    if (!nativeMuzzleFrame(matrix, model, marker)) matrix.makeTranslation(...origin);
    transform.current.matrix.copy(matrix);
    transform.current.matrixWorldNeedsUpdate = true;
  });
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
