// Renderer/Shaders/csgo/{csgo_environment,csgo_environment_blend,csgo_complex,csgo_glass,csgo_foliage}.slang
// and common lighting. Adapted from ValveResourceFormat 21.1 (MIT). See
// tools/cs2export/THIRD_PARTY_NOTICES.txt.

// One RGBA32F table holds material rows, this world's probe rows and its cell list.
uniform highp sampler2D sceneData;
uniform int probeBase;
uniform int cellColumn;
uniform vec3 gridMin;
uniform vec3 gridInv;
uniform sampler2DArray brdf;
// Per-variant material role slots replace this line.
#pragma roles
#ifdef PACKED_LIGHTING
// Phone packs carry irradiance, direction and sun shadow as layers 0-2 of one array.
uniform sampler2DArray lightAtlas;
#define irradiance lightAtlas
#define directional lightAtlas
#define shadowMap lightAtlas
#define lpvShadow lpv
const float irradianceLayer = 0., directionLayer = 1., shadowLayer = 2.;
#else
uniform sampler2DArray irradiance;
uniform sampler2DArray directional;
uniform sampler2DArray shadowMap;
uniform sampler2DArray lpvShadow;
const float irradianceLayer = 0., directionLayer = 0., shadowLayer = 0.;
#endif
uniform sampler2DArray envMap;
uniform mat4 inverseViewProjection;
// Foliage and alpha-tested surfaces dissolve within this many inches of a third-person camera.
uniform float nearFade;
#ifdef WATER
uniform highp sampler2D sceneDepth;
#endif
uniform sampler2DArray skyMap;
uniform sampler2DArray lpv;
// Probe volume first layer and layer count, then sun occlusion first layer and count.
uniform vec4 volumeLayers;
// Phone log-encoding ranges for irradiance, cubemaps, sky and probe volumes. Zero means linear
// HDR storage.
uniform vec4 hdrRange;
uniform vec3 eye;
uniform vec3 sunDir;
uniform vec3 sunColor;
uniform vec4 fogDist;
uniform vec4 fogHeight;
uniform float envLastMip;
uniform vec4 gradientColor;
uniform vec4 gradientScale;
uniform vec2 gradientExponents;
uniform int mode;
uniform mat4 localFromWorld;
in vec3 worldPosition;
in vec3 vertexNormal;
in vec4 vertexTangent;
in vec4 textureCoords;
in vec4 vertexColor;
in vec4 blendColor;
in vec4 drawTint;
in vec2 lightmapUv;
in vec2 chartNoise;
flat in ivec4 binding;
out vec4 pixel;
uniform bool hasActorShadow;
uniform highp sampler2DShadow actorShadow;
uniform mat4 actorProjection;
uniform float actorBias;

float actorVisibility() {
  if (!hasActorShadow) return 1.0;
  vec4 clip = actorProjection * vec4(worldPosition, 1.0);
  vec3 uv = clip.xyz / clip.w * 0.5 + 0.5;
  if (any(lessThanEqual(uv,vec3(0))) || any(greaterThanEqual(uv,vec3(1)))) return 1.0;
  return texture(actorShadow,vec3(uv.xy,uv.z-actorBias));
}
vec4 materialRow(int x) {
  return texelFetch(sceneData, ivec2(x, binding.x), 0);
}
vec4 probeRow(int x, int probeIndex) {
  return texelFetch(sceneData, ivec2(x, probeBase + probeIndex), 0);
}
vec3 hdr(vec4 value, float range) {
  // Phone ASTC stores HDR channels as log2(1 + 1023 v / range) / 10.
  return range > 0. ? (exp2(value.rgb * 10.) - 1.) / 1023. * range : value.rgb;
}

