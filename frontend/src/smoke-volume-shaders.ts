import {
  BLAST_REACH,
  GRID,
  CELL,
  INCH,
  MAX_HOLES,
  MAX_SMOKE_STEPS,
  REVEAL_SECONDS,
  SMOKE_DENSITY_SCALE,
  SMOKE_STEP,
} from './smoke-field';
import { WORLEY_CELLS } from './smoke-noise';
import probeShader from './world/glsl/actor-probes.glsl?raw';

export const LIGHT_CELLS = 16;
const glslFloat = (value: number) => (Number.isInteger(value) ? value.toFixed(1) : String(value));
export const quadVertex = /* glsl */ `
  uniform vec4 clipRect;
  varying vec2 localUv;
  void main() {
    localUv = position.xy + 0.5;
    gl_Position = vec4(mix(clipRect.xy, clipRect.zw, localUv), 0.0, 1.0);
  }
`;

const depthFunctions = /* glsl */ `
  uniform sampler2D opaqueDepth;
  uniform vec2 cameraRange;
  uniform vec4 depthRect;

  float eyeDepth(vec2 uv) {
    float d = texture2D(opaqueDepth, mix(depthRect.xy, depthRect.zw, uv)).r;
    return cameraRange.x * cameraRange.y / mix(cameraRange.y, cameraRange.x, d);
  }
`;

// Ported from the CS2 smoke volume pixel shader (smoke_volume.vfx, D_SMOKE_INSTANCES=1):
// four-inch samples, cellular-noise erosion, per-sample alpha, light from the
// map's probe volume facing away from the cloud centre, a sun lobe on the
// sun-facing side of the cloud, and recorded HE blasts clearing the volume.
export const marchFragment = /* glsl */ `
  precision highp sampler3D;
  uniform sampler3D previousField, currentField, lightVolume, worley;
  uniform vec4 screenRect;
  uniform mat4 inverseProjection, cameraWorld;
  uniform vec3 origin, boxMin, boxMax, sunDirection, sunColor;
  uniform float fieldMix, amount, fieldScale, age, stepSize;
  uniform vec4 blasts[${MAX_HOLES}];
  varying vec2 localUv;
  ${depthFunctions}

  const float inch = ${glslFloat(INCH)};
  const float span = ${glslFloat(GRID * CELL)};

  float cellular(vec3 p) { return texture(worley, p / ${glslFloat(WORLEY_CELLS)}).r; }

  void main() {
    gl_FragColor = vec4(0.0);
    vec2 uv = mix(screenRect.xy, screenRect.zw, localUv);
    vec3 viewRay = normalize((inverseProjection * vec4(uv * 2.0 - 1.0, -1.0, 1.0)).xyz);
    vec3 ray = mat3(cameraWorld) * viewRay;
    vec3 eye = cameraWorld[3].xyz;
    // Finite reciprocal for axis-aligned rays, including an eye on a slab.
    vec3 inv = (step(vec3(0.0), ray) * 2.0 - 1.0) / max(abs(ray), vec3(0.000001));
    vec3 a = (boxMin - eye) * inv, b = (boxMax - eye) * inv;
    vec3 first = min(a, b), last = max(a, b);
    float begin = max(max(first.x, first.y), max(first.z, cameraRange.x / -viewRay.z));
    float volumeEnd = min(min(last.x, last.y), last.z);
    float surface = eyeDepth(localUv) / -viewRay.z;
    // The shader stops two inches in front of opaque surfaces.
    float end = min(volumeEnd, surface - 2.0 * inch);
    if (end <= begin) return;

    float stride = max(stepSize, (end - begin) / ${glslFloat(MAX_SMOKE_STEPS)});
    float power = stride / ${glslFloat(SMOKE_STEP)};
    // Like the game, sample every four inches; interleave only a lengthened stride.
    float jitter = stride > ${glslFloat(SMOKE_STEP * 1.001)}
      ? fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))))
      : 0.5;
    float span3 = span * fieldScale;
    vec4 sum = vec4(0.0);
    for (int i = 0; i < ${MAX_SMOKE_STEPS}; ++i) {
      float t = begin + stride * (float(i) + jitter);
      if (t >= end) break;
      vec3 position = eye + t * ray;
      vec3 relative = position - origin;
      vec3 cell = relative / span3 + 0.5;
      float density = mix(texture(previousField, cell).r, texture(currentField, cell).r, fieldMix) *
                      ${glslFloat(SMOKE_DENSITY_SCALE)};
      if (density <= 0.01) continue;
      // Grid coordinates in Source axes (x, -z, y).
      vec3 grid = vec3(cell.x, 1.0 - cell.z, cell.y);
      float ripple = max(0.5, clamp((abs(sin(grid.x * 18.84 + age * 0.7)) +
                                     abs(cos(grid.y * 31.4 + age * 0.5))) * 0.5, 0.0, 1.0));
      float value = clamp((density - 0.01) * 1.0101, 0.0, 1.0) * ripple * amount;
      value = clamp(value + (1.0 - clamp(t / inch * 0.1, 0.0, 1.0)) * value, 0.0, 1.0);
      float keep = 1.0;
      for (int j = 0; j < ${MAX_HOLES}; ++j) {
        if (blasts[j].w < 0.0) continue;
        float since = blasts[j].w;
        float reach = distance(position, blasts[j].xyz) / inch;
        if (reach >= ${glslFloat(BLAST_REACH / INCH)}) continue;
        float flash = pow(1.0 - smoothstep(0.0, 2.0, since), 128.0);
        float wall = step((end - t) / inch, 16.0) * (1.0 - smoothstep(0.0, 7.0, since));
        keep = min(keep, max(smoothstep(200.0, 240.0, reach + flash * 250.0) +
                             pow(smoothstep(0.5, 5.0, since), 1.8), wall));
      }
      value = mix(value * 0.02, value, keep);
      float growth = age / ${glslFloat(REVEAL_SECONDS)};
      if (growth < 1.0) {
        float g = clamp(growth, 0.0001, 0.9999);
        float low = smoothstep(0.0, 0.8, g), high = smoothstep(0.2, 1.0, g);
        vec3 centred = grid - 0.5;
        centred.z *= 1.2;
        value *= low == high ? g : clamp(smoothstep(low, high, clamp(length(centred), 0.0, 1.0)), 0.0, 1.0);
      }
      // Two octaves of cellular noise in world inches, rising over time.
      vec3 source = vec3(position.x, -position.z, position.y) / inch * 0.01;
      source.z -= age * 0.05;
      float coarse = cellular(source * 2.3);
      source.z -= age * 0.03;
      float fine = cellular(source * 6.0);
      float noise = clamp((1.0 - coarse) * 0.6 + (1.0 - fine) * 0.28 + 0.12, 0.0, 1.0);

      vec4 light = texture(lightVolume, cell);
      float facing = pow(clamp(dot(normalize(relative + vec3(0.0, 0.0001, 0.0)), sunDirection) * 0.8 + 0.2,
                               0.0, 1.0), 2.0) * light.a;
      vec3 color = (light.rgb * (1.0 - value) * 0.5 + sunColor * facing) * noise;
      // The material's g_vSmokeColor is white: its luminance-preserving tint
      // pulls the probe light halfway to grey.
      color = mix(color, vec3(dot(color, vec3(0.2125, 0.7154, 0.0721))), 0.5);
      color = mix(color, color * keep, 0.6);
      float eroded = value - (1.0 - noise);
      float alpha = smoothstep(0.0, 0.2, clamp(mix(eroded, value + noise, value), 0.0, 1.0));
      alpha = 1.0 - pow(1.0 - alpha, power);
      sum += vec4(clamp(color * alpha, 0.0, 1.0), alpha) * (1.0 - sum.a);
      if (sum.a > 0.991) {
        sum.a = 1.0;
        break;
      }
    }
    gl_FragColor = sum;
  }
`;

