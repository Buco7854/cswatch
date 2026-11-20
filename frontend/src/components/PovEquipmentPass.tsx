import { useMemo, type ReactNode } from 'react';
import { createPortal, useFrame } from '@react-three/fiber';
import { Scene } from 'three';
import { renderPovEquipment } from '../pov-render';
import SceneLighting from './SceneLighting';
import type { MapSun } from '../map-sun';

/** Dedicated first-person depth pass for both authored rigs and static equipment. */
export default function PovEquipmentPass({
  hasSky,
  sample,
  sun,
  skylight,
  children,
}: {
  hasSky: boolean;
  sample: boolean;
  sun: MapSun | null;
  skylight: boolean;
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
      <SceneLighting sample={sample} sun={sun} skylight={skylight} />
      {children}
    </>,
    equipment,
  );
}