vec4 sampleLayer(sampler2DArray tex, vec2 uv, float layer, vec4 fallback) {
  return layer < 0. ? fallback : texture(tex, vec3(uv, layer));
}
vec3 decodeTangentNormal(vec2 v) {
  vec2 h = vec2(v.x + v.y - 1.003922, v.x - v.y);
  return normalize(vec3(h.x, -h.y, 1. - abs(h.x) - abs(h.y)));
}
vec4 sampleProbeVolume(sampler2DArray tex, vec3 uv, float face, vec2 layers) {
  float depth = layers.y / face;
  float z = clamp(uv.z * depth - .5, 0., layers.y - 1.);
  return mix(texture(tex, vec3(uv.xy, layers.x + floor(z))),
             texture(tex, vec3(uv.xy, layers.x + min(layers.y - 1., floor(z) + 1.))), fract(z));
}
float sampleShadowAtlas(vec2 uv) {
  vec2 size = vec2(textureSize(shadowMap, 0).xy);
  if (min(fwidth(chartNoise).x, fwidth(chartNoise).y) <= .1 || size.x <= 4096.)
    return textureLod(shadowMap, vec3(uv, shadowLayer), 0.).r;
  vec2 p = uv * size - .5;
  vec2 f = fract(p);
  vec2 f2 = f * f;
  vec2 f3 = f2 * f;
  vec2 w0 = (-f3 + 3. * f2 - 3. * f + 1.) / 6.;
  vec2 w1 = (3. * f3 - 6. * f2 + 4.) / 6.;
  vec2 w2 = (-3. * f3 + 3. * f2 + 3. * f + 1.) / 6.;
  vec2 w3 = f3 / 6.;
  vec2 a = w0 + w1;
  vec2 b = w2 + w3;
  vec2 lo = (floor(p) + w1 / a - 1.5) / size;
  vec2 hi = (floor(p) + w3 / b + .5) / size;
  return a.x * a.y * textureLod(shadowMap, vec3(lo, shadowLayer), 0.).r +
         b.x * a.y * textureLod(shadowMap, vec3(hi.x, lo.y, shadowLayer), 0.).r +
         a.x * b.y * textureLod(shadowMap, vec3(lo.x, hi.y, shadowLayer), 0.).r +
         b.x * b.y * textureLod(shadowMap, vec3(hi, shadowLayer), 0.).r;
}
vec2 transformUV(vec2 uv, int column) {
  return vec2(dot(vec3(uv, 1.), materialRow(column).xyz),
              dot(vec3(uv, 1.), materialRow(column + 1).xyz));
}
// Renderer/Shaders/common/{envmap,lighting_lpv}.slang. Accumulate the priority-sorted probes in
// this cell.
void sampleEnvironment(vec3 localPosition, int cellRow, vec3 viewDirection, vec3 normal,
                       float roughness, out vec3 environmentLight, out vec3 volumeLight,
                       out float volumeShadow, out vec4 harmonic) {
  vec3 reflectionDir = reflect(-viewDirection, normal);
  environmentLight = vec3(0);
  volumeLight = vec3(0);
  float environmentWeight = .01;
  float volumeWeight = 0.;
  volumeShadow = 0.;
  harmonic = vec4(0);
  for (int entry = 0; entry < 64; entry++) {
    int probeIndex = int(texelFetch(sceneData, ivec2(cellColumn + entry / 4, cellRow), 0)[entry % 4]);
    if (probeIndex < 0)
      break;
    vec3 axisX = probeRow(9, probeIndex).xyz, axisY = probeRow(10, probeIndex).xyz,
         axisZ = probeRow(11, probeIndex).xyz;
    vec3 offset = localPosition - probeRow(0, probeIndex).xyz;
    vec3 local = vec3(dot(axisX, offset), dot(axisY, offset), dot(axisZ, offset));
    vec3 boxMin = probeRow(1, probeIndex).xyz;
    vec3 boxMax = probeRow(2, probeIndex).xyz;
    vec3 edge = min(local - boxMin, boxMax - local);
    vec3 inverseFade = 1. / max(vec3(.000001), probeRow(8, probeIndex).xyz);
    vec3 fade = edge * inverseFade;
    float weight = smoothstep(0., 1., min(min(fade.x, fade.y), fade.z)) * (1. - environmentWeight);
    if (weight > 0.) {
      vec3 ray = vec3(dot(axisX, reflectionDir), dot(axisY, reflectionDir), dot(axisZ, reflectionDir));
      vec3 nearPlane = (boxMin - local) / (ray + vec3(1e-10));
      vec3 farPlane = (boxMax - local) / (ray + vec3(1e-10));
      vec3 hit = max(nearPlane, farPlane);
      vec3 projected = local + ray * abs(min(min(hit.x, hit.y), hit.z));
      vec3 projectedDirection = axisX * projected.x + axisY * projected.y + axisZ * projected.z;
      environmentLight +=
          hdr(textureLod(envMap,
                         cubeUv(mix(projectedDirection, reflectionDir, roughness), probeIndex),
                         roughness * envLastMip),
              hdrRange.y) *
          weight;
      harmonic += probeRow(5, probeIndex) * weight;
      environmentWeight += weight;
    }
    if (binding.z == 0 && volumeWeight <= .99) {
      vec3 probeFade = (edge + .1) * inverseFade;
      weight =
          smoothstep(0., 1., min(min(probeFade.x, probeFade.y), probeFade.z)) * (1. - volumeWeight);
      if (weight > 0.) {
        vec3 boxUv = clamp((local - boxMin) / (boxMax - boxMin), 0., 1.);
        vec3 size = probeRow(4, probeIndex).xyz;
        vec3 atlasOffset = probeRow(3, probeIndex).xyz;
        vec3 atlasSize = vec3(vec2(textureSize(lpvShadow, 0).xy), volumeLayers.w);
        vec3 atlasUv = (clamp(boxUv * size, vec3(.5), size - .5) + atlasOffset) / atlasSize;
        for (int axis = 0; axis < 3; axis++) {
          float face = float(axis) + (normal[axis] <= 0. ? 3. : 0.);
          volumeLight += hdr(sampleProbeVolume(lpv, vec3(atlasUv.xy, atlasUv.z + face), 6.,
                                               volumeLayers.xy),
                             hdrRange.w) *
                         normal[axis] * normal[axis] * weight;
        }
        volumeShadow +=
            sampleProbeVolume(lpvShadow, (boxUv * size + atlasOffset) / atlasSize, 1.,
                              volumeLayers.zw)
                .r *
            weight;
        volumeWeight += weight;
      }
    }
    if (environmentWeight > .99 && (binding.z == 1 || volumeWeight > .99))
      break;
  }
  environmentLight /= environmentWeight;
  harmonic /= environmentWeight;
}

