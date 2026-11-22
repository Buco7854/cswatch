import { useThree } from '@react-three/fiber';
import { useLayoutEffect, useMemo, useRef } from 'react';
import { Vector2, Vector4, type Group, type PointLight, type ShaderMaterial } from 'three';
import { mapGradeBurstLights } from '../map-grade';
import { maxBursts, maxImpactSprites, sampleGrenadeBursts } from '../grenade-burst';
import { impactPlaneCount, impactSurfaces } from '../impact-surfaces';
import type { UtilityZone } from '../utility-state';
import BurstContactDepth, { type ContactDepthUniforms } from './BurstContactDepth';
import UtilitySprites, { effectNoise, spriteVaryings, spriteVertexInputs } from './UtilitySprites';

const vertexShader = `
  ${spriteVertexInputs}
  varying vec3 spriteWorld;
  varying float centerDepth;
  void main() {
    spriteUv = position.xy;
    effect = aEffect;
    seed = aOrigin.w;
    float radius = effect.x;
    vec2 offset = position.xy * radius;
    if (effect.w == 2.0) {
      vec3 direction = vec3(cos(effect.z), 0.40, sin(effect.z));
      vec2 axis = (viewMatrix * vec4(direction, 0.0)).xy;
      axis /= max(length(axis), 0.08);
      offset = radius * (axis * position.x + vec2(-axis.y, axis.x) * position.y * 0.14);
    }
    vec3 right = vec3(viewMatrix[0].x, viewMatrix[1].x, viewMatrix[2].x);
    vec3 up = vec3(viewMatrix[0].y, viewMatrix[1].y, viewMatrix[2].y);
    spriteWorld = aOrigin.xyz + right * offset.x + up * offset.y;
    vec4 center = modelViewMatrix * vec4(aOrigin.xyz, 1.0);
    // Retain the unshifted position for the world-plane contact fade.
    centerDepth = center.z;
    gl_Position = projectionMatrix * (center + vec4(offset, 0.0, 0.0));
  }
`;

const fragmentShader = `
  ${spriteVaryings}
  ${effectNoise}
  varying vec3 spriteWorld;
  varying float centerDepth;
  uniform mat4 projectionMatrix;
  uniform sampler2D contactDepth;
  uniform vec2 contactViewport;
  uniform bool contactDepthReady;
  uniform vec4 contactPlanes[${maxBursts * impactPlaneCount}];
  void main() {
    float r = length(spriteUv);
    if (r >= 1.0) discard;
    // Fragment interpolation can round an instance tag off its exact integer.
    float style = floor(effect.w + 0.5);
    // The visible surface follows the front of a round lobe rather than the
    // flat billboard plane. At silhouette edges, both the bulge and opacity fall off.
    float bulge = min(min(0.42,-centerDepth*0.45), effect.x * (0.11 + 0.57*sqrt(1.0-r*r)));
    vec4 clip = projectionMatrix * vec4(0.0,0.0,centerDepth + bulge,1.0);
    gl_FragDepth = clamp(clip.z / clip.w * 0.5 + 0.5, 0.0, 1.0);
    float salt = fract(seed) * 101.0;
    float cloud = noise(spriteUv * 3.5 + salt + effect.z * 0.7);
    float detail = noise(spriteUv * 9.4 + salt - effect.z * 0.9);
    float shape = r + (cloud-0.5)*0.43 + (detail-0.5)*0.15;
    float edge = 1.0 - smoothstep(0.69, 1.0, r);
    float volume = (1.0-smoothstep(0.10,0.92,shape)) * edge;
    vec3 color;
    float alpha;
    if (style == 0.0) {
      float heat = clamp(effect.z + (cloud-0.50)*0.37 - r*0.30,0.0,1.0);
      color = mix(vec3(0.125,0.060,0.034),vec3(1.0,0.205,0.026),smoothstep(0.02,0.44,heat));
      color = mix(color,vec3(1.60,1.28,0.70),smoothstep(0.50,0.91,heat));
      alpha = volume * (0.76 + detail * 0.23);
    } else if (style == 1.0 || style == 5.0) {
      color = style == 1.0
        ? mix(vec3(0.042,0.034,0.029),vec3(0.28,0.217,0.165),cloud*cloud)
        : mix(vec3(0.22,0.26,0.28),vec3(0.68,0.70,0.72),cloud);
      alpha = volume * (0.50 + cloud*0.48);
    } else if (style == 2.0) {
      color = mix(vec3(1.0,0.25,0.026),vec3(1.7,1.22,0.54),smoothstep(0.1,0.80,spriteUv.x));
      alpha = exp(-spriteUv.y*spriteUv.y*7.0) * edge * smoothstep(-1.0,0.6,spriteUv.x);
    } else {
      color = mix(vec3(1.23,1.40,1.62),vec3(1.62,1.21,0.59),effect.z);
      alpha = exp(-r*r*(style == 3.0 ? 4.2 : 5.7)) * edge;
    }
    int first = int(floor(seed)) * ${impactPlaneCount};
    float contact = 1.0;
    for (int i = 0; i < ${impactPlaneCount}; i++) {
      float d = dot(vec4(spriteWorld,1.0),contactPlanes[first+i]);
      contact = min(contact,smoothstep(-0.10,max(0.12,effect.x*0.45),d));
    }
    if (contactDepthReady) {
      float depth = texture2D(contactDepth, gl_FragCoord.xy / contactViewport).r;
      if (depth < 0.999999) {
        float ndc = depth*2.0-1.0;
        float a = projectionMatrix[2][2], b = projectionMatrix[3][2];
        float surfaceZ = isOrthographic ? (ndc-b)/a : -b/(ndc+a);
        contact = min(contact,smoothstep(0.015,0.19+effect.x*0.47,centerDepth+bulge-surfaceZ));
      }
    }
    gl_FragColor = vec4(color,alpha * effect.y * contact);
    #include <colorspace_fragment>
  }
`;

