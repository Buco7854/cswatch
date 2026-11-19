import { useMemo, type ReactNode } from 'react';
import { createPortal, useFrame } from '@react-three/fiber';
import { Scene } from 'three';
import { renderPovEquipment } from '../pov-render';

/** Dedicated first-person depth pass. Placement and lighting remain analytical;
 * this does not turn the static world model into native arms/action animation. */
export default function PovEquipmentPass({
  hasSky,
  sample,
  children,
}: {
  hasSky: boolean;
  sample: boolean;
  children: ReactNode;
}) {
  const equipment = useMemo(() => new Scene(), []);
  useFrame(({ gl, scene, camera }) => {
    // SkyPass (priority 1) already composes sky + world when present. Without
    // it, this callback takes ownership of the normal world render as well.
    renderPovEquipment(gl, scene, equipment, camera, hasSky);
  }, 2);
  return createPortal(
    <>
      <ambientLight intensity={sample ? 0.9 : 0.35} />
      <hemisphereLight args={['#e1ecf0', '#7c694b', sample ? 2 : 0.6]} />
      <directionalLight position={[-25, 40, 12]} intensity={sample ? 3.5 : 1.8} />
      {children}
    </>,
    equipment,
  );
}
