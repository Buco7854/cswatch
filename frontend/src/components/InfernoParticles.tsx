import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import {
  AdditiveBlending,
  CustomBlending,
  DstColorFactor,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  NormalBlending,
  PlaneGeometry,
  ShaderMaterial,
  SrcColorFactor,
  type Texture,
} from 'three';
import { fireLayers, fireParticles, type FireLayerId, type FirePoint } from '../inferno-particles';
import type { EffectTextures } from '../effect-textures';

const layerOrder: FireLayerId[] = ['scorch', 'glow', 'ground', 'smoke', 'flame', 'ember'];
const blend: Record<FireLayerId, 'add' | 'mod2x' | 'alpha'> = {
  scorch: 'alpha',
  glow: 'mod2x',
  ground: 'add',
  smoke: 'alpha',
  flame: 'add',
  ember: 'add',
};
const overbright: Record<FireLayerId, number> = {
  scorch: 1,
  glow: 2,
  ground: 2.5,
  smoke: 1,
  flame: 2.5,
  ember: 2,
};

const vertexShader = /* glsl */ `
  attribute vec3 aCenter, aColor;
  attribute vec4 aParams; // size, rotation, alpha, frame
  uniform int orientation; // 0 ground, 1 camera, 2 upright
  uniform vec3 sheet; // columns, cell / width, cell / height
  varying vec2 vUv;
  varying vec4 vColor;
  void main() {
    float size = aParams.x, angle = aParams.y;
    vec2 corner = position.xy;
    vec2 turned = vec2(cos(angle) * corner.x - sin(angle) * corner.y,
                       sin(angle) * corner.x + cos(angle) * corner.y) * size * 2.0;
    float frame = aParams.w;
    vec2 cell = vec2(mod(frame, sheet.x), floor(frame / sheet.x));
    vUv = (cell + vec2(position.x + 0.5, 0.5 - position.y)) * sheet.yz;
    vColor = vec4(aColor, aParams.z);
    vec4 world;
    if (orientation == 0) {
      world = vec4(aCenter + vec3(turned.x, 0.0, turned.y), 1.0);
      gl_Position = projectionMatrix * viewMatrix * world;
    } else if (orientation == 1) {
      vec4 center = viewMatrix * vec4(aCenter, 1.0);
      gl_Position = projectionMatrix * (center + vec4(turned, 0.0, 0.0));
    } else {
      // Upright: the sprite's vertical stays world up while it faces the camera.
      vec3 toCamera = cameraPosition - aCenter;
      vec3 side = normalize(vec3(toCamera.z, 0.0, -toCamera.x) + vec3(1e-5, 0.0, 0.0));
      world = vec4(aCenter + side * turned.x + vec3(0.0, 1.0, 0.0) * turned.y, 1.0);
      gl_Position = projectionMatrix * viewMatrix * world;
    }
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D map;
  uniform int mode; // 0 additive, 1 mod2x, 2 alpha
  uniform float gain;
  varying vec2 vUv;
  varying vec4 vColor;
  void main() {
    vec4 texel = texture2D(map, vUv);
    float alpha = texel.a * vColor.a;
    if (mode == 0) {
      // Self-illuminated additive sprites, overbright as authored.
      gl_FragColor = vec4(texel.rgb * vColor.rgb * gain * alpha, 0.0);
    } else if (mode == 1) {
      // Modulate 2x: grey 0.5 leaves the surface unchanged, brighter colour lights it.
      gl_FragColor = vec4(mix(vec3(0.5), texel.rgb * vColor.rgb * 0.5 * gain, clamp(alpha, 0.0, 1.0)), 1.0);
    } else {
      gl_FragColor = vec4(texel.rgb * vColor.rgb * gain * alpha, alpha);
    }
    if (alpha <= 0.002) discard;
  }
`;

type Pool = {
  mesh: Mesh;
  geometry: InstancedBufferGeometry;
  material: ShaderMaterial;
  center: InstancedBufferAttribute;
  color: InstancedBufferAttribute;
  params: InstancedBufferAttribute;
};