export default function GrenadeBurst({
  zones,
  staticMap,
  lighting,
  warm,
  tick,
  rate,
  reducedMotion,
}: {
  zones: UtilityZone[];
  staticMap: Group | null;
  lighting: boolean;
  warm: boolean;
  tick: number;
  rate: number;
  reducedMotion: boolean;
}) {
  const bursts = useMemo(
    () => sampleGrenadeBursts(zones, tick, rate, reducedMotion),
    [zones, tick, rate, reducedMotion],
  );
  const planeCache = useMemo(() => {
    const contacts = new Map<string, ReturnType<typeof impactSurfaces>>();
    return (id: string, origin: [number, number, number]) => {
      const key = id + ':' + origin.join(',');
      if (!contacts.has(key)) {
        if (contacts.size >= 32) contacts.delete(contacts.keys().next().value!);
        contacts.set(key, impactSurfaces(staticMap, origin));
      }
      return contacts.get(key)!;
    };
  }, [staticMap]);
  const materialRef = useRef<ShaderMaterial>(null);
  const depthUniforms = useMemo<ContactDepthUniforms>(
    () => ({
      contactDepth: { value: null },
      contactViewport: { value: new Vector2(1, 1) },
      contactDepthReady: { value: false },
    }),
    [],
  );
  const uniforms = useMemo(
    () => ({
      ...depthUniforms,
      contactPlanes: {
        value: Array.from({ length: maxBursts * impactPlaneCount }, () => new Vector4(0, 0, 0, 4)),
      },
    }),
    [depthUniforms],
  );
  // Origins and local geometry are constant for a burst. Fractional demo time
  // updates only sprite data, including while playback crosses chunk boundaries.
  const activeKey = JSON.stringify(bursts.map(({ id, origin }) => [id, origin]));
  const vertices = useMemo(() => {
    const active = JSON.parse(activeKey) as [string, [number, number, number]][];
    return active.map(([id, origin], index) => {
      const { planes, vertices } = planeCache(id, origin);
      for (let p = 0; p < impactPlaneCount; p++) {
        const uniform = uniforms.contactPlanes.value[index * impactPlaneCount + p];
        if (planes[p]) uniform.copy(planes[p]);
        else uniform.set(0, 0, 0, 4);
      }
      return vertices;
    });
  }, [activeKey, planeCache, uniforms]);
  const sprites = useMemo(() => bursts.flatMap((burst) => burst.sprites), [bursts]);
  const light = bursts.reduce<(typeof bursts)[number] | undefined>(
    (brightest, burst) => (burst.light > (brightest?.light ?? 0) ? burst : brightest),
    undefined,
  );

  const scene = useThree((state) => state.scene);
  const pointLight = useRef<PointLight>(null);
  const nominalIntensity = useRef(0);
  useLayoutEffect(() => {
    nominalIntensity.current = light?.light ?? 0;
  }, [light?.light]);
  useLayoutEffect(() => {
    if (!pointLight.current) return;
    const entry = { light: pointLight.current, intensity: () => nominalIntensity.current };
    mapGradeBurstLights.set(scene, entry);
    return () => {
      if (mapGradeBurstLights.get(scene) === entry) mapGradeBurstLights.delete(scene);
    };
  }, [scene, lighting]);
  return (
    <>
      <BurstContactDepth vertices={vertices} materialRef={materialRef} warm={warm} />
      <UtilitySprites
        name="utility-detonation"
        capacity={maxImpactSprites}
        warm={warm}
        lighting={lighting}
        sprites={sprites}
        uniforms={uniforms}
        materialRef={materialRef}
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        renderOrder={4}
      />
      {/* Reserve one light slot for the lifetime of this quality profile. */}
      {lighting && (
        <pointLight
          ref={pointLight}
          name="utility-detonation-light"
          color={light?.flash ? '#e6efff' : '#ffb078'}
          position={light && [light.origin[0], light.origin[1] + 0.3, light.origin[2]]}
          intensity={light?.light ?? 0}
          distance={8}
          decay={2}
        />
      )}
    </>
  );
}
