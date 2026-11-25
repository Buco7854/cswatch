import { type RefObject } from 'react';
import type { DirectionalLight } from 'three';

/** Fixed daylight for the synthetic training courtyard and its first-person rig. */
export default function SampleLighting({
  directionalRef,
}: {
  directionalRef?: RefObject<DirectionalLight | null>;
}) {
  return (
    <>
      <ambientLight intensity={0.9} />
      <hemisphereLight args={['#e1ecf0', '#7c694b', 2]} />
      <directionalLight ref={directionalRef} position={[-25, 40, 12]} intensity={3.5} />
    </>
  );
}
