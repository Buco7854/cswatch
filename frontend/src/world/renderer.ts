// Material and lighting bindings adapted from ValveResourceFormat 21.1 (MIT). See tools/cs2export/THIRD_PARTY_NOTICES.txt.
import { program } from './program';
import { projectedBounds, transparentGroups, type ScreenRect } from './transparency';
import { probeGrid } from './probe-grid';
import { Frustum, Matrix4, PerspectiveCamera, Vector3, Box3 } from 'three';
import { MeshoptDecoder } from 'meshoptimizer';
import { readAsset, type Manifest, type Entity } from './format';
import { textureArray } from './textures';
import { vertex, worldFrag, screenVertex, skyFrag, postFrag } from './shaders';

export interface Pose {
  pos: number[];
  ang: number[];
  fov: number;
}
const numbers = (v: unknown): number[] =>
  typeof v === 'string' ? v.trim().split(/\s+/).map(Number) : (v as number[]);
const rad = Math.PI / 180;
export async function createRenderer(gl: WebGL2RenderingContext, dir: URL, m: Manifest) {
  const world = program(gl, vertex, worldFrag),
    sky = program(gl, screenVertex, skyFrag),
    post = program(gl, screenVertex, postFrag);
  const ext = gl.getExtension('WEBGL_multi_draw');
  let textureBytes = 0;
  const fetchAsset = (file: string) => readAsset(dir, m, file);
  const arrays: WebGLTexture[] = [],
    special = new Map<string, WebGLTexture>();
  for (const b of m.arrays) {
    const data = await fetchAsset(b.file);
    arrays.push(textureArray(gl, b.format, b.srgb, b.mips, b.textures.length, b.flags, data));
    textureBytes += data.byteLength;
  }
  const skyEntity = m.environments
    .find((e) => !e.sky)
    ?.entities.find((e) => e.classname === 'env_sky' && !e.startdisabled);
  const skyMaterial = m.materials.find((mat) => mat.name === skyEntity?.skyname);
  const skyName = skyMaterial?.slots?.g_tSkyTexture;
  if (typeof skyName !== 'string') throw Error('Missing sky material texture');
  const required = new Set([skyName, 'vrf/brdf_lut']);
  for (const env of m.environments) {
    for (const kind of ['irradiance', 'directional_irradiance', 'direct_light_shadows'])
      required.add(env.world + '/lightmaps/' + kind + '.vtex');
    for (const e of env.entities)
      for (const key of ['cubemaptexture', 'lightprobetexture', 'lightprobetexture_dlshd'])
        if (typeof e[key] === 'string') required.add(e[key]);
  }
  for (const [name, t] of Object.entries(m.specials)) {
    if (!required.has(name)) continue;
    const data = await fetchAsset(t.file),
      tex = textureArray(gl, t.format, false, t.levels, t.levels.at(-1)!.d!, t.flags | 3, data);
    special.set(name.replaceAll('\\', '/'), tex);
    textureBytes += data.byteLength;
  }
  const controller = m.environments
    .find((environment) => !environment.sky)
    ?.entities.find(
      (entity) =>
        entity.classname === 'post_processing_volume' && entity.master && !entity.startdisabled,
    );
  const params = m.post[String(controller?.postprocessing)] ?? Object.values(m.post)[0];
  const exposure = controller?.enableexposure ? Number(controller.minexposure ?? 1) : 1;
  const lut = gl.createTexture();
  const dimension = params.dimension;
  const cube = await fetchAsset(params.lut);
  const diagonal = new Uint8Array(4 * dimension);
  for (let index = 0; index < dimension; index++) {
    const offset = 4 * index * (dimension * dimension + dimension + 1);
    diagonal.set(cube.subarray(offset, offset + 4), 4 * index);
  }
  gl.bindTexture(gl.TEXTURE_2D, lut);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, dimension, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, diagonal);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  textureBytes += diagonal.length;
  function table(w: number, h: number, values: Float32Array<ArrayBuffer>) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, values);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    textureBytes += values.byteLength;
    return tex;
  }
  const rows = m.materials.flatMap((mat) => {
    const b = mat.bindings,
      i = mat.ints,
      s = mat.scalars,
      v = mat.vectors;
    const rgb = (k: string) =>
      (v[k] ?? [1, 1, 1])
        .slice(0, 3)
        .map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
    const type = mat.shader.includes('effects')
      ? 4
      : mat.shader.includes('foliage')
        ? 5
        : mat.shader.includes('black_unlit')
          ? 3
          : mat.shader.includes('glass')
            ? 2
            : mat.shader.includes('unlit') || (mat.shader.includes('static_overlay') && !i.F_LIT)
              ? 1
              : mat.shader === 'csgo_environment.vfx'
                ? 6
                : 0;
    return [
      ...m.roles.slice(0, 8).map((k) => b[k]?.[1] ?? -1),
      i.F_ALPHA_TEST ?? 0,
      i.F_TRANSLUCENT ||
      i.F_OVERLAY ||
      type === 2 ||
      mat.shader.includes('overlay') ||
      type === 1 ||
      type === 4
        ? 1
        : 0,
      type,
      s.g_flOpacityScale ?? 1,
      ...rgb('g_vColorTint'),
      1,
      s.g_flAlphaTestReference ?? 0.5,
      s.g_flModelTintAmount ?? 1,
      s.g_flBlendSoftness ?? 0.5,
      i.F_VERTEX_COLOR ?? 0,
      ...(v.g_vTexCoordScale ?? [1, 1]).slice(0, 2),
      ...(v.g_vTexCoordOffset ?? [0, 0]).slice(0, 2),
      ...(v.g_vLayer1DetailScale ?? [1, 1]).slice(0, 2),
      v.g_vLayer1DetailTintAndBlend?.[3] ?? 0,
      0,
      ...rgb('g_vLayer1Tint'),
      1,
      s.g_flMetalness ?? 0,
      0,
      (i.g_nUVSet1 ?? 0) > 1 ? 1 : 0,
      0,
      ...rgb('g_vLayer2Tint'),
      1,
      ...m.roles.slice(8, 11).map((k) => b[k]?.[1] ?? -1),
      i.F_FANCY_BLENDING ?? 0,
      ...(v.g_vMask1Scale ?? [1, 1]).slice(0, 2),
      ...(v.g_vMask2Scale ?? [1, 1]).slice(0, 2),
      ...(v.g_vMask3Scale ?? [1, 1]).slice(0, 2),
      s.g_flColorBoost ?? 1,
      s.g_flFadeDistance ?? 1,
      s.g_flFadeMin ?? 0,
      s.g_flFadeMax ?? 1,
      s.g_flFadeFalloff ?? 1,
      s.g_flFresnelExponent ?? 0.001,
      s.g_flFresnelMin ?? 0,
      s.g_flFresnelMax ?? 1,
      s.g_flFresnelFalloff ?? 1,
      i.F_ADDITIVE_BLEND ?? 0,
      ...(v.g_flTranslucencyRemap ?? [0, 1]).slice(0, 2),
      i.F_USE_ALBEDO_FOR_TRANSMISSIVE ?? 0,
      i.F_TRANSMISSIVE_BACKFACE_NDOTL ?? 0,
      mat.shader.includes('generic') && !mat.shader.startsWith('csgo_unlit')
        ? (i.F_SPECULAR_INDIRECT ?? 0)
        : 1,
      i.F_SPECULAR_DIRECT ?? (mat.shader.includes('generic') ? 0 : 1),
      i.F_TINT_MASK ?? 0,
      s.g_flBumpStrength ?? 1,
      ...['Layer1', 'Layer1Normal', 'Layer2', 'Layer2Normal', 'BlendModulate', 'Normal'].flatMap(
        (prefix) => {
          const scale = v['g_v' + prefix + 'TexCoordScale'] ?? [1, 1],
            center = v['g_v' + prefix + 'TexCoordCenter'] ?? [0.5, 0.5],
            offset = v['g_v' + prefix + 'TexCoordOffset'] ?? [0, 0];
          const a = (s['g_fl' + prefix + 'TexCoordRotation'] ?? 0) * rad,
            c = Math.cos(a),
            sin = Math.sin(a);
          return [
            c * scale[0],
            -sin * scale[1],
            center[0] * (1 - c * scale[0]) + sin * scale[1] * center[1] + offset[0],
            0,
            sin * scale[0],
            c * scale[1],
            sin * scale[0] * center[0] + center[1] * (1 - c * scale[1]) + offset[1],
            0,
          ];
        },
      ),
      mat.shader === 'csgo_vertexlitgeneric.vfx' ? 1 : 0,
      i.F_TEXTURETRANSFORMS ?? 0,
      i.F_FORCE_UV2 ?? 0,
      i.F_RENDER_BACKFACES && !i.F_DONT_FLIP_BACKFACE_NORMALS ? 1 : 0,
      ...m.roles.slice(11, 15).map((k) => b[k]?.[1] ?? -1),
      b.rough?.[1] ?? -1,
      i.F_SELF_ILLUM ?? 0,
      i.F_DETAIL_TEXTURE ?? 0,
      i.g_bMetalness1 ?? 1,
      ...rgb('g_vSelfIllumTint').map(
        (x) => x * (s.g_flSelfIllumScale ?? 1) * 2 ** (s.g_flSelfIllumBrightness ?? 0),
      ),
      s.g_flSelfIllumAlbedoFactor ?? 1,
      ...(v.g_vDetailTexCoordScale ?? [1, 1]).slice(0, 2),
      s.g_flDetailBlendFactor ?? 1,
      s.g_flDetailBlendToFull ?? 0,
      ...(v.g_vDetailTexCoordOffset ?? [0, 0]).slice(0, 2),
      Math.cos((s.g_flDetailTexCoordRotation ?? 0) * rad),
      Math.sin((s.g_flDetailTexCoordRotation ?? 0) * rad),
      s.g_flAmbientOcclusionScale ?? 0,
      0,
      0,
      0,
    ];
  });
  const materialTable = table(36, m.materials.length, new Float32Array(rows));
  const envs = m.environments.map((e) => {
    const entries = e.entities.filter((x) => x.cubemaptexture && x.array_index != null);
    const height = Math.max(...entries.map((p) => Number(p.array_index))) + 1,
      values = new Float32Array(9 * height * 4);
    for (const p of entries) {
      const index = Number(p.array_index),
        offset = 36 * index;
      values.set(numbers(p.edge_fade_dists ?? [0, 0, 0]), offset + 32);
      const key = String(p.cubemaptexture),
        coeff = m.specials[key]?.radiance;
      if (coeff && coeff.length >= (index + 1) * 27) {
        const luma = [0, 1, 2, 3].map(
          (k) =>
            0.2126 * coeff[index * 27 + k] +
            0.7152 * coeff[index * 27 + k + 9] +
            0.0722 * coeff[index * 27 + k + 18],
        );
        const dc = luma[0] * 0.282095,
          linear = [-luma[3], -luma[1], luma[2]].map((x) => x * 0.325735);
        const scale = Math.min((dc * 0.99) / Math.max(1e-8, Math.hypot(...linear, dc)), 1);
        values.set(dc <= 0 ? [0, 0, 0, 0.01] : [...linear.map((x) => x * scale), dc], offset + 20);
      }
      values.set(numbers(p.boxproject_mins ?? p.box_mins), offset + 24);
      values.set(numbers(p.boxproject_maxs ?? p.box_maxs), offset + 28);
      for (const [index, value] of [
        numbers(p.origin),
        numbers(p.box_mins),
        numbers(p.box_maxs),
        ['x', 'y', 'z'].map((k) => Number(p['light_probe_atlas_' + k])),
        ['x', 'y', 'z'].map((k) => Number(p['light_probe_size_' + k])),
      ].entries())
        values.set(value, offset + index * 4);
    }
    const get = (entity: Entity, slot: string) =>
      special.get(String(entity[slot]).replaceAll('\\', '/'))!;
    const sun = e.entities.find(
        (x) => x.classname === 'light_environment' || x.classname === 'env_global_light',
      )!,
      angles = numbers(sun.angles).map((x) => x * rad);
    const lightDir = [
      -Math.cos(angles[0]) * Math.cos(angles[1]),
      -Math.cos(angles[0]) * Math.sin(angles[1]),
      Math.sin(angles[0]),
    ];
    const color = numbers(sun.color).map(
      (c) =>
        Math.pow(c / 255, 2.2) * Number(sun.brightness ?? 1) * Number(sun.brightnessscale ?? 1),
    );
    const spatial = probeGrid(entries);
    return {
      ...e,
      spatial,
      grid: table(spatial.width, spatial.height, spatial.data),
      probes: table(9, height, values),
      inverse: new Matrix4().fromArray(e.transform).invert(),
      lightDir,
      color,
      envLastMip: m.specials[String(entries[0].cubemaptexture)].levels.length - 2,
      env: get(entries[0], 'cubemaptexture'),
      lpv: get(entries[0], 'lightprobetexture'),
      shadow: get(entries[0], 'lightprobetexture_dlshd'),
    };
  });
  await MeshoptDecoder.ready;
  const g = m.geometry,
    vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  for (const [file, count, size, target] of [
    [g.vb, g.vertices, g.stride, gl.ARRAY_BUFFER],
    [g.ib, g.indices, 4, gl.ELEMENT_ARRAY_BUFFER],
  ] as const) {
    const raw = new Uint8Array(count * size),
      compressed = await fetchAsset(file);
    if (target === gl.ARRAY_BUFFER) MeshoptDecoder.decodeVertexBuffer(raw, count, size, compressed);
    else MeshoptDecoder.decodeIndexBuffer(raw, count, 4, compressed);
    gl.bindBuffer(target, gl.createBuffer());
    gl.bufferData(target, raw, gl.STATIC_DRAW);
  }
  for (const [index, count, type, offset, norm, integer] of [
    [0, 3, gl.FLOAT, 0, 0, 0],
    [1, 3, gl.BYTE, 12, 1, 0],
    [2, 4, gl.BYTE, 16, 1, 0],
    [3, 2, gl.FLOAT, 20, 0, 0],
    [4, 2, gl.UNSIGNED_SHORT, 28, 1, 0],
    [5, 4, gl.UNSIGNED_BYTE, 32, 1, 0],
    [6, 4, gl.UNSIGNED_BYTE, 36, 1, 0],
    [7, 2, gl.FLOAT, 40, 0, 0],
    [8, 2, gl.UNSIGNED_SHORT, 48, 0, 1],
    [9, 1, gl.UNSIGNED_BYTE, 52, 0, 1],
    [10, 4, gl.UNSIGNED_BYTE, 56, 1, 0],
    [11, 1, gl.UNSIGNED_SHORT, 54, 0, 1],
  ]) {
    gl.enableVertexAttribArray(index);
    if (integer) gl.vertexAttribIPointer(index, count, type, g.stride, offset);
    else gl.vertexAttribPointer(index, count, type, !!norm, g.stride, offset);
  }
  gl.bindVertexArray(null);
  const hdr = gl.createTexture(),
    frame = gl.createFramebuffer(),
    depth = gl.createRenderbuffer();
  let width = 0,
    height = 0;
  function resize() {
    width = gl.drawingBufferWidth;
    height = gl.drawingBufferHeight;
    gl.bindTexture(gl.TEXTURE_2D, hdr);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, frame);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, hdr, 0);
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, width, height);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
      throw Error('HDR framebuffer incomplete');
  }
  const cam = new PerspectiveCamera(),
    vp = new Matrix4(),
    frustum = new Frustum();
  cam.up.set(0, 0, 1);
  cam.near = 1;
  cam.far = 250000;
  const skyTexture = special.get(skyName)!;
  const skyGain =
    Number(skyEntity?.brightnessscale ?? 1) *
    2 **
      ((skyMaterial?.scalars.g_flBrightnessExposureBias ?? 0) +
        (skyMaterial?.scalars.g_flRenderOnlyExposureBias ?? 0));
  const bounds = (a: number[]) =>
    new Box3(new Vector3(...a.slice(0, 3)), new Vector3(...a.slice(3)));
  const chunks = m.chunks.map((c) => ({
    ...c,
    box: bounds(c.bounds),
    ranges: c.ranges.map((r) => ({ ...r, box: bounds(r.bounds) })),
  }));
  const transparent = (family: string) =>
    ['glass', 'blended', 'overlay', 'additive', 'modulate'].includes(family);
  function bind(unit: number, target: number, tex: WebGLTexture | null) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(target, tex);
  }
  const arr = gl.TEXTURE_2D_ARRAY;
  const samplerNames = [
    'colorTex',
    'normalTex',
    'aoTex',
    'color2Tex',
    'normal2Tex',
    'blendTex',
    'detailTex',
    'metalTex',
    'irradiance',
    'directional',
    'shadowMap',
    'envMap',
    'skyMap',
    'lpv',
    'lpvShadow',
    'tableData',
    'probeData',
    'aux0',
    'aux1',
    'aux2',
    'brdf',
    'cellList',
    'illumTex',
    'detailMask',
    'ao2Tex',
    'heightTex',
    'roughTex',
  ];
  world.use();
  samplerNames.forEach((k, i) => gl.uniform1i(world.u(k), i));
  const multiCounts = new Int32Array(8192),
    multiOffsets = new Int32Array(8192);
  return function render(pose: Pose, mode: number) {
    const start = performance.now();
    if (width !== gl.drawingBufferWidth || height !== gl.drawingBufferHeight) resize();
    cam.aspect = width / height;
    cam.fov = pose.fov;
    cam.position.fromArray(pose.pos);
    const [pitch, yaw] = pose.ang.map((a) => a * rad);
    cam.lookAt(
      cam.position
        .clone()
        .add(
          new Vector3(
            Math.cos(pitch) * Math.cos(yaw),
            Math.cos(pitch) * Math.sin(yaw),
            -Math.sin(pitch),
          ),
        ),
    );
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    vp.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    frustum.setFromProjectionMatrix(vp);
    gl.viewport(0, 0, width, height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, frame);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    sky.use();
    gl.uniformMatrix4fv(sky.u('unproject'), false, vp.clone().invert().elements);
    gl.uniform3fv(sky.u('eye'), pose.pos);
    gl.uniform1f(sky.u('gain'), skyGain);
    gl.uniform1i(sky.u('skyMap'), 12);
    bind(12, arr, skyTexture);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    let draws = 1,
      triangles = 1;
    world.use();
    gl.bindVertexArray(vao);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.cullFace(gl.BACK);
    gl.uniformMatrix4fv(world.u('vp'), false, vp.elements);
    gl.uniform3fv(world.u('eye'), pose.pos);
    gl.uniform1i(world.u('mode'), mode);
    bind(15, gl.TEXTURE_2D, materialTable);
    bind(20, arr, special.get('vrf/brdf_lut')!);
    for (const env of envs) {
      gl.depthMask(true);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.uniformMatrix4fv(world.u('localFromWorld'), false, env.inverse.elements);
      gl.uniform2fv(world.u('lightScale'), env.lighting.m_vLightmapUvScale);
      gl.uniform1f(world.u('envLastMip'), env.envLastMip);
      gl.uniform3fv(world.u('sunDir'), env.lightDir);
      gl.uniform3fv(world.u('sunColor'), env.color);
      const gradient = env.entities.find(
        (e) => e.classname === 'env_gradient_fog' && !e.startdisabled,
      );
      gl.uniform4fv(
        world.u('gradientColor'),
        gradient
          ? [
              ...numbers(gradient.fogcolor ?? [255, 255, 255])
                .slice(0, 3)
                .map((x) => (x * Number(gradient.fogstrength ?? 1)) / 255),
              Number(gradient.fogmaxopacity ?? 1),
            ]
          : [0, 0, 0, 0],
      );
      if (gradient) {
        const start = Number(gradient.fogstart),
          end = Number(gradient.fogend);
        const lo = Number(gradient.fogstartheight ?? 0),
          hi = Number(gradient.fogendheight ?? 0);
        const heightScale = gradient.heightfog === false || lo === hi ? 0 : 1 / (lo - hi);
        gl.uniform4f(
          world.u('gradientScale'),
          -start / (end - start),
          heightScale === 0 ? 1 : -hi * heightScale,
          1 / (end - start),
          heightScale,
        );
        gl.uniform2f(
          world.u('gradientExponents'),
          Number(gradient.fogfalloffexponent ?? 1),
          Number(gradient.fogverticalexponent ?? 1),
        );
      }
      const fog = env.entities.find((e) => e.classname === 'env_cubemap_fog' && !e.startdisabled);
      gl.uniform4f(
        world.u('fogDist'),
        Number(fog?.cubemapfogstartdistance ?? 0),
        Number(fog?.cubemapfogenddistance ?? 1),
        Number(fog?.cubemapfogfalloffexponent ?? 1),
        Number(fog?.cubemapfogmaxopacity ?? 0),
      );
      gl.uniform4f(
        world.u('fogHeight'),
        Number(fog?.cubemapfogheightstart ?? 0),
        Number(fog?.cubemapfogheightend ?? 1),
        Number(fog?.cubemapfogheightexponent ?? 1),
        Number(fog?.cubemapfoglodbiase ?? 1),
      );
      for (const [i, tex] of [
        'irradiance',
        'directional_irradiance',
        'direct_light_shadows',
      ].entries())
        bind(i + 8, arr, special.get(env.world + '/lightmaps/' + tex + '.vtex')!);
      bind(11, arr, env.env);
      bind(12, arr, skyTexture);
      bind(13, arr, env.lpv);
      bind(14, arr, env.shadow);
      bind(16, gl.TEXTURE_2D, env.probes);
      bind(21, gl.TEXTURE_2D, env.grid);
      gl.uniform3fv(world.u('gridMin'), env.spatial.min);
      gl.uniform3fv(world.u('gridInv'), env.spatial.invStep);
      for (const blended of [false, true]) {
        if (blended) {
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        } else gl.disable(gl.BLEND);
        gl.depthMask(!blended);
        type Group = {
          banks: number[];
          side: boolean;
          family: string;
          list: { first: number; count: number }[];
        };
        const groups: Group[] = [],
          opaqueGroups = new Map<string, Group>();
        const byDepth: {
          c: (typeof chunks)[number];
          key: string;
          first: number;
          count: number;
          depth: number;
          rect: ScreenRect;
        }[] = [];
        const append = (group: Group, first: number, count: number) => {
          const last = group.list.at(-1);
          if (last && last.first + last.count === first) last.count += count;
          else group.list.push({ first, count });
        };
        for (const c of chunks) {
          if (
            c.sky !== env.sky ||
            transparent(c.family) !== blended ||
            !frustum.intersectsBox(c.box)
          )
            continue;
          const key = c.family + '/' + c.side + '/' + c.banks.join();
          for (const r of c.ranges) {
            if (
              (r.entity >= 0 && !m.entities[r.entity].initialVisibility) ||
              !frustum.intersectsBox(r.box)
            )
              continue;
            if (blended) {
              const center = r.box.getCenter(new Vector3()).applyMatrix4(cam.matrixWorldInverse);
              byDepth.push({
                c,
                key,
                first: r.first,
                count: r.count,
                depth: center.z,
                rect: projectedBounds(r.bounds, vp.elements, width, height),
              });
              continue;
            }
            let group = opaqueGroups.get(key);
            if (!group) {
              group = { ...c, list: [] };
              opaqueGroups.set(key, group);
              groups.push(group);
            }
            append(group, r.first, r.count);
          }
        }
        byDepth.sort((a, b) => a.depth - b.depth || a.first - b.first);
        for (const batch of transparentGroups(byDepth)) {
          const group: Group = { ...batch[0].c, list: [] };
          groups.push(group);
          for (const r of batch) append(group, r.first, r.count);
        }
        for (const { side, family, banks, list } of groups) {
          if (!list.length) continue;
          if (blended) {
            if (family === 'additive') gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
            else if (family === 'modulate') gl.blendFunc(gl.DST_COLOR, gl.SRC_COLOR);
            else gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
          }
          if (side) gl.disable(gl.CULL_FACE);
          else gl.enable(gl.CULL_FACE);
          if (family === 'overlay' || family === 'modulate') {
            gl.enable(gl.POLYGON_OFFSET_FILL);
            gl.polygonOffset(-1, -1);
          } else gl.disable(gl.POLYGON_OFFSET_FILL);
          banks.forEach((id, i) =>
            bind(i < 8 ? i : i < 11 ? i + 9 : i + 11, arr, arrays[id] ?? arrays[0]),
          );
          for (let i = 0; i < list.length; i++) {
            const { first, count } = list[i];
            multiOffsets[i] = first * 4;
            multiCounts[i] = count;
            triangles += count / 3;
          }
          if (ext) {
            ext.multiDrawElementsWEBGL(
              gl.TRIANGLES,
              multiCounts,
              0,
              gl.UNSIGNED_INT,
              multiOffsets,
              0,
              list.length,
            );
            draws++;
          } else
            for (const r of list) {
              gl.drawElements(gl.TRIANGLES, r.count, gl.UNSIGNED_INT, r.first * 4);
              draws++;
            }
        }
      }
    }
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    post.use();
    bind(0, gl.TEXTURE_2D, hdr);
    bind(1, gl.TEXTURE_2D, lut);
    gl.uniform1i(post.u('hdr'), 0);
    gl.uniform1i(post.u('lut'), 1);
    const c = params.tonemap,
      b = params.bloom;
    gl.uniform4f(
      post.u('curve'),
      c.m_flShoulderStrength,
      c.m_flLinearStrength,
      c.m_flLinearAngle,
      c.m_flToeStrength,
    );
    gl.uniform4f(
      post.u('toe'),
      c.m_flToeNum,
      c.m_flToeDenom,
      2.8 * c.m_flWhitePoint,
      2.8 * exposure * 2 ** (c.m_flExposureBias - 0.4),
    );
    gl.uniform4f(
      post.u('bloom'),
      b.m_flBloomThreshold,
      b.m_flBloomThresholdWidth,
      b.m_flBloomStrength,
      0,
    );
    gl.uniform1i(post.u('bypass'), mode === 0 ? 0 : 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const error = gl.getError();
    if (error) throw Error('Render GL error 0x' + error.toString(16));
    return {
      draws: draws + 1,
      triangles: triangles + 1,
      textureBytes: textureBytes + 8 * width * height,
      submissionMs: performance.now() - start,
      multiDraw: Boolean(ext),
    };
  };
}
