// CS2 histogram bins, exposed threshold, four-level Gaussian bloom and tent upsample.
// Adapted from ValveResourceFormat 21.1 (MIT). See tools/cs2export/THIRD_PARTY_NOTICES.txt.
import { program } from './program';
import { screenVertex } from './shaders';
const head =
  '#version 300 es\nprecision highp float;precision highp int;precision highp usampler2D;\n';
export const exposureSource = `
uniform usampler2D meter;
uniform vec3 exposureBounds;
float exposure(){
 float bin=float(texelFetch(meter,ivec2(0),0).r)/exposureBounds.z;
 return clamp(.18/exp2(bin*13./255.-8.),exposureBounds.x,exposureBounds.y);
}`;
const reduce =
  head +
  `
uniform sampler2D scene;uniform usampler2D sums;uniform bool first;layout(location=0) out highp uint value;
void main(){
 ivec2 base=ivec2(gl_FragCoord.xy)*4,extent=first?textureSize(scene,0):textureSize(sums,0);
 uint total=0u;
 for(int y=0;y<4;y++)for(int x=0;x<4;x++){
  ivec2 p=base+ivec2(x,y);if(any(greaterThanEqual(p,extent)))continue;
  if(first){float lum=dot(texelFetch(scene,p,0).rgb,vec3(.2126,.7152,.0722));total+=uint(clamp((log2(max(lum,.005))+8.)/13.,0.,1.)*255.);}
  else total+=texelFetch(sums,p,0).r;
 }value=total;
}`;
const threshold =
  head +
  exposureSource +
  `
uniform sampler2D scene;uniform vec4 settings;out vec4 pixel;
float max3(vec3 v){return max(v.x,max(v.y,v.z));}
vec3 tap(ivec2 p,float e){
 vec3 avg=vec3(0);ivec2 size=textureSize(scene,0);
 for(int y=0;y<2;y++)for(int x=0;x<2;x++){
  vec3 c=clamp(texelFetch(scene,clamp(p+ivec2(x,y),ivec2(0),size-1),0).rgb,0.,65504.)*e*settings.w;
  avg+=.25*c/(1.+max3(c));
 }vec3 color=avg/max(1e-6,1.-max3(avg));
 return color*clamp((e*dot(color,vec3(.3,.59,.11))-settings.x)/settings.y,0.,1.);
}
void main(){
 ivec2 p=ivec2(gl_FragCoord.xy)*4-1;float e=exposure();
 vec3 result=vec3(0);
 for(int j=0;j<3;j++)for(int i=0;i<3;i++){
  float w=(i==1?2.:1.)*(j==1?2.:1.)/32.;result+=tap(p+ivec2(2*i,2*j),e)*w;
 }
 for(int j=0;j<2;j++)for(int i=0;i<2;i++)result+=tap(p+ivec2(1+2*i,1+2*j),e)*.125;
 pixel=vec4(result*settings.z,1.);
}`;
const filter =
  head +
  `
uniform sampler2D src,curr;uniform vec2 destination,axis;uniform vec3 prevTint,currTint;uniform int op;
out vec4 pixel;
void main(){vec2 uv=gl_FragCoord.xy/destination;vec3 c=vec3(0);
 if(op==0)c=texture(src,gl_FragCoord.xy*2./vec2(textureSize(src,0))).rgb;
 else if(op==1){const float offsets[4]=float[4](-2.196197,-.430063,1.,2.196197),weights[4]=float[4](.121596,.529213,.227595,.121596);
 for(int i=0;i<4;i++)c+=texture(src,uv+axis*offsets[i]/destination).rgb*weights[i];
 }else{float radius=op==2?3.1:1.;
 for(int j=-1;j<=1;j++)for(int i=-1;i<=1;i++){
 float weight=op==2?((i==0?2.:1.)*(j==0?2.:1.)/16.):((i==0||j==0)?0.:.25);
 c+=texture(src,uv+vec2(i,j)*radius/destination).rgb*weight;
 }c=c*prevTint+texture(curr,uv).rgb*currTint;
 }pixel=vec4(c,1.);
}`;
interface Target {
  w: number;
  h: number;
  tex: WebGLTexture;
  fb: WebGLFramebuffer;
}
export function createBloom(gl: WebGL2RenderingContext) {
  const sum = program(gl, screenVertex, reduce),
    cut = program(gl, screenVertex, threshold),
    blur = program(gl, screenVertex, filter);
  let width = 0,
    height = 0,
    bytes = 0;
  const sums: Target[] = [],
    mips: Target[] = [],
    scratch: Target[] = [];
  function target(w: number, h: number, int: boolean): Target {
    const tex = gl.createTexture(),
      fb = gl.createFramebuffer();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, int ? gl.R32UI : gl.RGBA16F, w, h);
    bytes += w * h * (int ? 4 : 8);
    for (const k of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER])
      gl.texParameteri(gl.TEXTURE_2D, k, int ? gl.NEAREST : gl.LINEAR);
    for (const k of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T])
      gl.texParameteri(gl.TEXTURE_2D, k, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
      throw Error('Incomplete post-process target');
    return { w, h, tex, fb };
  }
  function bind(unit: number, t: WebGLTexture) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
  }
  function draw(t: Target) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
    gl.viewport(0, 0, t.w, t.h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  return (
    hdr: WebGLTexture,
    w: number,
    h: number,
    bounds: number[],
    b: Record<string, unknown>,
    bias: number,
  ) => {
    if (w !== width || h !== height) {
      for (const list of [sums, mips, scratch]) {
        for (const t of list) {
          gl.deleteFramebuffer(t.fb);
          gl.deleteTexture(t.tex);
        }
        list.length = 0;
      }
      width = w;
      height = h;
      bytes = 0;
      let x = w,
        y = h;
      do {
        x = Math.ceil(x / 4);
        y = Math.ceil(y / 4);
        sums.push(target(x, y, true));
      } while (x * y > 1);
      x = Math.max(1, w >> 2);
      y = Math.max(1, h >> 2);
      for (let i = 0; i < 4; i++) {
        mips.push(target(x, y, false));
        scratch.push(target(x, y, false));
        x = Math.max(1, x >> 1);
        y = Math.max(1, y >> 1);
      }
    }
    let draws = 0;
    sum.use();
    gl.uniform1i(sum.u('scene'), 0);
    gl.uniform1i(sum.u('sums'), 1);
    bind(0, hdr);
    for (let i = 0; i < sums.length; i++) {
      gl.uniform1i(sum.u('first'), Number(i === 0));
      bind(1, sums[i === 0 ? sums.length - 1 : i - 1].tex);
      draw(sums[i]);
      draws++;
    }
    const meter = sums.at(-1)!.tex,
      low = Number(b.m_flBloomThreshold),
      thresholdWidth = Math.max(0.0001, Number(b.m_flBloomThresholdWidth));
    const strength = Number(b.m_flScreenBloomStrength);
    cut.use();
    gl.uniform1i(cut.u('scene'), 0);
    gl.uniform1i(cut.u('meter'), 1);
    bind(1, meter);
    gl.uniform3fv(cut.u('exposureBounds'), bounds);
    gl.uniform4f(cut.u('settings'), low, thresholdWidth, strength, bias);
    draw(mips[0]);
    draws++;
    blur.use();
    gl.uniform1i(blur.u('src'), 0);
    gl.uniform1i(blur.u('curr'), 1);
    function pass(t: Target, src: Target, op: number, axis: number[], curr?: Target) {
      bind(0, src.tex);
      bind(1, curr?.tex ?? src.tex);
      gl.uniform2fv(blur.u('axis'), axis);
      gl.uniform2f(blur.u('destination'), t.w, t.h);
      gl.uniform1i(blur.u('op'), op);
      draw(t);
      draws++;
    }
    for (let i = 0; i < 4; i++) {
      if (i > 0) pass(mips[i], mips[i - 1], 0, [0, 0]);
      pass(scratch[i], mips[i], 1, [1, 0]);
      pass(mips[i], scratch[i], 1, [0, 1]);
    }
    const weights = b.m_flBlurWeight as number[],
      tints = b.m_vBlurTint as number[][],
      tint = (i: number) => tints[i].map((c) => c * weights[i]);
    let prev = mips[3];
    for (let i = 2; i >= 0; i--) {
      gl.uniform3fv(blur.u('prevTint'), i === 2 ? tint(4) : [1, 1, 1]);
      gl.uniform3fv(
        blur.u('currTint'),
        i === 0 ? tint(0).map((v, j) => v + tint(1)[j]) : tint(i + 1),
      );
      pass(scratch[i], prev, i === 0 ? 3 : 2, [0, 0], mips[i]);
      prev = scratch[i];
    }
    return { meter, bloom: prev.tex, draws, bytes };
  };
}
