import { useContext, useEffect, useMemo } from 'react';
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
  Vector4,
} from 'three';
import type { EffectTextures } from '../effect-textures';
import { NativePasses } from '../world/frame-context';

/** One renderer of an official particle system, drawn from a prepared atlas. */
export type SpriteLayer = {
  id: string;
  texture: string;
  /** PARTICLE_OUTPUT_BLEND_MODE_ADD, alpha blending, or modulate 2x. */
  blend: 'add' | 'alpha' | 'mod2x';
  /** Camera-facing, flat on the ground, upright about world up, or stretched along motion
   * (C_OP_RenderTrails). */
  orientation: 'camera' | 'ground' | 'upright' | 'stretch';
  /** Authored overbright factor. Lit (alpha) layers also take the display scale. */
  gain: number;
  /** Most particles this layer draws. */
  cap: number;
  /** Sheet playback: frames per second, or a multiple of the particle's life (fit lifetime). */
  fps?: number;
  rate?: number;
  /** SPRITECARD_TEXTURE_1D_COLOR_LOOKUP stops: position and sRGB colour (0-255). */
  gradient?: readonly (readonly [number, number, number, number])[];
  /** bDisableZBuffering. */
  overlay?: boolean;
  /** m_flFeatheringMaxDist in inches: the sprite fades out within this distance in front of
   * opaque surfaces (soft particles). Ground-aligned layers keep 0. */
  feather?: number;
};

export type SpriteParticle = {
  position: readonly [number, number, number];
  /** Radius in metres. */
  size: number;
  rotation: number;
  alpha: number;
  /** Linear colour. */
  color: readonly [number, number, number];
  /** Normalised life, a per-particle sequence choice (0-1) and age in seconds. */
  life: number;
  sequence: number;
  age: number;
  /** Stretched sprites: world direction of travel and streak length in metres. */
  axis?: readonly [number, number, number];
  length?: number;
};

const vertexShader = /* glsl */ `
  attribute vec3 aCenter, aColor;
  attribute vec4 aParams; // size, rotation, alpha, frame
  attribute vec4 aAxis; // stretch direction and length
  uniform int orientation; // 0 ground, 1 camera, 2 upright, 3 stretch
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
    if (orientation == 0) {
      gl_Position = projectionMatrix * viewMatrix * vec4(aCenter + vec3(turned.x, 0.0, turned.y), 1.0);
    } else if (orientation == 1) {
      vec4 center = viewMatrix * vec4(aCenter, 1.0);
      gl_Position = projectionMatrix * (center + vec4(turned, 0.0, 0.0));
    } else if (orientation == 2) {
      // The sprite's vertical stays world up while it faces the camera.
      vec3 toCamera = cameraPosition - aCenter;
      vec3 side = normalize(vec3(toCamera.z, 0.0, -toCamera.x) + vec3(1e-5, 0.0, 0.0));
      gl_Position = projectionMatrix * viewMatrix *
        vec4(aCenter + side * turned.x + vec3(0.0, 1.0, 0.0) * turned.y, 1.0);
    } else {
      // The texture's vertical runs back along the screen-space direction of travel.
      vec4 center = viewMatrix * vec4(aCenter, 1.0);
      vec2 along = (viewMatrix * vec4(aAxis.xyz, 0.0)).xy;
      along = length(along) > 1e-4 ? normalize(along) : vec2(0.0, 1.0);
      vec2 across = vec2(-along.y, along.x);
      // The head leads by one radius and the streak trails its travel.
      float alongOffset = mix(-max(size, aAxis.w), size, corner.y + 0.5);
      gl_Position = projectionMatrix *
        (center + vec4(across * corner.x * size * 2.0 + along * alongOffset, 0.0, 0.0));
    }
  }
`;