// Renderer/Shaders/common/lighting.slang. Directional irradiance and baked sun occlusion.
void sampleBakedLighting(vec3 geometryNormal, vec3 tangentNormal, vec3 volumeLight,
                         float volumeShadow, out vec3 light, out float sunVisibility) {
  if (binding.z == 1) {
    vec3 irradianceSample = hdr(texture(irradiance, vec3(lightmapUv, irradianceLayer)), hdrRange.x);
    vec3 directionSample = texture(directional, vec3(lightmapUv, directionLayer)).rgb;
    vec2 directionXY = directionSample.xy * 2. - 1.;
    const float cap = .99619;
    directionXY *= cap / max(cap, length(directionXY));
    float directionZ = sqrt(max(.00001, 1. - dot(directionXY, directionXY)));
    float curvature = length(fwidth(geometryNormal)) / max(.000001, length(fwidth(worldPosition)));
    float flatness = (1. - smoothstep(.01, .1, curvature)) * .8;
    vec3 lightDirection = normalize(
        vec3(directionXY,
             directionZ * mix(1., mix(.1, 2., clamp((1. - directionZ) * 1.5, 0., 1.)), flatness)));
    vec3 ambient = irradianceSample * directionSample.z;
    light = ambient + (irradianceSample - ambient) * max(0., dot(lightDirection, tangentNormal)) /
                          lightDirection.z;
    sunVisibility = 1. - sampleShadowAtlas(lightmapUv);
  } else {
    light = volumeLight;
    sunVisibility = 1. - volumeShadow;
  }
}

