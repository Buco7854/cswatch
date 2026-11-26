import { useContext, useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
} from 'three';
import { ReplayFrameContext } from '../replay-frames';
import { activeBloodDecals, bloodDecalLimit } from '../blood-decals';
import type { WorldQueries } from '../world/queries';
import type { Playback } from '../types';

const vertex = /* glsl */ `
attribute vec3 iCenter;
attribute vec3 iNormal;
attribute vec3 iAlong;
attribute vec4 iShape; // size, alpha, seed, wall
varying vec2 vUv;
varying vec4 vShape;
void main() {
  vUv = uv;
  vShape = iShape;
  vec3 side = normalize(cross(iNormal, iAlong));
  // Stretched along the shot on walls, rounder where it fell to the floor.
  float stretch = mix(1.0, 1.55, iShape.w);
  vec3 world = iCenter + (iAlong * position.x * stretch + side * position.y) * iShape.x;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}`;
const fragment = /* glsl */ `
varying vec2 vUv;
varying vec4 vShape;
float hash(float n) { return fract(sin(n) * 43758.5453); }
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float seed = vShape.z;
  float angle = atan(p.y, p.x);
  // A ragged core whose edge wobbles with the seed.
  float edge = 0.48 + 0.07 * sin(angle * 5.0 + seed * 6.0) + 0.05 * sin(angle * 11.0 + seed * 3.0);
  float splat = 1.0 - smoothstep(edge - 0.06, edge, length(p));
  // Droplets thrown past the core, mostly ahead along the shot.
  for (int i = 0; i < 7; i++) {
    float f = float(i);
    vec2 c = vec2(0.35 + 0.55 * hash(seed + f * 1.7), (hash(seed + f * 3.1) - 0.5) * 1.1);
    float r = 0.04 + 0.06 * hash(seed + f * 5.3);
    splat = max(splat, 1.0 - smoothstep(r * 0.7, r, length(p - c)));
  }
  float alpha = splat * vShape.y * 0.92;
  if (alpha < 0.01) discard;
  // Darker where it pooled at the centre.
  vec3 color = mix(vec3(0.11, 0.006, 0.004), vec3(0.055, 0.002, 0.002), 1.0 - length(p));
  gl_FragColor = vec4(color, alpha);
}`;

/** Recorded bullet hits leave blood on the wall behind the victim, or on the floor. */
export default function BloodDecals({
  data,
  tick,
  query,
}: {
  data: Playback;
  tick: number;
  query: WorldQueries['hit'];
}) {
  const replay = useContext(ReplayFrameContext);
  const { mesh, centers, normals, alongs, shapes } = useMemo(() => {
    const quad = new PlaneGeometry(1, 1);
    const geometry = new InstancedBufferGeometry();
    geometry.index = quad.index;
    geometry.setAttribute('position', quad.getAttribute('position'));
    geometry.setAttribute('uv', quad.getAttribute('uv'));
    const attribute = (size: number) => {
      const value = new InstancedBufferAttribute(new Float32Array(bloodDecalLimit * size), size);
      value.setUsage(35048);
      return value;
    };
    const centers = attribute(3),
      normals = attribute(3),
      alongs = attribute(3),
      shapes = attribute(4);
    geometry.setAttribute('iCenter', centers);
    geometry.setAttribute('iNormal', normals);
    geometry.setAttribute('iAlong', alongs);
    geometry.setAttribute('iShape', shapes);
    geometry.instanceCount = 0;
    const material = new ShaderMaterial({
      vertexShader: vertex,
      fragmentShader: fragment,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const mesh = new Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.name = 'recorded-blood-decals';
    return { mesh, centers, normals, alongs, shapes };
  }, []);
  useEffect(
    () => () => {
      mesh.geometry.dispose();
      (mesh.material as ShaderMaterial).dispose();
    },
    [mesh],
  );
  useFrame(() => {
    const decals = activeBloodDecals(data, replay?.tick ?? tick, query);
    decals.forEach((decal, i) => {
      centers.setXYZ(i, decal.center.x, decal.center.y, decal.center.z);
      normals.setXYZ(i, decal.normal.x, decal.normal.y, decal.normal.z);
      alongs.setXYZ(i, decal.along.x, decal.along.y, decal.along.z);
      shapes.setXYZW(
        i,
        decal.size * decal.grow,
        decal.alpha,
        (decal.seed % 997) / 7,
        decal.wall ? 1 : 0,
      );
    });
    // Mounted with zero instances so its program links before the first hit.
    (mesh.geometry as InstancedBufferGeometry).instanceCount = decals.length;
    if (decals.length)
      for (const attribute of [centers, normals, alongs, shapes]) attribute.needsUpdate = true;
  }, -1);
  return <primitive object={mesh} />;
}
