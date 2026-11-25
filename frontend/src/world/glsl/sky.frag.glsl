// Renderer/Shaders/csgo/sky.slang, sky environment projection.
// Adapted from ValveResourceFormat 21.1 (MIT). See tools/cs2export/THIRD_PARTY_NOTICES.txt.

in vec2 uv;
out vec4 pixel;
uniform mat4 unproject;
uniform sampler2DArray skyMap;
uniform vec3 eye;
uniform float gain;
void main() {
  vec4 worldPoint = unproject * vec4(uv * 2. - 1., .5, 1.);
  pixel =
      vec4(textureLod(skyMap, cubeUv(worldPoint.xyz / worldPoint.w - eye, 0), 0.).rgb * gain, 1.);
}
