// Renderer/Shaders/csgo/sky.slang, sky environment projection.
// Adapted from ValveResourceFormat 21.1 (MIT). See tools/cs2export/THIRD_PARTY_NOTICES.txt.

in vec2 uv;
out vec4 pixel;
uniform mat4 unproject;
uniform sampler2DArray skyMap;
uniform vec3 eye;
uniform float gain;
uniform float hdrRange;
uniform vec3 background;
void main() {
  vec4 worldPoint = unproject * vec4(uv * 2. - 1., .5, 1.);
  vec4 value = textureLod(skyMap, cubeUv(worldPoint.xyz / worldPoint.w - eye, 0), 0.);
  pixel = vec4((hdrRange > 0. ? (exp2(value.rgb * 10.) - 1.) / 1023. * hdrRange : value.rgb) * gain + background, 1.);
}
