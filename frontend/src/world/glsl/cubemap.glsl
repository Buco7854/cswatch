// Renderer/Shaders/common/envmap.slang, cube face selection.
// Adapted from ValveResourceFormat 21.1 (MIT). See tools/cs2export/THIRD_PARTY_NOTICES.txt.

vec3 cubeUv(vec3 direction, int cubeIndex) {
  vec3 magnitude = abs(direction);
  vec2 faceUv;
  int face;
  float majorAxis;
  if (magnitude.x >= magnitude.y && magnitude.x >= magnitude.z) {
    majorAxis = magnitude.x;
    face = direction.x > 0. ? 0 : 1;
    faceUv = vec2(direction.x > 0. ? -direction.z : direction.z, -direction.y);
  } else if (magnitude.y >= magnitude.z) {
    majorAxis = magnitude.y;
    face = direction.y > 0. ? 2 : 3;
    faceUv = vec2(direction.x, direction.y > 0. ? direction.z : -direction.z);
  } else {
    majorAxis = magnitude.z;
    face = direction.z > 0. ? 4 : 5;
    faceUv = vec2(direction.z > 0. ? direction.x : -direction.x, -direction.y);
  }
  return vec3(.5 + .5 * faceUv / max(majorAxis, 1e-8), float(cubeIndex * 6 + face));
}
