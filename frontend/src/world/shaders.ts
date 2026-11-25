// Lighting, tangent normals, material layers and grading adapted from ValveResourceFormat 21.1 (MIT).
// Copyright (c) 2015 ValveResourceFormat Contributors. See tools/cs2export/THIRD_PARTY_NOTICES.txt.
const header = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;
precision highp sampler3D;
`;
const cube = `
vec3 cubeUv(vec3 r,int index){
 vec3 a=abs(r);vec2 xy;int face;float d;
 if(a.x>=a.y&&a.x>=a.z){d=a.x;face=r.x>0.?0:1;xy=vec2(r.x>0.?-r.z:r.z,-r.y);}
 else if(a.y>=a.z){d=a.y;face=r.y>0.?2:3;xy=vec2(r.x,r.y>0.?r.z:-r.z);}
 else{d=a.z;face=r.z>0.?4:5;xy=vec2(r.z>0.?r.x:-r.x,-r.y);}
 return vec3(.5+.5*xy/max(d,1e-8),float(index*6+face));
}
`;
export const vertex =
  header +
  `
layout(location=0) in vec3 pos;layout(location=1) in vec3 normal;layout(location=2) in vec4 tangent;
layout(location=3) in vec2 uv;layout(location=4) in vec2 lightUv;layout(location=5) in vec4 paint;
layout(location=6) in vec4 blend;layout(location=7) in vec2 uv2;layout(location=8) in uvec2 ids;
layout(location=11) in uint lpvId;layout(location=9) in uint baked;layout(location=10) in vec4 tint;
uniform mat4 vp;uniform vec2 lightScale;
out vec3 w,n;out vec4 t,u,vc,bc,tc;out vec2 lm,chart;
flat out ivec4 binding;
void main(){w=pos;n=normal;t=tangent;u=vec4(uv,uv2);vc=paint;bc=blend;tc=tint;
 uvec2 bits=floatBitsToUint(lightUv);bits^=bits<<13u;bits^=bits>>17u;bits^=bits<<5u;chart=(uintBitsToFloat(0x3F800000u|(bits>>9u))-1.)*65535.;lm=lightUv*lightScale;binding=ivec4(ids,baked,lpvId);gl_Position=vp*vec4(w,1.);}
`;
export const worldFrag =
  header +
  cube +
  `
uniform sampler2D tableData,probeData,cellList;uniform vec3 gridMin,gridInv;
uniform sampler2DArray aux0,aux1,aux2,brdf,illumTex,detailMask,ao2Tex,heightTex,roughTex;
uniform sampler2DArray colorTex,normalTex,aoTex,color2Tex,normal2Tex,blendTex,detailTex,metalTex;
uniform sampler2DArray irradiance,directional,shadowMap,envMap,skyMap,lpv,lpvShadow;
uniform vec3 eye,sunDir,sunColor;uniform vec4 fogDist,fogHeight;
uniform float envLastMip;uniform vec4 gradientColor,gradientScale;uniform vec2 gradientExponents;uniform int mode;uniform mat4 localFromWorld;
in vec3 w,n;in vec4 t,u,vc,bc,tc;in vec2 lm,chart;flat in ivec4 binding;out vec4 pixel;
vec4 row(int x){return texelFetch(tableData,ivec2(x,binding.x),0);}
vec4 record(int x,int idx){return texelFetch(probeData,ivec2(x,idx),0);}

