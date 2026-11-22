import { useLayoutEffect, useMemo, useRef, type RefObject } from 'react';
import { useThree } from '@react-three/fiber';
import {
  Color,
  Object3D,
  type AmbientLight,
  type DirectionalLight,
  type HemisphereLight,
} from 'three';
import { mapGradeLighting } from '../map-grade';
import { applySunShadow, type MapSun } from '../map-sun';

const fallbackShadow = { left: -45, right: 45, bottom: -45, top: 45, near: 0.5, far: 500 };
const up: [number, number, number] = [0, 1, 0];

/** Shared lighting for the world, landscape and independent viewmodel scene. */
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
    ambient = useRef<AmbientLight>(null),
    hemisphere = useRef<HemisphereLight>(null),
    target = useMemo(() => new Object3D(), []),
    color = useMemo(() => (sun ? new Color().fromArray(sun.color) : new Color('#ffffff')), [sun]),
    { scene, invalidate } = useThree();
  const ambientIntensity = sample ? 0.9 : skylight ? 0.08 : 0.35;
  const hemisphereIntensity = sample ? 2 : skylight ? 0.12 : 0.6;
  useLayoutEffect(() => {
    const original = scene.onBeforeRender;
    let authored = false;
    const restore = () => {
      if (!authored || !ref.current || !ambient.current || !hemisphere.current) return;
      ref.current.color.copy(color);
      ambient.current.intensity = ambientIntensity;
      hemisphere.current.intensity = hemisphereIntensity;
      hemisphere.current.color.set('#e1ecf0');
      hemisphere.current.groundColor.set('#7c694b');
      authored = false;
    };
    scene.onBeforeRender = function (...args) {
      original.apply(this, args);
      const target = args[0].getRenderTarget();
      const lighting = !sample && target ? mapGradeLighting.get(target) : undefined;
      if (!lighting) {
        restore();
        return;
      }
      if (!ref.current || !ambient.current || !hemisphere.current) return;
      if (sun) {
        // Three divides direct diffuse by pi. Keep the public intensity on the
        // DirectionalLight so another pass can attenuate it independently.
        ref.current.color.fromArray(lighting.sun).multiplyScalar(Math.PI / 1.8);
      }
      ambient.current.intensity = 0;
      hemisphere.current.color.fromArray(lighting.sky);
      hemisphere.current.groundColor.setRGB(0, 0, 0);
      // The filtered scene sky already supplies broad diffuse and reflection.
      hemisphere.current.intensity = skylight ? 0 : Math.PI;
      authored = true;
    };
    return () => {
      scene.onBeforeRender = original;
      restore();
    };
  }, [scene, ref, color, sample, sun, skylight, ambientIntensity, hemisphereIntensity]);
  useLayoutEffect(() => {
    target.position.set(...(sun?.target || [0, 0, 0]));
    target.updateMatrixWorld(true);
    if (ref.current) applySunShadow(ref.current, sun?.shadow || fallbackShadow, sun?.up || up);
    invalidate();
  }, [sun, target, ref, invalidate]);
  return (
    <>
      <primitive object={target} />
      <ambientLight ref={ambient} intensity={ambientIntensity} />
      <hemisphereLight ref={hemisphere} args={['#e1ecf0', '#7c694b', hemisphereIntensity]} />
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
