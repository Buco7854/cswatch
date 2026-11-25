// Renderer/Shaders/post_processing.frag.slang, Uncharted curve. The map fixes exposure and grades
// the neutral LUT diagonal. Adapted from ValveResourceFormat 21.1 (MIT). See
// tools/cs2export/THIRD_PARTY_NOTICES.txt.

in vec2 uv;
out vec4 pixel;
uniform sampler2D hdr;
uniform sampler2D lut;
uniform vec4 curve;
uniform vec4 toe;
uniform vec4 bloom;
uniform bool bypass;
uniform bool materialIds;

vec3 uncharted(vec3 signal) {
  vec3 numerator = signal * (curve.x * signal + curve.y * curve.z) + curve.w * toe.x;
  vec3 denominator = signal * (curve.x * signal + curve.y) + curve.w * toe.y;
  return numerator / denominator - toe.x / toe.y;
}

vec3 encodeSrgb(vec3 linear) {
  return mix(12.92 * linear, 1.055 * pow(max(vec3(0), linear), vec3(1.0 / 2.4)) - 0.055,
             greaterThan(linear, vec3(0.0031308)));
}

vec3 decodeSrgb(vec3 encoded) {
  return mix(encoded / 12.92, pow((encoded + 0.055) / 1.055, vec3(2.4)),
             greaterThan(encoded, vec3(0.04045)));
}

float gradeChannel(float value, int channel) {
  int last = textureSize(lut, 0).x - 1;
  float coordinate = clamp(value, 0.0, 1.0) * float(last);
  int lower = int(floor(coordinate));
  float start = texelFetch(lut, ivec2(lower, 0), 0)[channel];
  float end = texelFetch(lut, ivec2(min(lower + 1, last), 0), 0)[channel];
  return mix(start, end, fract(coordinate));
}

vec3 additiveBloom() {
  vec2 texel = 1.0 / vec2(textureSize(hdr, 0));
  vec3 glow = vec3(0);
  for (int y = -1; y <= 1; ++y) {
    for (int x = -1; x <= 1; ++x) {
      vec3 sampleColor = texture(hdr, uv + vec2(x, y) * texel * 3.0).rgb;
      float luminance = dot(sampleColor, vec3(0.2126, 0.7152, 0.0722));
      float pass = clamp((luminance - bloom.x) / max(bloom.y, 0.00001), 0.0, 1.0);
      float weight = float((x == 0 ? 2 : 1) * (y == 0 ? 2 : 1)) / 16.0;
      glow += sampleColor * pass * weight;
    }
  }
  return glow * bloom.z;
}

void main() {
  vec3 scene = texture(hdr, uv).rgb;
  if (materialIds) {
    pixel = vec4(scene, 1);
    return;
  }
  if (bypass) {
    pixel = vec4(encodeSrgb(scene), 1);
    return;
  }
  if (bloom.z > 0.0)
    scene += additiveBloom();
  vec3 white = vec3(toe.z);
  vec3 mapped = clamp(uncharted(min(scene * toe.w, white)) / uncharted(white), 0.0, 1.0);
  vec3 encoded = encodeSrgb(mapped);
  vec3 graded =
      vec3(gradeChannel(encoded.r, 0), gradeChannel(encoded.g, 1), gradeChannel(encoded.b, 2));
  pixel = vec4(encodeSrgb(decodeSrgb(graded)), 1);
}