// Renderer/Shaders/common/fog.slang. Apply height/distance gradient and cubemap fog in linear
// light.
vec3 applyFog(vec3 lit) {
  if (gradientColor.a > 0.) {
    vec2 factors =
        vec2(length(worldPosition - eye), worldPosition.z) * gradientScale.zw + gradientScale.xy;
    if (factors.x > 0. && factors.y > 0.) {
      factors = pow(clamp(factors, .0001, 1.), gradientExponents);
      lit = mix(lit, gradientColor.rgb, factors.x * factors.y * gradientColor.a);
    }
  }
  float distTerm =
      pow(max(0., (length(worldPosition - eye) - fogDist.x) / max(1., fogDist.y - fogDist.x)),
          fogDist.z);
  float heightTerm =
      pow(clamp((fogHeight.y - worldPosition.z) / max(1., fogHeight.y - fogHeight.x), 0., 1.),
          fogHeight.z);
  float fog = clamp(distTerm, 0., 1.) * heightTerm * fogDist.w;
  lit = mix(lit,
            hdr(textureLod(skyMap, cubeUv(worldPosition - eye, 0),
                           clamp(1. - fog * fogHeight.w, 0., 1.) *
                               (log2(float(textureSize(skyMap, 0).x)) - 3.)),
                hdrRange.z),
            fog);
  return lit;
}

