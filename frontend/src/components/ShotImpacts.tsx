import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import {
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
} from 'three';
import { frameAt, poseTimingAt } from '../playback';
import { playerPose } from '../player-pose';
import { firstPersonView } from '../pov-camera';
import { createShotRayCache } from '../shot-tracer';
import {
  impactLifetime,
  impactReach,
  impactSprites,
  impactSurface,
  maxImpacts,
  spritesPerImpact,
  type ImpactSurface,
} from '../shot-impacts';
import type { WorldQueries } from '../world/queries';
import type { Playback } from '../types';
import { useTracerEvidence } from './EquipmentFire';

const capacity = maxImpacts * spritesPerImpact;

const vertexShader = /* glsl */ `
  attribute vec3 aCenter, aAxis, aColor;
  attribute vec4 aParams;
  varying vec2 vUv;
  varying vec4 vParams;
  varying vec3 vColor;
  void main() {
    vUv = position.xy * 2.0;
    vParams = aParams;
    vColor = aColor;
    vec4 center = modelViewMatrix * vec4(aCenter, 1.0);
    vec2 offset = position.xy * aParams.x;
    if (aParams.z == 1.0 || aParams.z == 2.0) {
      // Sparks and chips stretch along their projected direction of travel.
      vec2 axis = (viewMatrix * vec4(aAxis, 0.0)).xy;
      axis /= max(length(axis), 0.05);
      float width = aParams.z == 1.0 ? 0.12 : 0.6;
      offset = aParams.x * (axis * position.x + vec2(-axis.y, axis.x) * position.y * width);
    }
    gl_Position = projectionMatrix * (center + vec4(offset, 0.0, 0.0));
  }
`;

const fragmentShader = /* glsl */ `
  varying vec2 vUv;
  varying vec4 vParams;
  varying vec3 vColor;
  uniform float displayScale;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
  }
  void main() {
    float r = length(vUv);
    if (r >= 1.0) discard;
    float style = floor(vParams.z + 0.5);
    float alpha;
    if (style == 0.0) {
      float n = noise(vUv * 3.1 + vParams.w * 17.0) * 0.6 + noise(vUv * 7.3 - vParams.w * 5.0) * 0.4;
      alpha = (1.0 - smoothstep(0.25, 1.0, r + (n - 0.5) * 0.5)) * (0.55 + 0.45 * n);
    } else if (style == 1.0) {
      alpha = exp(-vUv.y * vUv.y * 9.0) * smoothstep(-1.0, 0.5, vUv.x) * (1.0 - smoothstep(0.7, 1.0, r));
    } else if (style == 2.0) {
      alpha = 1.0 - smoothstep(0.55, 0.9, r);
    } else {
      alpha = exp(-r * r * 5.0);
    }
    alpha *= vParams.y;
    if (alpha <= 0.003) discard;
    // Display-referred colours, returned to scene light by the map grade's fixed scale.
    gl_FragColor = vec4(vColor * displayScale * alpha, alpha);
  }
`;

function viewAt(data: Playback, id: string, at: number) {
  const span = frameAt(data, at);
  const from = span.frame.players.find((player) => player.id === id);
  if (!from?.alive) return;
  return firstPersonView(
    playerPose(
      from,
      span.next.players.find((player) => player.id === id),
      span.alpha,
      poseTimingAt(data, span, id),
    ),
  );
}

type Contact = {
  point: [number, number, number];
  direction: [number, number, number];
  surface: ImpactSurface;
} | null;

/** Puffs, chips and sparks where recorded shots meet the prepared map. Depth
 * tested, sampled at demo time and off under reduced motion. */