const fragmentShader = /* glsl */ `
  #include <packing>
  uniform sampler2D map;
  uniform int mode; // 0 additive, 1 mod2x, 2 alpha
  uniform float gain;
  uniform sampler2D sceneDepth;
  uniform vec4 depthView; // width, height, near, far
  uniform float feather; // metres, 0 for none
  float viewDepth(float depth) {
    return isOrthographic
      ? orthographicDepthToViewZ(depth, depthView.z, depthView.w)
      : perspectiveDepthToViewZ(depth, depthView.z, depthView.w);
  }
  uniform int stops;
  uniform vec4 gradient[4];
  varying vec2 vUv;
  varying vec4 vColor;
  // Ramps blend in sRGB like the authored gradient, then return to linear light.
  vec3 lookup(float t) {
    vec3 color = gradient[0].yzw;
    for (int i = 1; i < 4; i++) {
      if (i >= stops) break;
      color = mix(color, gradient[i].yzw,
        clamp((t - gradient[i - 1].x) / max(1e-4, gradient[i].x - gradient[i - 1].x), 0.0, 1.0));
    }
    return pow(color, vec3(2.2));
  }
  void main() {
    vec4 texel = texture2D(map, vUv);
    // The sheet's stored grey level (before sRGB decoding) indexes the ramp.
    if (stops > 0) texel.rgb = lookup(pow(max(texel.r, max(texel.g, texel.b)), 1.0 / 2.2));
    float alpha = texel.a * vColor.a;
    if (feather > 0.0 && depthView.x > 0.0) {
      float behind = texture2D(sceneDepth, gl_FragCoord.xy / depthView.xy).r;
      alpha *= clamp((viewDepth(gl_FragCoord.z) - viewDepth(behind)) / feather, 0.0, 1.0);
    }
    if (alpha <= 0.002) discard;
    if (mode == 0) {
      // Self-illuminated additive sprites, overbright as authored.
      gl_FragColor = vec4(texel.rgb * vColor.rgb * gain * alpha, 0.0);
    } else if (mode == 1) {
      // Modulate 2x: grey 0.5 leaves the surface unchanged, brighter colour lights it.
      gl_FragColor = vec4(mix(vec3(0.5), texel.rgb * vColor.rgb * 0.5 * gain, clamp(alpha, 0.0, 1.0)), 1.0);
    } else {
      gl_FragColor = vec4(texel.rgb * vColor.rgb * gain * alpha, alpha);
    }
  }
`;

type Pool = {
  mesh: Mesh;
  geometry: InstancedBufferGeometry;
  material: ShaderMaterial;
  center: InstancedBufferAttribute;
  color: InstancedBufferAttribute;
  params: InstancedBufferAttribute;
  axis: InstancedBufferAttribute;
};

function pool(layer: SpriteLayer, textures: EffectTextures, quad: PlaneGeometry, order: number) {
  const entry = textures[layer.texture];
  const geometry = new InstancedBufferGeometry();
  geometry.index = quad.index;
  geometry.setAttribute('position', quad.getAttribute('position'));
  const attribute = (size: number) =>
    new InstancedBufferAttribute(new Float32Array(layer.cap * size), size);
  const center = attribute(3),
    color = attribute(3),
    params = attribute(4),
    axis = attribute(4);
  geometry.setAttribute('aCenter', center);
  geometry.setAttribute('aColor', color);
  geometry.setAttribute('aParams', params);
  geometry.setAttribute('aAxis', axis);
  geometry.instanceCount = 0;
  const stops = layer.gradient ?? [];
  const sheet = entry.sheet;
  const material = new ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      map: { value: entry.texture },
      orientation: {
        value: { ground: 0, camera: 1, upright: 2, stretch: 3 }[layer.orientation],
      },
      sheet: { value: [sheet.columns, sheet.cell / sheet.width, sheet.cell / sheet.height] },
      mode: { value: { add: 0, mod2x: 1, alpha: 2 }[layer.blend] },
      gain: { value: layer.gain },
      sceneDepth: { value: null },
      depthView: { value: new Vector4() },
      feather: { value: (layer.feather ?? 0) * 0.0254 },
      stops: { value: Math.min(4, stops.length) },
      gradient: {
        value: Array.from({ length: 4 }, (_, i) => {
          const stop = stops[Math.min(i, stops.length - 1)] ?? [0, 255, 255, 255];
          return new Vector4(stop[0], stop[1] / 255, stop[2] / 255, stop[3] / 255);
        }),
      },
    },
    transparent: true,
    depthWrite: false,
    depthTest: !layer.overlay,
    premultipliedAlpha: layer.blend !== 'mod2x',
    blending:
      layer.blend === 'add'
        ? AdditiveBlending
        : layer.blend === 'mod2x'
          ? CustomBlending
          : NormalBlending,
    ...(layer.blend === 'mod2x' ? { blendSrc: DstColorFactor, blendDst: SrcColorFactor } : {}),
    polygonOffset: layer.orientation === 'ground',
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    toneMapped: false,
  });
  const mesh = new Mesh(geometry, material);
  mesh.name = 'effect-' + layer.id;
  mesh.frustumCulled = false;
  mesh.renderOrder = 3 + order * 0.01;
  mesh.visible = false;
  return { mesh, geometry, material, center, color, params, axis } satisfies Pool;
}

