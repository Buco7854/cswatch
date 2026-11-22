import { BILLOW_SPAN, EXTINCTION, HALF_GRID, MAX_HOLES } from './smoke-field';

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

export const marchFragment = /* glsl */ `
  precision highp sampler3D;
  uniform sampler3D previousField, currentField, detailField;
  uniform vec4 screenRect;
  uniform mat4 inverseProjection, cameraWorld;
  uniform vec3 origin, boxMin, boxMax, sunDirection, sunColor, tint;
  uniform float fieldMix, amount, fieldScale, drift, stepSize, sunVisibility;
  uniform vec4 blastHoles[${MAX_HOLES}];
  uniform float blastStrength[${MAX_HOLES}];
  varying vec2 localUv;
  ${depthFunctions}

  const float fieldWidth = ${2 * HALF_GRID};
  const float noisePeriod = 5.2;
  vec2 fieldAt(vec3 cell) {
    return mix(texture(previousField, cell).rg, texture(currentField, cell).rg, fieldMix);
  }

  vec3 displacedCell(vec3 cell, vec4 detail, float freedom) {
    return cell + (detail.rgb - 0.5) * (${BILLOW_SPAN} / fieldWidth) * freedom;
  }

  float billowed(float density, vec4 detail) {
    float threshold = 0.07 + 0.35 * (1.0 - smoothstep(0.14, 0.88, detail.r))
                           + 0.075 * (1.0 - detail.a);
    return density * smoothstep(threshold - 0.055, threshold + 0.13, density);
  }

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
    float end = min(volumeEnd, surface);
    if (end <= begin) return;

    float stride = max(stepSize * fieldScale, (end - begin) / 96.0);
    float interleave = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) - 0.5;
    float g = 0.32;
    float phase = (1.0 - g*g) / pow(1.0 + g*g - 2.0*g*dot(ray, sunDirection), 1.5);
    float transmission = 1.0, lastDensity = 0.0;
    vec3 radiance = vec3(0.0);
    float cursor = begin;
    for (int i = 0; i < 96; ++i) {
      float width = min(stride * mix(1.0, 1.35, smoothstep(0.35, 0.77, 1.0 - transmission)), end - cursor);
      if (width <= 0.0 || transmission < 0.004) break;
      float wallDistance = surface <= volumeEnd ? (surface - cursor - width * 0.5) / fieldScale : 5.0;
      float awayFromWall = smoothstep(0.13, 0.80, wallDistance);
      // Use midpoint integration for thin smoke and surface contacts. A small
      // fixed interleaved phase breaks bands only after enough opacity builds.
      float offset = 0.5 + 0.28 * interleave * awayFromWall * smoothstep(0.15, 0.65, 1.0 - transmission);
      float t = cursor + width * offset;
      cursor += width;
      vec3 position = eye + t * ray;
      vec3 relative = (position - origin) / fieldScale;
      vec3 cell = relative / fieldWidth + 0.5;
      vec2 field = fieldAt(cell);
      vec3 p = (relative + vec3(drift * 0.018, -drift * 0.072, drift * 0.031)) / noisePeriod;
      vec4 detail = texture(detailField, p);
      float freedom = mix(0.45, 1.0, awayFromWall) * (1.0 - smoothstep(0.58, 0.86, field.r));
      vec2 shifted = freedom > 0.015 ? fieldAt(displacedCell(cell, detail, freedom)) : field;
      float core = field.r * smoothstep(0.50, 0.71, field.r);
      float density = max(core, billowed(shifted.r, detail));
      if (wallDistance < 0.58) {
        // Keep the last interior density just ahead of an opaque surface.
        // Multiplying the carry by the distance avoids a sharp extra layer.
        density = max(density, lastDensity * (1.0 - smoothstep(0.15, 0.58, wallDistance)));
      }
      lastDensity = density;
      if (density < 0.003) continue;
      for (int j = 0; j < ${MAX_HOLES}; ++j) {
        if (blastStrength[j] > 0.0) {
          float radius = blastHoles[j].w;
          density *= 1.0 - blastStrength[j] * (1.0 - smoothstep(radius * 0.55, radius,
            distance(position, blastHoles[j].xyz)));
        }
      }

      float opacity = 1.0 - exp(-${EXTINCTION} * density * amount * width);
      float beam = mix(shifted.g, field.g, 0.45);
      vec4 sunDetail = texture(detailField, p + sunDirection * (0.43 / noisePeriod));
      vec3 sunCell = cell + sunDirection * (0.43 / fieldWidth);
      float toward = billowed(fieldAt(displacedCell(sunCell, sunDetail, freedom)).r, sunDetail);
      float slope = density - toward + 0.95 * (detail.r - sunDetail.r);
      float facing = smoothstep(-0.14, 0.24, slope);
      float crests = smoothstep(0.20, 0.80, 0.84 * detail.r + 0.16 * detail.a);
      // The diffuse floor is neutral. Regard the sun lobe as stronger on
      // exposed lobes and retain a small broad contribution in the core.
      vec3 ambient = vec3(0.168 + 0.135 * crests + 0.080 * smoothstep(0.43, 1.0, field.r));
      float diffuse = facing * (0.074 + 0.34 * sqrt(beam) * sunVisibility);
      vec3 scatter = mix(vec3(1.0), sunColor, 0.14) * (diffuse + (0.03 + 0.12 * phase) * beam * sunVisibility);
      radiance += transmission * opacity * (ambient + scatter);
      transmission *= 1.0 - opacity;
    }
    vec3 tinted = radiance * tint;
    vec3 luma = vec3(0.2126, 0.7152, 0.0722);
    tinted *= dot(radiance, luma) / max(dot(tinted, luma), 0.000001);
    gl_FragColor = vec4(tinted, 1.0 - transmission);
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
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    gl_FragColor.rgb *= gl_FragColor.a;
  }
`;