export default function ShotImpacts({
  data,
  tick,
  queries,
  materials,
  displayScale,
}: {
  data: Playback;
  tick: number;
  queries: Pick<WorldQueries, 'hit' | 'revision'>;
  materials: readonly { name: string }[];
  /** The native grade's scale from display-referred to scene light. */
  displayScale: number;
}) {
  const evidence = useTracerEvidence();
  const invalidate = useThree((state) => state.invalidate);
  const contacts = useMemo(() => createShotRayCache<Contact>(256), [queries, evidence?.index]);
  const pool = useMemo(() => {
    const geometry = new InstancedBufferGeometry();
    const quad = new PlaneGeometry();
    geometry.index = quad.index;
    geometry.setAttribute('position', quad.getAttribute('position'));
    const attribute = (size: number) =>
      new InstancedBufferAttribute(new Float32Array(capacity * size), size);
    const center = attribute(3),
      axis = attribute(3),
      color = attribute(3),
      params = attribute(4);
    geometry.setAttribute('aCenter', center);
    geometry.setAttribute('aAxis', axis);
    geometry.setAttribute('aColor', color);
    geometry.setAttribute('aParams', params);
    geometry.instanceCount = 0;
    const material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      transparent: true,
      uniforms: { displayScale: { value: 1 } },
      premultipliedAlpha: true,
      depthWrite: false,
      toneMapped: false,
    });
    const mesh = new Mesh(geometry, material);
    mesh.name = 'presentation-shot-impacts';
    mesh.frustumCulled = false;
    mesh.renderOrder = 9;
    return { mesh, geometry, quad, material, center, axis, color, params };
  }, []);
  useEffect(
    () => () => {
      pool.geometry.dispose();
      pool.quad.dispose();
      pool.material.dispose();
    },
    [pool],
  );

  const sprites = useMemo(() => {
    if (!evidence || evidence.reducedMotion || !data.frames.length) return [];
    const result = [];
    // Every recorded firearm shot whose impact is still settling, newest first.
    for (const [id, shots] of evidence.index) {
      let low = 0,
        high = shots.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (shots[middle].tick <= tick) low = middle + 1;
        else high = middle;
      }
      for (let i = low - 1, kept = 0; i >= 0 && kept < 6; i--, kept++) {
        const shot = shots[i];
        const age = (tick - shot.tick) / data.tickRate;
        if (age >= impactLifetime) break;
        if (shot.weapon === 'taser' || shot.tick < data.frames[0].tick) continue;
        const contact = contacts.resolve(id, shot.tick, () => {
          const view = viewAt(data, id, shot.tick);
          if (!view) return null;
          const d = view.target.map((value, axis) => value - view.position[axis]);
          const length = Math.hypot(...d);
          if (!length) return null;
          const direction = d.map((value) => value / length) as [number, number, number];
          const end = view.position.map((value, axis) => value + direction[axis] * impactReach) as [
            number,
            number,
            number,
          ];
          const found = queries.hit({ target: view.position, position: end });
          if (!found) return null;
          return {
            point: found.point.toArray() as [number, number, number],
            direction,
            surface: impactSurface(materials[found.material]?.name),
          };
        });
        if (contact)
          result.push(
            ...impactSprites(
              contact.point,
              contact.direction,
              contact.surface,
              age,
              shot.tick % 997,
            ),
          );
      }
      if (result.length >= capacity) break;
    }
    return result.slice(0, capacity);
  }, [data, tick, evidence, contacts, queries, materials]);

  useEffect(() => invalidate(), [sprites, invalidate]);
  useFrame(() => {
    const { center, axis, color, params, geometry } = pool;
    sprites.forEach((sprite, i) => {
      center.setXYZ(i, ...sprite.position);
      axis.setXYZ(i, ...sprite.axis);
      color.setXYZ(i, ...sprite.color);
      params.setXYZW(i, sprite.size, sprite.alpha, sprite.style, sprite.seed);
    });
    for (const attribute of [center, axis, color, params]) {
      attribute.needsUpdate = sprites.length > 0;
      attribute.clearUpdateRanges();
      if (sprites.length) attribute.addUpdateRange(0, sprites.length * attribute.itemSize);
    }
    geometry.instanceCount = sprites.length;
    pool.material.uniforms.displayScale.value = displayScale;
    pool.mesh.visible = sprites.length > 0;
  });
  return <primitive object={pool.mesh} />;
}
