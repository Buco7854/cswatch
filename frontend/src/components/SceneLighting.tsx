import { useLayoutEffect, useMemo, useRef, type RefObject } from 'react';
import { useThree } from '@react-three/fiber';
import { Color, Object3D, type DirectionalLight } from 'three';
import { applySunShadow, type MapSun } from '../map-sun';

const fallbackShadow = { left: -45, right: 45, bottom: -45, top: 45, near: 0.5, far: 500 };
const up: [number, number, number] = [0, 1, 0];

/** Shared world/landscape/viewmodel illumination. Native energy and local
 * probes are unavailable, so exposure and the low fill remain approximations. */
export default function SceneLighting({
  sample,
  sun,
  skylight,
  shadows = false,
  directionalRef,
}: {
  sample: boolean;
  sun: MapSun | null;
  skylight: boolean;
  shadows?: boolean;
  directionalRef?: RefObject<DirectionalLight | null>;
}) {
  const internalRef = useRef<DirectionalLight>(null),
    ref = directionalRef ?? internalRef,
    target = useMemo(() => new Object3D(), []),
    color = useMemo(() => (sun ? new Color().fromArray(sun.color) : new Color('#ffffff')), [sun]),
    { invalidate } = useThree();
  useLayoutEffect(() => {
    target.position.set(...(sun?.target || [0, 0, 0]));
    target.updateMatrixWorld(true);
    if (ref.current) applySunShadow(ref.current, sun?.shadow || fallbackShadow, sun?.up || up);
    invalidate();
  }, [sun, target, invalidate, ref]);
  return (
    <>
      <primitive object={target} />
      <ambientLight intensity={sample ? 0.9 : skylight ? 0.08 : 0.35} />
      <hemisphereLight args={['#e1ecf0', '#7c694b', sample ? 2 : skylight ? 0.12 : 0.6]} />
      <directionalLight
        ref={ref}
        target={target}
        color={color}
        position={sun?.position || [-25, 40, 12]}
        intensity={sample ? 3.5 : 1.8}
        castShadow={shadows}
        shadow-mapSize={[2048, 2048]}
        shadow-normalBias={0.04}
      />
    </>
  );
}
