import { useFrame } from '@react-three/fiber';
import { useRef, type RefObject } from 'react';
import { Group, Mesh, Vector3 } from 'three';
import type { MapSun } from '../actor-sun';
import type { playerShadows } from '../player-shadows';
import type { FollowCamera } from '../follow-camera';

export function PlayerSunPass({
  root,
  pipeline,
  sun,
}: {
  root: RefObject<Group | null>;
  pipeline: ReturnType<typeof playerShadows>;
  sun: MapSun | null;
}) {
  useFrame(({ gl, camera }) => {
    if (sun && root.current?.visible) pipeline.render(gl, root.current, sun, camera);
    else pipeline.disable();
  }, 0);
  return null;
}

export function PlayerContactShadow({
  body,
  trace,
}: {
  body: RefObject<Group | null>;
  trace: ((ray: Pick<FollowCamera, 'target' | 'position'>) => FollowCamera['position']) | null;
}) {
  const mesh = useRef<Mesh>(null);
  const world = useRef(new Vector3());
  useFrame(({ camera }) => {
    const node = mesh.current;
    if (!node || !body.current) return;
    const p = body.current.getWorldPosition(world.current);
    node.visible = false;
    if (!trace || p.distanceToSquared(camera.position) > 36 ** 2) return;
    const end: FollowCamera['position'] = [p.x, p.y - 0.22, p.z];
    const floor = trace({ target: [p.x, p.y + 0.14, p.z], position: end });
    if (floor === end || Math.abs(floor[1] - p.y) > 0.15) return;
    node.visible = true;
    node.position.y = floor[1] - p.y + 0.012;
  }, -1);
  return (
    <mesh ref={mesh} rotation={[-Math.PI / 2, 0, 0]} visible={false}>
      <planeGeometry args={[0.95, 0.68]} />
      <shaderMaterial
        transparent
        depthWrite={false}
        polygonOffset
        polygonOffsetFactor={-1}
        vertexShader={`
          varying vec2 contactUV;
          void main() {
            contactUV = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`}
        fragmentShader={`
          varying vec2 contactUV;
          void main() {
            float distanceFromFeet = length(contactUV * 2.0 - 1.0);
            gl_FragColor = vec4(0.0, 0.0, 0.0, 0.38 * (1.0 - smoothstep(0.16, 1.0, distanceFromFeet)));
          }`}
      />
    </mesh>
  );
}