/** Instanced sprites for a list of official particle renderers, one draw per visible layer.
 * `particles` is recomputed by the caller from demo time, so any tick is reproducible. */
export default function EffectSprites({
  name,
  layers,
  particles,
  textures,
  displayScale,
}: {
  name: string;
  layers: readonly SpriteLayer[];
  particles: Readonly<Record<string, readonly SpriteParticle[]>>;
  textures: EffectTextures;
  displayScale: number;
}) {
  const invalidate = useThree((state) => state.invalidate);
  const native = useContext(NativePasses);
  const soft = useMemo(() => layers.some((layer) => layer.feather), [layers]);
  const quad = useMemo(() => new PlaneGeometry(), []);
  const pools = useMemo(() => {
    const group = new Group();
    group.name = name;
    const made = new Map<string, Pool>();
    layers.forEach((layer, order) => {
      if (!textures[layer.texture]) return;
      const entry = pool(layer, textures, quad, order);
      made.set(layer.id, entry);
      group.add(entry.mesh);
    });
    return { group, made };
  }, [name, layers, textures, quad]);
  useEffect(
    () => () => {
      for (const entry of pools.made.values()) {
        entry.geometry.dispose();
        entry.material.dispose();
      }
    },
    [pools],
  );
  useEffect(() => () => quad.dispose(), [quad]);
  useEffect(() => invalidate(), [particles, invalidate]);

  useFrame(({ camera }) => {
    const depth = native?.depth;
    if (soft && depth) {
      if (layers.some((layer) => layer.feather && particles[layer.id]?.length)) depth.wanted = true;
      const perspective = camera as { near: number; far: number };
      for (const entry of pools.made.values()) {
        entry.material.uniforms.sceneDepth.value = depth.texture;
        (entry.material.uniforms.depthView.value as Vector4).set(
          depth.width,
          depth.height,
          perspective.near,
          perspective.far,
        );
      }
    }
    for (const layer of layers) {
      const entry = pools.made.get(layer.id);
      if (!entry) continue;
      const list = particles[layer.id] ?? [];
      const sheet = textures[layer.texture].sheet;
      entry.material.uniforms.gain.value =
        layer.blend === 'alpha' ? layer.gain * displayScale : layer.gain;
      const count = Math.min(layer.cap, list.length);
      for (let i = 0; i < count; i++) {
        const particle = list[i];
        const sequence =
          sheet.sequences[
            Math.min(
              sheet.sequences.length - 1,
              Math.floor(particle.sequence * sheet.sequences.length),
            )
          ];
        const step = layer.fps
          ? Math.floor(particle.age * layer.fps)
          : Math.floor(particle.life * (layer.rate ?? 1) * sequence.count);
        const frame = sequence.start + Math.min(sequence.count - 1, Math.max(0, step));
        entry.center.setXYZ(i, particle.position[0], particle.position[1], particle.position[2]);
        entry.color.setXYZ(i, particle.color[0], particle.color[1], particle.color[2]);
        entry.params.setXYZW(i, particle.size, particle.rotation, particle.alpha, frame);
        const axis = particle.axis ?? [0, 1, 0];
        entry.axis.setXYZW(i, axis[0], axis[1], axis[2], particle.length ?? 0);
      }
      for (const attribute of [entry.center, entry.color, entry.params, entry.axis]) {
        attribute.clearUpdateRanges();
        if (count) {
          attribute.addUpdateRange(0, count * attribute.itemSize);
          attribute.needsUpdate = true;
        }
      }
      entry.geometry.instanceCount = count;
      entry.mesh.visible = count > 0;
    }
  });
  return <primitive object={pools.group} />;
}
