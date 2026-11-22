import { useEffect, useLayoutEffect, useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import {
  grenadePathOpacity,
  revealedPoints,
  visibleGrenadePaths,
  type GrenadePath,
  type GrenadePathsMode,
} from '../grenade-paths';
import type { Playback } from '../types';
import { useReducedMotion } from '../reduced-motion';
import { useGrenadePaths } from './useGrenadePaths';

const inches = 0.0254;

function PathMesh({
  path,
  tick,
  rate,
  steady,
}: {
  path: GrenadePath;
  tick: number;
  rate: number;
  steady: boolean;
}) {
  const invalidate = useThree((state) => state.invalidate);
  const size = useThree((state) => state.size);
  const draw = useMemo(() => {
    const group = new THREE.Group();
    group.name = 'grenade-path:' + path.id;
    const positions = new Float32Array(Math.max(2, path.points.length) * 3);
    path.points.forEach(({ x, y, z }, i) => {
      positions[i * 3] = x * inches;
      positions[i * 3 + 1] = z * inches;
      positions[i * 3 + 2] = -y * inches;
    });
    const geometry = new LineGeometry().setPositions(positions);
    const solid = new LineMaterial({
      color: path.color,
      linewidth: 2.5,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    });
    const casing = new LineMaterial({
      color: '#302924',
      linewidth: 4.1,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    });
    const hidden = solid.clone();
    hidden.depthFunc = THREE.GreaterDepth;
    const cssSize = new THREE.Vector2();
    for (const [material, order] of [
      [hidden, 6],
      [casing, 7],
      [solid, 8],
    ] as const) {
      const line = new Line2(geometry, material);
      line.renderOrder = order;
      line.onBeforeRender = () => material.resolution.copy(cssSize);
      group.add(line);
    }
    const makeMarkers = (color: string, diameter: number, vertices: Float32Array) => {
      const geometry = new THREE.BufferGeometry().setAttribute(
        'position',
        new THREE.BufferAttribute(vertices, 3),
      );
      const material = new THREE.ShaderMaterial({
        uniforms: {
          tint: { value: new THREE.Color(color) },
          diameter: { value: diameter },
          ratio: { value: 1 },
          alpha: { value: 1 },
        },
        vertexShader: `
          uniform float diameter;
          uniform float ratio;
          void main() {
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.);
            gl_PointSize = diameter * ratio;
          }
        `,
        fragmentShader: `
          uniform vec3 tint;
          uniform float alpha;
          void main() {
            float radius = length(gl_PointCoord - vec2(.5));
            float edge = 1. - smoothstep(.42, .5, radius);
            if (edge <= 0.) discard;
            vec3 rgb = mix(tint, vec3(.062, .042, .034), smoothstep(.29, .37, radius));
            gl_FragColor = vec4(rgb, edge * alpha);
            #include <colorspace_fragment>
          }
        `,
        transparent: true,
        depthWrite: false,
      });
      const points = new THREE.Points(geometry, material);
      const buffer = new THREE.Vector2();
      points.frustumCulled = false;
      points.renderOrder = 9;
      points.onBeforeRender = (gl) => {
        material.uniforms.ratio.value = gl.getDrawingBufferSize(buffer).y / Math.max(1, cssSize.y);
      };
      group.add(points);
      return points;
    };
    const bouncePositions = new Float32Array(path.bounces.length * 3);
    path.bounces.forEach((index, i) =>
      bouncePositions.set(positions.subarray(index * 3, index * 3 + 3), i * 3),
    );
    const bounces = makeMarkers(path.color, 7, bouncePositions);
    const tip = makeMarkers(path.marker, 10, new Float32Array(3));
    return { group, cssSize, positions, geometry, solid, casing, hidden, bounces, tip };
  }, [path]);

  useLayoutEffect(() => {
    const count = revealedPoints(path.points, tick);
    const opacity = grenadePathOpacity(path, tick, rate, steady);
    draw.cssSize.set(size.width, size.height);
    draw.geometry.instanceCount = Math.max(0, count - 1);
    draw.solid.opacity = opacity;
    draw.casing.opacity = opacity * 0.9;
    draw.hidden.opacity = opacity * 0.32;
    let bounceCount = 0;
    while (bounceCount < path.bounces.length && path.bounces[bounceCount] + 1 < count)
      bounceCount++;
    draw.bounces.geometry.setDrawRange(0, bounceCount);
    draw.bounces.visible = bounceCount > 0;
    draw.bounces.material.uniforms.alpha.value = opacity;
    draw.tip.visible = count > 0 && tick < path.end && tick <= path.points.at(-1)!.tick;
    if (draw.tip.visible) draw.tip.position.fromArray(draw.positions, (count - 1) * 3);
    invalidate();
  }, [draw, invalidate, path, rate, size.height, size.width, steady, tick]);

  useEffect(
    () => () => {
      draw.geometry.dispose();
      draw.solid.dispose();
      draw.casing.dispose();
      draw.hidden.dispose();
      draw.bounces.geometry.dispose();
      draw.bounces.material.dispose();
      draw.tip.geometry.dispose();
      draw.tip.material.dispose();
    },
    [draw],
  );
  return <primitive object={draw.group} />;
}

export default function GrenadePaths({
  data,
  tick,
  selected,
  mode,
}: {
  data: Playback;
  tick: number;
  selected: string;
  mode: GrenadePathsMode;
}) {
  const paths = useGrenadePaths(data);
  const steady = useReducedMotion();
  return visibleGrenadePaths(paths, tick, data.tickRate, mode, selected).map((path) => (
    <PathMesh key={path.id} path={path} tick={tick} rate={data.tickRate} steady={steady} />
  ));
}
