// Renderer/Shaders/common/baked_lighting_vs.slang, lightmap chart and tangent inputs.
// Adapted from ValveResourceFormat 21.1 (MIT). See tools/cs2export/THIRD_PARTY_NOTICES.txt.

layout(location = 0) in vec3 pos;
layout(location = 1) in vec3 normal;
layout(location = 2) in vec4 tangent;
layout(location = 3) in vec2 uv;
layout(location = 4) in vec2 lightUv;
layout(location = 5) in vec4 paint;
layout(location = 6) in vec4 blend;
layout(location = 7) in vec2 uv2;
layout(location = 8) in uvec2 ids;
layout(location = 11) in uint lpvId;
layout(location = 9) in uint baked;
layout(location = 10) in vec4 tint;
uniform mat4 viewProjection;
uniform vec2 lightScale;
out vec3 worldPosition;
out vec3 vertexNormal;
out vec4 vertexTangent;
out vec4 textureCoords;
out vec4 vertexColor;
out vec4 blendColor;
out vec4 drawTint;
out vec2 lightmapUv;
out vec2 chartNoise;
flat out ivec4 binding;
void main() {
  worldPosition = pos;
  vertexNormal = normal;
  vertexTangent = tangent;
  textureCoords = vec4(uv, uv2);
  vertexColor = paint;
  blendColor = blend;
  drawTint = tint;
  uvec2 bits = floatBitsToUint(lightUv);
  bits ^= bits << 13u;
  bits ^= bits >> 17u;
  bits ^= bits << 5u;
  chartNoise = (uintBitsToFloat(0x3F800000u | (bits >> 9u)) - 1.) * 65535.;
  lightmapUv = lightUv * lightScale;
  binding = ivec4(ids, baked, lpvId);
  gl_Position = viewProjection * vec4(worldPosition, 1.);
}
