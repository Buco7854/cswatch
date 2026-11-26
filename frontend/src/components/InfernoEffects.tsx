import InfernoParticles from './InfernoParticles';
import { useEffectTextures } from '../effect-textures';
import type { FirePoint } from '../inferno-particles';
import { useMemo } from 'react';
import type { InfernoBank } from '../../../shared/inferno-state.mjs';
import type { GameEvent } from '../types';
import { indexFireEffects, maxFireSprites } from '../utility-effects';
import UtilitySprites, { effectNoise, spriteVaryings, spriteVertexInputs } from './UtilitySprites';

const flameVertex = `
  ${spriteVertexInputs}
  void main() {
    spriteUv = vec2(position.x, position.y * 0.5 + 0.5);
    effect = aEffect;
    seed = aOrigin.w;
    float standing = 0.77 + 0.23*sin(seed*11.4);
    float width = mix(1.22, 1.34, effect.w);
    vec4 base = modelViewMatrix * vec4(aOrigin.xyz + vec3(0,0.025,0), 1.0);
    // Screen-facing width, upright where possible. Keep the foot fixed while
    // allowing an overhead camera to see the body of the flame.
    vec2 upright = (modelViewMatrix * vec4(0,1,0,0)).xy;
    vec2 vertical = normalize(upright + vec2(0,0.34));
    vec2 right = vec2(vertical.y, -vertical.x);
    vec2 offset = right * (spriteUv.x * width) + vertical * (spriteUv.y * standing * 2.2);
    gl_Position = projectionMatrix * (base + vec4(offset, 0, 0));
  }
`;

const flameFragment = `
  ${spriteVaryings}
  ${effectNoise}
  void main() {
    if (effect.y <= 0.0) discard;
    float t = effect.x;
    float h = spriteUv.y, x = spriteUv.x;
    vec2 flow = vec2(x*4.3 + seed, h*4.4 - 2.85*t);
    float broad = noise(flow);
    float fine = noise(flow * 2.6 + vec2(13.6, -t));
    float fold = noise(vec2(seed + 2.1, h*3.3 - t*2.3));
    float curl = (fold-0.5)*0.65*h;
    float left = x + 0.27 + curl + 0.13*sin(t*5.0+seed);
    float right = x - 0.26 - curl*0.72 + 0.12*sin(t*4.2-seed);
    float rise = 1.05 + 0.28*sin(t*2.8 + seed);
    float a = 1.0 - abs(left)*(1.84+1.72*h) - h*rise;
    float b = 1.0 - abs(right)*(1.89+1.93*h) - h*(2.64-rise);
    float fuel = max(a,b) + (broad-0.48)*0.60 + (fine-0.5)*0.29;
    float footHeight = 0.05 + 0.10*noise(vec2(x*6.0 + seed,t*2.4));
    float root = smoothstep(0.0,0.115,h-footHeight);
    float tongues = smoothstep(0.01, 0.40, fuel) * root
      * (1.0-smoothstep(0.63,0.97,h)) * (0.67 + 0.29*fine);
    float heat = smoothstep(0.06,0.61,fuel) * exp(-h*1.64)
      * (0.56 + broad*0.55);
    vec3 red = vec3(0.77,0.060,0.006), orange = vec3(1.0,0.29,0.022);
    vec3 gold = vec3(1.0,0.79,0.24);
    vec3 rgb = mix(red, orange, smoothstep(0.06,0.48,heat));
    rgb = mix(rgb, gold, smoothstep(0.49,0.83,heat));
    // Small isolated glints rising above the flame, driven by demo age.
    vec2 emberCell = vec2((x + curl) * 7.0, h * 7.0 - t*2.2);
    float ember = (1.0-smoothstep(0.04,0.22,length(fract(emberCell)-0.5)))
      * step(0.82,hash(floor(emberCell)+seed)) * smoothstep(0.28,0.5,h)
      * (1.0-smoothstep(0.66,0.98,h)) * (1.0-smoothstep(0.26,0.63,abs(x)));
    rgb = mix(rgb, gold, ember);
    float edge = 1.0 - smoothstep(0.76,1.0,abs(x));
    gl_FragColor = vec4(rgb, edge * effect.y * max(tongues, ember*0.78));
    #include <colorspace_fragment>
  }
`;

