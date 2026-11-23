import { useContext, useLayoutEffect, useMemo, useRef, type RefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Color, Object3D, type DirectionalLight } from 'three';
import { mapGradeBurstLights, MapGradeContext, mapGradeExposureGain } from '../map-grade';
import { applySunShadow, type MapSun } from '../map-sun';

const fallbackShadow = { left: -45, right: 45, bottom: -45, top: 45, near: 0.5, far: 500 };
const up: [number, number, number] = [0, 1, 0];

/** Shared lighting for the world, landscape and independent viewmodel scene. */
export default function SceneLighting({
  sample,
  sun,
  skylight,
  fallbackSun = false,
  shadows = false,
  directionalRef,
}: {
  sample: boolean;
  sun: MapSun | null;
  skylight: boolean;
  fallbackSun?: boolean;
  shadows?: boolean;
  directionalRef?: RefObject<DirectionalLight | null>;
}) {
  const internalRef = useRef<DirectionalLight>(null),
    ref = directionalRef ?? internalRef,
    authored = useContext(MapGradeContext),
    lighting = authored?.lighting,
    target = useMemo(() => new Object3D(), []),
    color = useMemo(() => {
      if (sun && lighting) {
        // T3 changes directional intensity to shade the weapon. Three's
        // Lambert convention belongs in the authored color conversion.
        return new Color().fromArray(lighting.sun).multiplyScalar(Math.PI / 1.8);
      }
      return sun ? new Color().fromArray(sun.color) : new Color('#ffffff');
    }, [sun, lighting]),
    skyColor = useMemo(
      () => (lighting ? new Color().fromArray(lighting.sky) : '#e1ecf0'),
      [lighting],
    ),
    { scene, invalidate } = useThree();
  const ambientIntensity = sample ? 0.9 : lighting ? 0 : skylight ? 0.08 : 0.35;
  const directionalIntensity = sample ? 3.5 : sun || fallbackSun ? 1.8 : 0;
  const hemisphereIntensity = sample
    ? 2
    : skylight
      ? lighting
        ? 0
        : 0.12
      : lighting
        ? Math.PI
        : 0.6;
  const headroom = Math.max(1, mapGradeExposureGain(authored) * 1.35);
  useLayoutEffect(() => invalidate(), [headroom, invalidate]);
  // Apply the recorded light on the same frame, before the world draws. Grade
  // arrival must not replace the scene's static shadow invalidation callback.
  useFrame(() => {
    const burst = mapGradeBurstLights.get(scene);
    if (burst) burst.light.intensity = burst.intensity() / headroom;
  }, -1);
  useLayoutEffect(() => {
    target.position.set(...(sun?.target || [0, 0, 0]));
    target.updateMatrixWorld(true);
    if (ref.current) applySunShadow(ref.current, sun?.shadow || fallbackShadow, sun?.up || up);
    invalidate();
  }, [sun, target, ref, invalidate]);
  return (
    <>
      <primitive object={target} />
      <ambientLight intensity={ambientIntensity} />
      <hemisphereLight args={[skyColor, lighting ? '#000000' : '#7c694b', hemisphereIntensity]} />
      <directionalLight
        ref={ref}
        target={target}
        color={color}
        position={sun?.position || [-25, 40, 12]}
        intensity={directionalIntensity}
        castShadow={shadows && directionalIntensity > 0}
        shadow-mapSize={[2048, 2048]}
        shadow-normalBias={0.04}
      />
    </>
  );
}