function pool(layer: FireLayerId, texture: Texture, quad: PlaneGeometry): Pool {
  const capacity = fireLayers[layer].cap;
  const geometry = new InstancedBufferGeometry();
  geometry.index = quad.index;
  geometry.setAttribute('position', quad.getAttribute('position'));
  const attribute = (size: number) =>
    new InstancedBufferAttribute(new Float32Array(capacity * size), size);
  const center = attribute(3),
    color = attribute(3),
    params = attribute(4);
  geometry.setAttribute('aCenter', center);
  geometry.setAttribute('aColor', color);
  geometry.setAttribute('aParams', params);
  geometry.instanceCount = 0;
  const mode = blend[layer];
  const material = new ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      map: { value: texture },
      orientation: {
        value: { ground: 0, camera: 1, upright: 2 }[fireLayers[layer].orientation],
      },
      sheet: { value: [1, 1, 1] },
      mode: { value: { add: 0, mod2x: 1, alpha: 2 }[mode] },
      gain: { value: 1 },
    },
    transparent: true,
    depthWrite: false,
    premultipliedAlpha: mode !== 'mod2x',
    blending:
      mode === 'add' ? AdditiveBlending : mode === 'mod2x' ? CustomBlending : NormalBlending,
    ...(mode === 'mod2x' ? { blendSrc: DstColorFactor, blendDst: SrcColorFactor } : {}),
    polygonOffset: fireLayers[layer].orientation === 'ground',
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    toneMapped: false,
  });
  const mesh = new Mesh(geometry, material);
  mesh.name = 'inferno-' + layer;
  mesh.frustumCulled = false;
  mesh.renderOrder = 3 + layerOrder.indexOf(layer) * 0.1;
  return { mesh, geometry, material, center, color, params };
}

/** The official inferno layers over recorded fire points, from prepared atlases. */
export default function InfernoParticles({
  points,
  time,
  textures,
  displayScale,
}: {
  points: readonly FirePoint[];
  time: number;
  textures: EffectTextures;
  displayScale: number;
}) {
  const invalidate = useThree((state) => state.invalidate);
  const quad = useMemo(() => new PlaneGeometry(), []);
  const pools = useMemo(() => {
    const group = new Group();
    const made: Partial<Record<FireLayerId, Pool>> = {};
    for (const layer of layerOrder) {
      const entry = textures[fireLayers[layer].texture];
      if (!entry) continue;
      made[layer] = pool(layer, entry.texture, quad);
      group.add(made[layer].mesh);
    }
    return { group, made };
  }, [textures, quad]);
  useEffect(
    () => () => {
      for (const entry of Object.values(pools.made)) {
        entry.geometry.dispose();
        entry.material.dispose();
      }
    },
    [pools],
  );
  useEffect(() => () => quad.dispose(), [quad]);

  const particles = useMemo(() => {
    const result: Partial<Record<FireLayerId, ReturnType<typeof fireParticles>>> = {};
    for (const layer of layerOrder)
      if (pools.made[layer]) result[layer] = fireParticles(layer, points, time);
    return result;
  }, [points, time, pools]);
  useEffect(() => invalidate(), [particles, invalidate]);

  useFrame(() => {
    for (const layer of layerOrder) {
      const entry = pools.made[layer];
      const list = particles[layer];
      if (!entry || !list) continue;
      const sheet = textures[fireLayers[layer].texture].sheet;
      const spec = fireLayers[layer];
      entry.material.uniforms.sheet.value = [
        sheet.columns,
        sheet.cell / sheet.width,
        sheet.cell / sheet.height,
      ];
      entry.material.uniforms.gain.value =
        blend[layer] === 'alpha' ? overbright[layer] * displayScale : overbright[layer];
      list.forEach((particle, i) => {
        const sequence =
          sheet.sequences[
            Math.min(
              sheet.sequences.length - 1,
              Math.floor(particle.sequence * sheet.sequences.length),
            )
          ];
        const step =
          spec.fps > 0
            ? Math.floor(particle.age * spec.fps)
            : Math.floor(particle.life * sequence.count);
        const frame = sequence.start + Math.min(sequence.count - 1, Math.max(0, step));
        entry.center.setXYZ(i, ...particle.position);
        entry.color.setXYZ(i, ...particle.color);
        entry.params.setXYZW(i, particle.size, particle.rotation, particle.alpha, frame);
      });
      for (const attribute of [entry.center, entry.color, entry.params]) {
        attribute.clearUpdateRanges();
        if (list.length) {
          attribute.addUpdateRange(0, list.length * attribute.itemSize);
          attribute.needsUpdate = true;
        }
      }
      entry.geometry.instanceCount = list.length;
      entry.mesh.visible = list.length > 0;
    }
  });
  return <primitive object={pools.group} />;
}