vec4 sampleOr(sampler2DArray tex,vec2 uv,float layer,vec4 fallback){
 return layer<0.?fallback:texture(tex,vec3(uv,layer));
}
vec3 decodeNormal(vec2 v){vec2 h=vec2(v.x+v.y-1.003922,v.x-v.y);return normalize(vec3(h.x,-h.y,1.-abs(h.x)-abs(h.y)));}
vec4 volume(sampler2DArray tex,vec3 uv,float face){
 vec3 size=vec3(textureSize(tex,0));float depth=size.z/face;
 float z=clamp(uv.z*depth-.5,0.,size.z-1.);
 return mix(texture(tex,vec3(uv.xy,floor(z))),texture(tex,vec3(uv.xy,min(size.z-1.,floor(z)+1.))),fract(z));
}
float shadowBicubic(vec2 uv){
 vec2 size=vec2(textureSize(shadowMap,0).xy);
 if(min(fwidth(chart).x,fwidth(chart).y)<=.1||size.x<=4096.)return textureLod(shadowMap,vec3(uv,0),0.).r;
 vec2 p=uv*size-.5,f=fract(p),f2=f*f,f3=f2*f;
 vec2 w0=(-f3+3.*f2-3.*f+1.)/6.,w1=(3.*f3-6.*f2+4.)/6.,w2=(-3.*f3+3.*f2+3.*f+1.)/6.,w3=f3/6.;
 vec2 a=w0+w1,b=w2+w3,lo=(floor(p)+w1/a-1.5)/size,hi=(floor(p)+w3/b+.5)/size;
 return a.x*a.y*textureLod(shadowMap,vec3(lo,0),0.).r+b.x*a.y*textureLod(shadowMap,vec3(hi.x,lo.y,0),0.).r+
 a.x*b.y*textureLod(shadowMap,vec3(lo.x,hi.y,0),0.).r+b.x*b.y*textureLod(shadowMap,vec3(hi,0),0.).r;
}
vec2 transformUV(vec2 uv,int column){return vec2(dot(vec3(uv,1.),row(column).xyz),dot(vec3(uv,1.),row(column+1).xyz));}
void main(){
 vec4 layers=row(0),more=row(1),flags=row(2),baseTint=row(3),params=row(4),uvParams=row(5),detail=row(6);
 vec2 uv=(row(8).z>0.?u.zw:u.xy)*uvParams.xy+uvParams.zw;
 vec2 nUV=row(29).x>0.?transformUV(u.xy,27):uv;
 if(row(29).y>0.){uv=transformUV(uv,17);nUV=transformUV(uv,19);}
 vec4 albedo=sampleOr(colorTex,uv,layers.x,vec4(1));vec4 nm=sampleOr(normalTex,nUV,layers.y,vec4(.50196,.50196,1.,0.));
 float blend=bc.r;
 if(more.y>=0.){vec4 blendMod=sampleOr(blendTex,transformUV(uv,25),more.y,vec4(.5));float mask=row(10).w==3.?blendMod.a:blendMod.g;float width=max(.0001,row(10).w==1.?blendMod.r:params.z);
 blend=smoothstep(max(0.,mask-width),min(1.,mask+width),blend);}
 albedo.rgb*=row(7).rgb;
 if(layers.w>=0.){albedo=mix(albedo,sampleOr(color2Tex,transformUV(uv,21),layers.w,vec4(1))*vec4(row(9).rgb,1),blend);
 nm=mix(nm,sampleOr(normal2Tex,transformUV(uv,23),more.x,nm),blend);}
 vec2 secondary=row(29).z>0.?u.zw:uv;
 if(row(31).z>0.){
  vec4 dt=row(34);vec2 coords=secondary*row(33).xy;
  coords=mat2(dt.z,dt.w,-dt.w,dt.z)*coords+dt.xy;
  float mask=max(sampleOr(detailMask,secondary,row(30).y,vec4(1)).r,row(33).w)*row(33).z;
  albedo.rgb*=mix(vec3(1),sampleOr(detailTex,coords,more.z,vec4(.5)).rgb*1.9922,mask);
 }else if(more.z>=0.)albedo.rgb*=mix(vec3(1),sampleOr(detailTex,uv*detail.xy,more.z,vec4(.5)).rgb*2.,detail.z);
 albedo.rgb*=baseTint.rgb*mix(vec3(1),pow(tc.rgb,vec3(2.2)),params.y*(row(16).z>0.?sampleOr(aux1,secondary,row(10).y,vec4(1)).r:1.));
 if(params.w>0. && dot(vc,vc)>0.)albedo.rgb*=vc.rgb;
 float alpha=albedo.a*tc.a*flags.w;if(flags.x>0. && alpha<params.x) discard;
 if(flags.y<.5)alpha=1.;
 vec3 V=normalize(eye-w),N=normalize(n),T=normalize(t.xyz),B=normalize(cross(N,T))*t.w;
 if(row(29).w>0.&&!gl_FrontFacing)N=-N;
 vec3 nts=normalize(mix(vec3(0,0,1),decodeNormal(nm.rg),row(16).w));vec3 normal=normalize(T*nts.x+B*nts.y+N*nts.z);
 vec3 pos=(localFromWorld*vec4(w,1.)).xyz;
 ivec3 cell=clamp(ivec3(floor((pos-gridMin)*gridInv)),ivec3(0),ivec3(15,15,7));
 int cy=cell.x+16*(cell.y+16*cell.z);
 float rough=clamp(max(sampleOr(roughTex,uv,row(31).x,vec4(nm.b)).r,pow(clamp(max(dot(dFdx(N),dFdx(N)),dot(dFdy(N),dFdy(N))),0.,1.),.333)),.02,1.);
 vec3 refl=reflect(-V,normal),env=vec3(0),lpLight=vec3(0);float envWeight=.01,lpWeight=0.,lpShade=0.;vec4 harmonic=vec4(0);
 for(int k=0;k<64;k++){
  int idx=int(texelFetch(cellList,ivec2(k/4,cy),0)[k%4]);if(idx<0)break;
  vec3 local=pos-record(0,idx).xyz,lo=record(1,idx).xyz,hi=record(2,idx).xyz;
  vec3 edge=min(local-lo,hi-local),inv=1./max(vec3(.000001),record(8,idx).xyz);
  vec3 fade=edge*inv;float weight=smoothstep(0.,1.,min(min(fade.x,fade.y),fade.z))*(1.-envWeight);
  if(weight>0.){
   vec3 a=(lo-local)/(refl+vec3(1e-10)),b=(hi-local)/(refl+vec3(1e-10));
   vec3 hit=max(a,b);vec3 R=local+refl*abs(min(min(hit.x,hit.y),hit.z));
   env+=textureLod(envMap,cubeUv(mix(R,refl,rough),idx),rough*envLastMip).rgb*weight;
   harmonic+=record(5,idx)*weight;envWeight+=weight;
  }
  if(binding.z==0 && lpWeight<=.99){
   vec3 f=(edge+.1)*inv;weight=smoothstep(0.,1.,min(min(f.x,f.y),f.z))*(1.-lpWeight);
   if(weight>0.){
    vec3 q=clamp((local-lo)/(hi-lo),0.,1.),size=record(4,idx).xyz,off=record(3,idx).xyz,dims=vec3(textureSize(lpvShadow,0));
    vec3 uvw=(clamp(q*size,vec3(.5),size-.5)+off)/dims;
    for(int i=0;i<3;i++){float face=float(i)+(normal[i]<=0.?3.:0.);lpLight+=volume(lpv,vec3(uvw.xy,uvw.z+face),6.).rgb*normal[i]*normal[i]*weight;}
    lpShade+=volume(lpvShadow,(q*size+off)/dims,1.).r*weight;lpWeight+=weight;
   }
  }
  if(envWeight>.99&&(binding.z==1||lpWeight>.99))break;
 }
 env/=envWeight;harmonic/=envWeight;
 vec3 direct,light;float sh;
 if(binding.z==1){
  vec3 irr=texture(irradiance,vec3(lm,0)).rgb,dir=texture(directional,vec3(lm,0)).rgb;
  vec2 xy=dir.xy*2.-1.;const float cap=.99619;xy*=cap/max(cap,length(xy));float z=sqrt(max(.00001,1.-dot(xy,xy)));
  float curv=length(fwidth(N))/max(.000001,length(fwidth(w))),flatness=(1.-smoothstep(.01,.1,curv))*.8;
  vec3 L=normalize(vec3(xy,z*mix(1.,mix(.1,2.,clamp((1.-z)*1.5,0.,1.)),flatness)));
  vec3 non=irr*dir.z;light=non+(irr-non)*max(0.,dot(L,nts))/L.z;
  sh=1.-shadowBicubic(lm);
 }else{light=lpLight;sh=1.-lpShade;}
 direct=sunColor*sh*max(0.,dot(normal,sunDir));
 float ao=sampleOr(aoTex,secondary,layers.z,vec4(1)).r;
 if(layers.w>=0.)ao=mix(ao,sampleOr(ao2Tex,transformUV(uv,21),row(30).z,vec4(1)).r,blend);
 if(row(35).x>0.)ao=min(mix(1.,2.*ao,row(35).x),1.);
 float metal=sampleOr(metalTex,uv,more.w,vec4(row(8).x)).g;
 if(flags.z==6.){vec4 h=sampleOr(heightTex,uv,row(30).w,vec4(1));ao=flags.x>0.?h.b:albedo.a;metal=h.a*row(31).w;}
 vec3 spec=mix(vec3(.04),albedo.rgb,metal);
 vec4 lut=textureLod(brdf,vec3(vec2(rough,sqrt(1.-clamp(dot(normal,V),0.,1.)))*63./64.+.5/64.,1.),0.);
 vec3 fresnel=mix(vec3(lut.x),vec3(lut.y),spec);
 float bakedLuma=dot(vec4(normal,1.),harmonic);
 if(bakedLuma>0.)env*=min(dot(light,vec3(.2126,.7152,.0722))/bakedLuma,1.);
 vec3 avg=spec+(1.-spec)/21.;fresnel+=fresnel*avg*(1.-lut.y)/(1.-avg*(1.-lut.y));
 if(row(16).x==0.)fresnel=vec3(0);
 vec3 lit=albedo.rgb*(1.-metal)*(light*ao+direct)+env*fresnel*ao;
 if(row(16).y>0.){
  vec3 H=normalize(sunDir+V);float nh=max(0.,dot(normal,H)),nv=max(0.,dot(normal,V)),nl=max(0.,dot(normal,sunDir));
  float a=max(.0001,rough*rough),d=min(a/(1.-nh*nh+nh*nh*a*a),453.5),k=(rough+1.)*(rough+1.)*.125;
  vec3 f=spec+(1.-spec)*pow(1.-max(0.,dot(V,H)),5.);
  lit+=direct*f*d*d/(4.*max(.0001,mix(nv,1.,k)*mix(nl,1.,k)));
 }
 vec3 emission=vec3(0);
 if(row(31).y>0.)emission=row(32).rgb*sampleOr(illumTex,secondary,row(30).x,vec4(0)).rgb*mix(vec3(1),albedo.rgb,row(32).a);
 lit+=emission;
 if(flags.z==1.)lit=albedo.rgb;
 if(flags.z==2.){
 vec4 dust=sampleOr(aux0,uv,row(10).x,vec4(0));float opacity=mix(row(15).x,row(15).y,dust.a*tc.a);
 float nv=max(0.,dot(V,N)),f=.04+.96*pow(1.-max(0.,dot(V,normal)),5.);
 vec3 transmit=(1.-f)*pow(albedo.rgb,vec3(inversesqrt(1.-(1.-nv*nv)/2.25)))*(1.-opacity);
 alpha=max(1.-dot(transmit,vec3(.2126,.7152,.0722)),1./255.);
 lit=(dust.rgb*(light+direct)*opacity*(1.+transmit*pow(albedo.rgb,vec3(1.6)))+env*fresnel)/alpha;
 }
 if(flags.z==4.){
 vec4 mask=row(10),sc=row(11),fx=row(12),fade=row(13),fr=row(14);
 alpha*=sampleOr(aux0,uv*sc.xy,mask.x,vec4(1)).r*sampleOr(aux1,uv*sc.zw,mask.y,vec4(1)).r*sampleOr(aux2,uv*fx.xy,mask.z,vec4(1)).r*vc.a;
 alpha*=mix(fr.x,fr.y,clamp(pow(max(dot(V,N),0.),fade.w)*fr.z,0.,1.))*pow(mix(fade.x,fade.y,clamp(length(pos-(localFromWorld*vec4(eye,1.)).xyz)/max(.001,fx.w),0.,1.)),fade.z);
 lit=albedo.rgb*fx.z;
 }
 if(flags.z==5. && row(15).w>0.)lit+=sunColor*sh*max(0.,-dot(normal,sunDir))*(row(15).z>0.?albedo.rgb:sampleOr(aux0,uv,row(10).x,vec4(0)).rgb);
 if(flags.z==3.)lit=vec3(0);
 if(mode==5)lit=albedo.rgb+emission;
 if(gradientColor.a>0.){
  vec2 factors=vec2(length(w-eye),w.z)*gradientScale.zw+gradientScale.xy;
  if(factors.x>0. && factors.y>0.){
   factors=pow(clamp(factors,.0001,1.),gradientExponents);
   lit=mix(lit,gradientColor.rgb,factors.x*factors.y*gradientColor.a);
  }
 }
 float distTerm=pow(max(0.,(length(w-eye)-fogDist.x)/max(1.,fogDist.y-fogDist.x)),fogDist.z);
 float heightTerm=pow(clamp((fogHeight.y-w.z)/max(1.,fogHeight.y-fogHeight.x),0.,1.),fogHeight.z);
 float fog=clamp(distTerm,0.,1.)*heightTerm*fogDist.w;
 lit=mix(lit,textureLod(skyMap,cubeUv(w-eye,0),clamp(1.-fog*fogHeight.w,0.,1.)*(log2(float(textureSize(skyMap,0).x))-3.)).rgb,fog);
 if(mode==1)lit=albedo.rgb;else if(mode==2)lit=normal*.5+.5;else if(mode==3)lit=light;else if(mode==4)lit=env;
 if(mode==7){
  int id=binding.x+1;
  pixel=vec4(float(id & 255),float(id >> 8),255.,255.)/255.;
 }else pixel=vec4(max(lit,vec3(0)),alpha);
}
`;
export const screenVertex =
  header +
  `