/** Bake one slice of the cloud's light volume: the map's probe irradiance
 * facing away from the cloud centre, and the probe volume's sun visibility. */
export const lightFragment = /* glsl */ `
  uniform vec3 origin;
  uniform float layer, fieldScale;
  varying vec2 localUv;
  ${probeShader.replace('varying vec3 actorSourcePosition;', 'vec3 actorSourcePosition;')}

  void main() {
    vec3 cell = vec3(localUv, (layer + 0.5) / ${glslFloat(LIGHT_CELLS)});
    vec3 position = origin + (cell - 0.5) * ${glslFloat(GRID * CELL)} * fieldScale;
    actorSourcePosition = vec3(position.x, -position.z, position.y) / ${glslFloat(INCH)};
    vec3 outward = vec3(cell.x - 0.5, 0.5 - cell.z, cell.y - 0.5);
    outward = dot(outward, outward) > 1e-6 ? normalize(outward) : vec3(0.0, 0.0, 1.0);
    vec4 lighting = actorLightingAt(outward);
    gl_FragColor = vec4(max(lighting.rgb, vec3(0.0)), 1.0 - clamp(lighting.a, 0.0, 1.0));
  }
`;

export const compositeFragment = /* glsl */ `
  uniform sampler2D marched;
  uniform vec2 marchSize, targetSize;
  uniform float sceneLightScale;
  varying vec2 localUv;
  ${depthFunctions}

  void main() {
    vec2 point = localUv * marchSize - 0.5;
    vec2 lo = floor(point);
    vec2 f = fract(point);
    float target = eyeDepth(localUv);
    float tolerance = 0.16 + target * 0.012;
    float total = 0.0, softTotal = 0.0;
    vec4 sum = vec4(0.0), softSum = vec4(0.0), closest = vec4(0.0);
    float nearest = 1e20;
    for (int y = 0; y <= 1; ++y) {
      for (int x = 0; x <= 1; ++x) {
        vec2 stepPx = vec2(float(x), float(y));
        vec2 tap = (clamp(lo + stepPx, vec2(0.0), marchSize - 1.0) + 0.5) / marchSize;
        vec2 w = mix(1.0 - f, f, stepPx);
        float diff = abs(eyeDepth(tap) - target);
        float compatible = 1.0 - smoothstep(tolerance, tolerance * 3.0, diff);
        float weight = w.x * w.y * compatible;
        vec4 value = texture2D(marched, tap * marchSize / targetSize);
        if (diff < nearest) {
          nearest = diff;
          closest = value;
        }
        sum += weight * value;
        total += weight;
        softSum += compatible * value;
        softTotal += compatible;
      }
    }
    vec4 value = total > 0.0001 ? sum / total : closest;
    // Reduce low-alpha shimmer without sampling across depth discontinuities
    // or softening the silhouette of an opaque cloud.
    if (total > 0.0001 && softTotal > 0.0001)
      value = mix(softSum / softTotal, value, smoothstep(0.025, 0.32, value.a));
    if (value.a <= 0.002) discard;
    gl_FragColor = vec4(value.rgb * (sceneLightScale / value.a), value.a);
    // Three enables this transform only when the float scene target is unavailable.
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    gl_FragColor.rgb *= gl_FragColor.a;
  }
`;