void main() {
  vec4 layers = materialRow(0);
  vec4 additionalLayers = materialRow(1);
  vec4 flags = materialRow(2);
  vec4 baseTint = materialRow(3);
  vec4 surfaceParams = materialRow(4);
  vec4 uvTransform = materialRow(5);
  vec4 detail = materialRow(6);
  vec2 uv = (materialRow(8).z > 0. ? textureCoords.zw : textureCoords.xy) * uvTransform.xy +
            uvTransform.zw;
  vec2 normalUv = materialRow(29).x > 0. ? transformUV(textureCoords.xy, 27) : uv;
  if (materialRow(29).y > 0.) {
    uv = transformUV(uv, 17);
    normalUv = transformUV(uv, 19);
  }
  vec4 albedo = sampleLayer(colorTex, uv, layers.x, vec4(1));
  vec4 normalSample = sampleLayer(normalTex, normalUv, layers.y, vec4(.50196, .50196, 1., 0.));
  float blend = blendColor.r;
  if (additionalLayers.y >= 0.) {
    vec4 blendMod = sampleLayer(blendTex, transformUV(uv, 25), additionalLayers.y, vec4(.5));
    float mask = materialRow(10).w == 3. ? blendMod.a : blendMod.g;
    float width = max(.0001, materialRow(10).w == 1. ? blendMod.r : surfaceParams.z);
    blend = smoothstep(max(0., mask - width), min(1., mask + width), blend);
  }
  albedo.rgb *= materialRow(7).rgb;
  if (layers.w >= 0.) {
    albedo = mix(albedo,
                 sampleLayer(color2Tex, transformUV(uv, 21), layers.w, vec4(1)) *
                     vec4(materialRow(9).rgb, 1),
                 blend);
    normalSample =
        mix(normalSample,
            sampleLayer(normal2Tex, transformUV(uv, 23), additionalLayers.x, normalSample), blend);
  }
  vec2 secondary = materialRow(29).z > 0. ? textureCoords.zw : uv;
  if (materialRow(31).z > 0.) {
    vec4 detailTransform = materialRow(34);
    vec2 coords = secondary * materialRow(33).xy;
    coords =
        mat2(detailTransform.z, detailTransform.w, -detailTransform.w, detailTransform.z) * coords +
        detailTransform.xy;
    float mask =
        max(sampleLayer(detailMask, secondary, materialRow(30).y, vec4(1)).r, materialRow(33).w) *
        materialRow(33).z;
    albedo.rgb *= mix(
        vec3(1), sampleLayer(detailTex, coords, additionalLayers.z, vec4(.5)).rgb * 1.9922, mask);
  } else if (additionalLayers.z >= 0.)
    albedo.rgb *=
        mix(vec3(1), sampleLayer(detailTex, uv * detail.xy, additionalLayers.z, vec4(.5)).rgb * 2.,
            detail.z);
  albedo.rgb *=
      baseTint.rgb *
      mix(vec3(1), pow(drawTint.rgb, vec3(2.2)),
          surfaceParams.y * (materialRow(16).z > 0.
                                 ? sampleLayer(aux1, secondary, materialRow(10).y, vec4(1)).r
                                 : 1.));
  if (surfaceParams.w > 0. && dot(vertexColor, vertexColor) > 0.)
    albedo.rgb *= vertexColor.rgb;
  float alpha = albedo.a * drawTint.a * flags.w;
  if (flags.x > 0. && alpha < surfaceParams.x)
    discard;
  if (nearFade > 0. && (flags.x > 0. || flags.z == 5.)) {
    float keep = smoothstep(nearFade * .35, nearFade, distance(worldPosition, eye));
    float dither = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(.06711056, .00583715))));
    if (dither > keep)
      discard;
  }
  if (flags.y < .5)
    alpha = 1.;
  vec3 viewDirection = normalize(eye - worldPosition);
  vec3 geometryNormal = normalize(vertexNormal);
  vec3 tangentVector = normalize(vertexTangent.xyz);
  vec3 bitangent = normalize(cross(geometryNormal, tangentVector)) * vertexTangent.w;
  if (materialRow(29).w > 0. && !gl_FrontFacing)
    geometryNormal = -geometryNormal;
  vec3 tangentNormal =
      normalize(mix(vec3(0, 0, 1), decodeTangentNormal(normalSample.rg), materialRow(16).w));
  vec3 normal = normalize(tangentVector * tangentNormal.x + bitangent * tangentNormal.y +
                          geometryNormal * tangentNormal.z);
  vec3 localPosition = (localFromWorld * vec4(worldPosition, 1.)).xyz;
  ivec3 cell = clamp(ivec3(floor((localPosition - gridMin) * gridInv)), ivec3(0), ivec3(15, 15, 7));
  int cellRow = cell.x + 16 * (cell.y + 16 * cell.z);
  float roughness = clamp(max(sampleLayer(roughTex, uv, materialRow(31).x, vec4(normalSample.b)).r,
                              pow(clamp(max(dot(dFdx(geometryNormal), dFdx(geometryNormal)),
                                            dot(dFdy(geometryNormal), dFdy(geometryNormal))),
                                        0., 1.),
                                  .333)),
                          .02, 1.);
  // csgo_water_fancy reflects the cubemap at its minimum roughness.
  if (flags.z == 7.)
    roughness = clamp(materialRow(35).y, .02, 1.);
  vec3 environmentLight;
  vec3 volumeLight;
  float volumeShadow;
  vec4 harmonic;
  sampleEnvironment(localPosition, cellRow, viewDirection, normal, roughness, environmentLight,
                    volumeLight, volumeShadow, harmonic);
  vec3 direct;
  vec3 light;
  float sunVisibility;
  sampleBakedLighting(geometryNormal, tangentNormal, volumeLight, volumeShadow, light,
                      sunVisibility);
  direct = sunColor * actorVisibility() * sunVisibility * max(0., dot(normal, sunDir));
  float occlusion = sampleLayer(aoTex, secondary, layers.z, vec4(1)).r;
  if (layers.w >= 0.)
    occlusion = mix(occlusion,
                    sampleLayer(ao2Tex, transformUV(uv, 21), materialRow(30).z, vec4(1)).r, blend);
  if (materialRow(35).x > 0.)
    occlusion = min(mix(1., 2. * occlusion, materialRow(35).x), 1.);
  float metalness = sampleLayer(metalTex, uv, additionalLayers.w, vec4(materialRow(8).x)).g;
  if (flags.z == 6.) {
    vec4 h = sampleLayer(heightTex, uv, materialRow(30).w, vec4(1));
    occlusion = flags.x > 0. ? h.b : albedo.a;
    metalness = h.a * materialRow(31).w;
  }
  vec3 specularColor = mix(vec3(.04), albedo.rgb, metalness);
  vec4 lut = textureLod(
      brdf,
      vec3(vec2(roughness, sqrt(1. - clamp(dot(normal, viewDirection), 0., 1.))) * 63. / 64. +
               .5 / 64.,
           1.),
      0.);
  vec3 fresnel = mix(vec3(lut.x), vec3(lut.y), specularColor);
  float bakedLuminance = dot(vec4(normal, 1.), harmonic);
  if (bakedLuminance > 0.)
    environmentLight *= min(dot(light, vec3(.2126, .7152, .0722)) / bakedLuminance, 1.);
  vec3 averageSpecular = specularColor + (1. - specularColor) / 21.;
  fresnel += fresnel * averageSpecular * (1. - lut.y) / (1. - averageSpecular * (1. - lut.y));
  if (materialRow(16).x == 0.)
    fresnel = vec3(0);
  vec3 lit = albedo.rgb * (1. - metalness) * (light * occlusion + direct) +
             environmentLight * fresnel * occlusion;
  if (materialRow(16).y > 0.) {
    vec3 halfVector = normalize(sunDir + viewDirection);
    float normalHalf = max(0., dot(normal, halfVector));
    float normalView = max(0., dot(normal, viewDirection));
    float normalLight = max(0., dot(normal, sunDir));
    float alphaRoughness = max(.0001, roughness * roughness);
    float distribution =
        min(alphaRoughness / (1. - normalHalf * normalHalf +
                              normalHalf * normalHalf * alphaRoughness * alphaRoughness),
            453.5);
    float geometryTerm = (roughness + 1.) * (roughness + 1.) * .125;
    vec3 reflectance = specularColor +
                       (1. - specularColor) * pow(1. - max(0., dot(viewDirection, halfVector)), 5.);
    lit +=
        direct * reflectance * distribution * distribution /
        (4. * max(.0001, mix(normalView, 1., geometryTerm) * mix(normalLight, 1., geometryTerm)));
  }
  vec3 emission = vec3(0);
  if (materialRow(31).y > 0.)
    emission = materialRow(32).rgb *
               sampleLayer(illumTex, secondary, materialRow(30).x, vec4(0)).rgb *
               mix(vec3(1), albedo.rgb, materialRow(32).a);
  lit += emission;
  if (flags.z == 1.)
    lit = albedo.rgb;
  if (flags.z == 2.) {
    vec4 dust = sampleLayer(aux0, uv, materialRow(10).x, vec4(0));
    float opacity = mix(materialRow(15).x, materialRow(15).y, dust.a * drawTint.a);
    float normalView = max(0., dot(viewDirection, geometryNormal));
    float reflectance = .04 + .96 * pow(1. - max(0., dot(viewDirection, normal)), 5.);
    vec3 transmit = (1. - reflectance) *
                    pow(albedo.rgb, vec3(inversesqrt(1. - (1. - normalView * normalView) / 2.25))) *
                    (1. - opacity);
    alpha = max(1. - dot(transmit, vec3(.2126, .7152, .0722)), 1. / 255.);
    lit = (dust.rgb * (light + direct) * opacity * (1. + transmit * pow(albedo.rgb, vec3(1.6))) +
           environmentLight * fresnel) /
          alpha;
  }
  if (flags.z == 4.) {
    vec4 mask = materialRow(10);
    vec4 maskScale = materialRow(11);
    vec4 effectParams = materialRow(12);
    vec4 fade = materialRow(13);
    vec4 fresnelRange = materialRow(14);
    alpha *= sampleLayer(aux0, uv * maskScale.xy, mask.x, vec4(1)).r *
             sampleLayer(aux1, uv * maskScale.zw, mask.y, vec4(1)).r *
             sampleLayer(aux2, uv * effectParams.xy, mask.z, vec4(1)).r * vertexColor.a;
    alpha *= mix(fresnelRange.x, fresnelRange.y,
                 clamp(pow(max(dot(viewDirection, geometryNormal), 0.), fade.w) * fresnelRange.z,
                       0., 1.)) *
             pow(mix(fade.x, fade.y,
                     clamp(length(localPosition - (localFromWorld * vec4(eye, 1.)).xyz) /
                               max(.001, effectParams.w),
                           0., 1.)),
                 fade.z);
    lit = albedo.rgb * effectParams.z;
  }
  if (flags.z == 5. && materialRow(15).w > 0.)
    lit += sunColor * sunVisibility * max(0., -dot(normal, sunDir)) *
           (materialRow(15).z > 0. ? albedo.rgb
                                   : sampleLayer(aux0, uv, materialRow(10).x, vec4(0)).rgb);
  if (flags.z == 3.)
    lit = vec3(0);
  if (mode == 5)
    lit = albedo.rgb + emission;