out vec2 uv;void main(){uv=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(uv*2.-1.,0.,1.);}`;
export const skyFrag =
  header +
  cube +
  `
in vec2 uv;out vec4 pixel;uniform mat4 unproject;uniform sampler2DArray skyMap;uniform vec3 eye;uniform float gain;
void main(){vec4 p=unproject*vec4(uv*2.-1.,.5,1.);pixel=vec4(textureLod(skyMap,cubeUv(p.xyz/p.w-eye,0),0.).rgb*gain,1.);}`;
// Uncharted curve from VRF post_processing.frag.slang, with the lab's fixed map exposure.
export const postFrag =
  header +
  `
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
  for(int y = -1; y <= 1; ++y) {
    for(int x = -1; x <= 1; ++x) {
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
  if(materialIds){pixel=vec4(scene,1);return;}
  if (bypass) {
    pixel = vec4(encodeSrgb(scene), 1);
    return;
  }
  if (bloom.z > 0.0) scene += additiveBloom();
  vec3 white = vec3(toe.z);
  vec3 mapped = clamp(uncharted(min(scene * toe.w, white)) / uncharted(white), 0.0, 1.0);
  vec3 encoded = encodeSrgb(mapped);
  vec3 graded = vec3(gradeChannel(encoded.r, 0), gradeChannel(encoded.g, 1), gradeChannel(encoded.b, 2));
  pixel = vec4(encodeSrgb(decodeSrgb(graded)), 1);
}
`;
