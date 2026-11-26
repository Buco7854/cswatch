import { useContext, useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  Vector3,
} from 'three';
import { ReplayFrameContext } from '../replay-frames';
import { activeBodyHits, bodyHitPoint, recordedAim } from '../body-hits';
import { agentRoot } from '../agent-roots';
import type { Playback } from '../types';

const hitsLimit = 8,
  droplets = 22,
  puffs = 6,
  perHit = droplets + puffs,
  capacity = hitsLimit * perHit;

/** Deterministic per-particle random numbers in [0, 1). */
function random(seed: number, index: number) {
  let value = (seed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x85ebca6b) >>> 0;
  value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35) >>> 0;
  return ((value ^ (value >>> 16)) >>> 0) / 4294967296;
}

const vertex = /* glsl */ `
attribute vec3 iCenter;
attribute vec2 iShape;
varying vec2 vUv;
varying float vAlpha;
varying float vMist;
void main() {
  vUv = uv;
  vAlpha = iShape.y;
  vMist = step(0.5, fract(iShape.x * 0.5) * 2.0);
  vec4 view = viewMatrix * vec4(iCenter, 1.0);
  view.xy += position.xy * floor(iShape.x * 0.5) * 0.001;
  gl_Position = projectionMatrix * view;
}`;
const fragment = /* glsl */ `
varying vec2 vUv;
varying float vAlpha;
varying float vMist;
void main() {
  float d = length(vUv - 0.5) * 2.0;
  float edge = vMist > 0.5 ? 1.0 - smoothstep(0.0, 1.0, d) : 1.0 - smoothstep(0.7, 1.0, d);
  float alpha = vAlpha * edge;
  if (alpha < 0.01) discard;
  vec3 color = vMist > 0.5 ? vec3(0.16, 0.012, 0.01) : vec3(0.09, 0.004, 0.003);
  gl_FragColor = vec4(color, alpha);
}`;

/** Blood at recorded bullet hits on players: a spray of droplets thrown along the shot
 * and a short mist, at the point where the attacker's recorded aim meets the victim's
 * posed body part for the recorded hitgroup. Reduced motion shows none. */
export default function BodyHits({ data, tick }: { data: Playback; tick: number }) {
  const replay = useContext(ReplayFrameContext);
  const { mesh, centers, shapes } = useMemo(() => {
    const quad = new PlaneGeometry(1, 1);
    const geometry = new InstancedBufferGeometry();
    geometry.index = quad.index;
    geometry.setAttribute('position', quad.getAttribute('position'));
    geometry.setAttribute('uv', quad.getAttribute('uv'));
    const centers = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    const shapes = new InstancedBufferAttribute(new Float32Array(capacity * 2), 2);
    centers.setUsage(35048);
    shapes.setUsage(35048);
    geometry.setAttribute('iCenter', centers);
    geometry.setAttribute('iShape', shapes);
    geometry.instanceCount = 0;
    const material = new ShaderMaterial({
      vertexShader: vertex,
      fragmentShader: fragment,
      transparent: true,
      depthWrite: false,
    });
    const mesh = new Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.name = 'recorded-body-hits';
    return { mesh, centers, shapes };
  }, []);
  useEffect(
    () => () => {
      mesh.geometry.dispose();
      (mesh.material as ShaderMaterial).dispose();
    },
    [mesh],
  );
  const point = useMemo(() => new Vector3(), []),
    velocity = useMemo(() => new Vector3(), []),
    side = useMemo(() => new Vector3(), []),
    up = useMemo(() => new Vector3(), []);
  useFrame(() => {
    const now = replay?.tick ?? tick;
    let count = 0;
    for (const hit of activeBodyHits(data, now, 1.2, hitsLimit)) {
      const age = (now - hit.tick) / data.tickRate;
      const root = agentRoot(hit.victim) ?? agentRoot('death:' + hit.victim);
      const aim = hit.attacker ? recordedAim(data, hit.attacker, hit.tick) : undefined;
      if (age < 0 || !root || !aim || !bodyHitPoint(root, hit, aim, point)) continue;
      const direction = aim.direction.normalize();
      side.set(-direction.z, 0, direction.x).normalize();
      up.crossVectors(side, direction).normalize();
      const head = hit.hitgroup === 'head';
      for (let i = 0; i < perHit; i++) {
        const mist = i >= droplets;
        const life = mist
          ? 0.45 + random(hit.seed, i * 7) * 0.3
          : 0.7 + random(hit.seed, i * 7) * 0.4;
        if (age > life) continue;
        // Droplets leave with the bullet in a cone and fall; the mist hangs and spreads.
        const speed = mist
          ? 0.25 + random(hit.seed, i * 7 + 1) * 0.35
          : 1.2 + random(hit.seed, i * 7 + 1) * (head ? 3.4 : 2.4);
        const spread = mist ? 0.9 : 0.55;
        velocity
          .copy(direction)
          .addScaledVector(side, (random(hit.seed, i * 7 + 2) - 0.5) * 2 * spread)
          .addScaledVector(up, (random(hit.seed, i * 7 + 3) - 0.35) * 2 * spread)
          .normalize()
          .multiplyScalar(speed);
        const gravity = mist ? 0.6 : 9.81;
        const x = point.x + velocity.x * age,
          y = point.y + velocity.y * age - 0.5 * gravity * age * age,
          z = point.z + velocity.z * age;
        const fade = 1 - age / life;
        const size = mist
          ? (0.05 + age * 0.45) * (head ? 1.4 : 1)
          : 0.012 + random(hit.seed, i * 7 + 4) * 0.016;
        centers.setXYZ(count, x, y, z);
        // Size (millimetres) and kind share one float: even = droplet, odd = mist.
        shapes.setXY(
          count,
          Math.round(size * 1000) * 2 + (mist ? 1 : 0),
          (mist ? 0.55 : 0.95) * fade,
        );
        count++;
      }
    }
    // Stays visible with zero instances, so the compositor links its program when the
    // scene mounts rather than at the first recorded hit during playback.
    (mesh.geometry as InstancedBufferGeometry).instanceCount = count;
    if (count) {
      centers.needsUpdate = true;
      shapes.needsUpdate = true;
    }
  }, -1);
  return <primitive object={mesh} />;
}