const scorchVertex = `
  ${spriteVertexInputs}
  void main() {
    spriteUv = position.xy;
    effect = aEffect;
    seed = aOrigin.w;
    float size = mix(1.40, 1.52, effect.w);
    vec3 plane = vec3(spriteUv.x*size, 0.032, -spriteUv.y*size);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(aOrigin.xyz + plane, 1);
  }
`;

const scorchFragment = `
  ${spriteVaryings}
  ${effectNoise}
  void main() {
    float grain = noise(spriteUv*9.5 + seed);
    float r = length(spriteUv) + 0.28*(noise(spriteUv*3.8+seed)-0.5);
    float dark = (1.0-smoothstep(0.19,0.89,r)) * mix(0.44,0.71,grain);
    float ember = (1.0-smoothstep(0.02,0.44,r)) * (0.21 + 0.53*grain) * effect.y;
    vec3 rgb = mix(vec3(0.024,0.011,0.008), vec3(0.89,0.19,0.023), ember);
    gl_FragColor = vec4(rgb, max(dark * effect.z, ember) * (1.0-smoothstep(0.86,1.0,length(spriteUv))));
    #include <colorspace_fragment>
  }
`;

const officialLayers = [
  'fire-ground',
  'fire-flame',
  'fire-glow',
  'fire-ember',
  'fire-smoke',
  'fire-scorch',
];
// The scorch outlives the flames by the official end-cap's few seconds.
const scorchSeconds = 6;

export default function InfernoEffects({
  infernos,
  warm,
  lighting,
  events,
  tick,
  rate,
  reducedMotion,
  displayScale,
}: {
  infernos?: InfernoBank;
  warm: boolean;
  lighting: boolean;
  events: GameEvent[];
  tick: number;
  rate: number;
  reducedMotion: boolean;
  /** The native grade's display scale; official particles need the native world. */
  displayScale?: number;
}) {
  const at = useMemo(() => indexFireEffects(infernos, events, rate), [infernos, events, rate]);
  const textures = useEffectTextures(displayScale !== undefined, officialLayers);
  const official = officialLayers.every((id) => textures[id]);
  const points = useMemo<FirePoint[]>(
    () =>
      official
        ? at.points(tick, tick - scorchSeconds * rate).map(({ position, seed, from, until }) => ({
            position,
            seed,
            from: from / rate,
            until: until / rate,
          }))
        : [],
    [official, at, tick, rate],
  );
  const sprites = useMemo(
    () => (official ? [] : at(tick, reducedMotion)),
    [official, at, tick, reducedMotion],
  );
  if (official)
    return (
      <InfernoParticles
        points={points}
        // Reduced motion holds the flames on one sampled moment.
        time={reducedMotion ? Math.floor(tick / rate) : tick / rate}
        textures={textures}
        displayScale={displayScale ?? 1}
      />
    );
  return (
    <>
      <UtilitySprites
        name="inferno-scorch"
        capacity={maxFireSprites}
        warm={warm}
        lighting={lighting}
        sprites={sprites}
        vertexShader={scorchVertex}
        fragmentShader={scorchFragment}
        renderOrder={2}
      />
      <UtilitySprites
        name="inferno-flames"
        capacity={maxFireSprites}
        warm={warm}
        lighting={lighting}
        sprites={sprites}
        count={sprites.some((sprite) => sprite.strength > 0) ? sprites.length : 0}
        vertexShader={flameVertex}
        fragmentShader={flameFragment}
        renderOrder={3}
      />
    </>
  );
}
