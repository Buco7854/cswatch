// ValveResourceFormat 21.1 (MIT), Renderer/Shaders/common/lighting_lpv.slang.
// The six axial lobes and sun occlusion share the cell list used by the world.
uniform highp sampler2DArray actorIrradiance;
uniform highp sampler2DArray actorSunShadow;
uniform sampler2D actorProbes;
uniform sampler2D actorCells;
uniform vec3 actorGridMin;
uniform vec3 actorGridInv;
varying vec3 actorSourcePosition;

vec4 actorVolume(highp sampler2DArray atlas, vec3 uv, float lobes) {
  float layers = float(textureSize(atlas, 0).z);
  float slice = clamp(uv.z * layers / lobes - 0.5, 0.0, layers - 1.0);
  return mix(texture(atlas, vec3(uv.xy, floor(slice))),
             texture(atlas, vec3(uv.xy, min(layers - 1.0, floor(slice) + 1.0))), fract(slice));
}
vec4 actorLightingAt(vec3 normalSource) {
  ivec3 cell = clamp(ivec3(floor((actorSourcePosition - actorGridMin) * actorGridInv)),
                     ivec3(0), ivec3(15,15,7));
  int row = cell.x + 16 * (cell.y + 16 * cell.z);
  vec4 lighting = vec4(0);
  float coverage = 0.0;
  for (int entry = 0; entry < 64; entry++) {
    int index = int(texelFetch(actorCells, ivec2(entry / 4, row), 0)[entry % 4]);
    if (index < 0 || coverage > 0.99) break;
    vec3 local = actorSourcePosition - texelFetch(actorProbes, ivec2(0,index),0).xyz;
    vec3 low = texelFetch(actorProbes, ivec2(1,index),0).xyz;
    vec3 high = texelFetch(actorProbes, ivec2(2,index),0).xyz;
    vec3 fade = (min(local-low,high-local)+0.1) / max(vec3(0.000001),texelFetch(actorProbes,ivec2(8,index),0).xyz);
    float weight = smoothstep(0.0,1.0,min(fade.x,min(fade.y,fade.z))) * (1.0-coverage);
    if (weight <= 0.0) continue;
    vec3 boxUV = clamp((local-low)/(high-low),0.0,1.0);
    vec3 offset = texelFetch(actorProbes,ivec2(3,index),0).xyz;
    vec3 extent = texelFetch(actorProbes,ivec2(4,index),0).xyz;
    vec3 size = vec3(textureSize(actorSunShadow,0));
    vec3 uv = (clamp(boxUV * extent, vec3(0.5), extent-0.5) + offset) / size;
    for (int axis=0;axis<3;axis++) {
      float face = float(axis) + (normalSource[axis] <= 0.0 ? 3.0 : 0.0);
      lighting.rgb += actorVolume(actorIrradiance,vec3(uv.xy,uv.z+face),6.0).rgb *
                      normalSource[axis] * normalSource[axis] * weight;
    }
    lighting.a += actorVolume(actorSunShadow,(boxUV*extent+offset)/size,1.0).r * weight;
    coverage += weight;
  }
  return lighting;
}