#ifdef WATER
  // Renderer/Shaders/csgo/csgo_water_fancy.frag.slang without waves, foam, debris, caustics and
  // screen-space reflection: the water column behind the surface fogs and decays the scene, and
  // the cubemap reflection mixes in by Fresnel. Blending over the opaque scene stands in for
  // refraction.
  if (flags.z == 7.) {
    vec4 decayParams = materialRow(9), fogParams = materialRow(33);
    float behindDepth = texelFetch(sceneDepth, ivec2(gl_FragCoord.xy), 0).r;
    vec4 behind = inverseViewProjection *
                  vec4(gl_FragCoord.xy / vec2(textureSize(sceneDepth, 0)) * 2. - 1.,
                       behindDepth * 2. - 1., 1.);
    float column = behindDepth >= 1.
                       ? fogParams.y
                       : min(fogParams.y, max(0., distance(behind.xyz / behind.w, eye) -
                                                      distance(worldPosition, eye)) *
                                              .01);
    float fogAlpha = 1. - exp(-column * fogParams.x);
    vec3 decay = exp((decayParams.rgb - 1.) * decayParams.a * column);
    vec3 fogColor = baseTint.rgb * mix(decay, vec3(1), clamp(fogParams.x * .04, 0., 1.));
    vec3 emitted = fogColor * fogAlpha * fogParams.z * (light * occlusion + direct);
    float facing = pow(1. - clamp(dot(viewDirection, normal), 0., 1.), materialRow(34).x);
    float reflectionMix = clamp((facing * (1. - fogParams.w) + fogParams.w) * 1.5, 0., 1.);
    float transmitted = dot(decay * (1. - fogAlpha), vec3(1. / 3.));
    alpha = 1. - (1. - reflectionMix) * transmitted;
    lit = ((1. - reflectionMix) * emitted + reflectionMix * environmentLight) / max(alpha, .001);
  }
#endif
  lit = applyFog(lit);
  if (mode == 1)
    lit = albedo.rgb;
  else if (mode == 2)
    lit = normal * .5 + .5;
  else if (mode == 3)
    lit = light;
  else if (mode == 4)
    lit = environmentLight;
  if (mode == 7) {
    int id = binding.x + 1;
    pixel = vec4(float(id & 255), float(id >> 8), 255., 255.) / 255.;
  } else
    pixel = vec4(max(lit, vec3(0)), alpha);
}
