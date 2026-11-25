import { useContext, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import { createPortal, useFrame } from '@react-three/fiber';
import { PerspectiveCamera, Scene, Vector3, type DirectionalLight } from 'three';
import { NativePasses } from '../world/frame-context';
import { renderPovEquipment, updatePovCamera } from '../pov-render';
import { povFar, povNear } from '../pov-camera';
import SampleLighting from './SampleLighting';
import type { MapSun } from '../actor-sun';
import type { SceneTrace } from '../world/queries';

/** Dedicated first-person depth pass for both authored rigs and static equipment. */
export default function PovEquipmentPass({
  sample,
  sun,
  trace,
  children,
}: {
  sample: boolean;
  sun: MapSun | null;
  trace: SceneTrace | null;
  children: ReactNode;
}) {
  const native = useContext(NativePasses);
  const equipment = useMemo(() => new Scene(), []);
  const camera = useMemo(() => new PerspectiveCamera(50, 1, povNear, povFar), []);
  const directional = useRef<DirectionalLight>(null);
  const sunlight = useMemo(() => {
    if (!sun || !trace) return;
    const direction = new Vector3(...sun.position).sub(new Vector3(...sun.target)).normalize();
    if (direction.y <= 0) return;
    const reach = direction.multiplyScalar(sun.shadow.far);
    const cell = new Vector3(Infinity, Infinity, Infinity);
    const point = new Vector3();
    let exposure = 1;
    return (eye: Vector3) => {
      // A half-metre grid limits static triangle queries during moving playback.
      // Sample the fixed cell centre so a seek yields the same light.
      point.copy(eye).multiplyScalar(2).floor().addScalar(0.5).multiplyScalar(0.5);
      if (!cell.equals(point)) {
        cell.copy(point);
        const target = point.toArray();
        const position = point.add(reach).toArray();
        exposure = trace({ target, position }) === position ? 1 : 0.22;
      }
      return exposure;
    };
  }, [sun, trace]);
  const draw = useRef<NonNullable<NonNullable<typeof native>['equipment']>>(() => {});
  useLayoutEffect(() => {
    if (!native) return;
    native.equipment = (render) => draw.current(render);
    return () => {
      delete native.equipment;
    };
  }, [native]);
  useFrame(({ gl, scene, camera: worldCamera, size }) => {
    // SkyPass (priority 1) already composes sky + world when present. Without
    // it, this callback takes ownership of the normal world render as well.
    updatePovCamera(worldCamera, camera, size.width / size.height);
    if (native) {
      draw.current = (render) => {
        const sun = native.sun;
        if (sun && directional.current) {
          directional.current.color.copy(sun.color);
          directional.current.position.copy(sun.position);
          directional.current.intensity = sun.intensity;
        }
        render(equipment, camera);
      };
      return;
    }
    const exposure = sunlight?.(camera.position) ?? 1;
    if (directional.current) directional.current.intensity = (sample ? 3.5 : 1.8) * exposure;
    renderPovEquipment(gl, scene, equipment, worldCamera, camera, 0.72 + 0.28 * exposure);
  }, 2);
  return createPortal(
    <>
      {native ? (
        <directionalLight ref={directional} />
      ) : (
        <SampleLighting directionalRef={directional} />
      )}
      {children}
    </>,
    equipment,
  );
}
