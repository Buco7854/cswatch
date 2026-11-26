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
uniform mat4 entityTransform;
uniform vec2 lightScale;
// Instanced meshes (SceneAggregate in VRF) read their placement, cubemap, probe volume and tint
// from four texels per instance; other draws use -1 and their vertex attributes.
uniform int instanceBase;
uniform int instanceColumns;
uniform highp usampler2D instanceData;
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
uvec4 instanceTexel(int texel) {
  return texelFetch(instanceData, ivec2(texel % instanceColumns, texel / instanceColumns), 0);
}
void main() {
  uvec2 objectIds = ids;
  uint objectLpv = lpvId;
  drawTint = tint;
  if (instanceBase >= 0) {
    int texel = (instanceBase + gl_InstanceID) * 4;
    uvec4 r0 = instanceTexel(texel), r1 = instanceTexel(texel + 1), r2 = instanceTexel(texel + 2);
    uvec4 lighting = instanceTexel(texel + 3);
    mat4 placement = transpose(mat4(uintBitsToFloat(r0), uintBitsToFloat(r1), uintBitsToFloat(r2), vec4(0., 0., 0., 1.)));
    worldPosition = (placement * vec4(pos, 1.)).xyz;
    vertexNormal = normalize(transpose(inverse(mat3(placement))) * normal);
    vertexTangent = vec4(normalize(mat3(placement) * tangent.xyz), tangent.w);
    objectIds.y = lighting.x & 0xffffu;
    objectLpv = lighting.x >> 16u;
    drawTint = vec4((uvec4(lighting.y) >> uvec4(0u, 8u, 16u, 24u)) & 0xffu) / 255.;
  } else {
    worldPosition = (entityTransform * vec4(pos,1.)).xyz;
    vertexNormal = mat3(entityTransform) * normal;
    vertexTangent = vec4(mat3(entityTransform) * tangent.xyz,tangent.w);
  }
  textureCoords = vec4(uv, uv2);
  vertexColor = paint;
  blendColor = blend;
  uvec2 bits = floatBitsToUint(lightUv);
  bits ^= bits << 13u;
  bits ^= bits >> 17u;
  bits ^= bits << 5u;
  chartNoise = (uintBitsToFloat(0x3F800000u | (bits >> 9u)) - 1.) * 65535.;
  lightmapUv = lightUv * lightScale;
  binding = ivec4(objectIds, baked, objectLpv);
  gl_Position = viewProjection * vec4(worldPosition, 1.);
}
