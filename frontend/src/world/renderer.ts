// Material and lighting bindings adapted from ValveResourceFormat 21.1 (MIT). See tools/cs2export/THIRD_PARTY_NOTICES.txt.
import { capabilities, tierUnits, type TextureTier } from './textures';
import { worldResources } from './resources';
import { sourceToViewer } from './space';
import { program } from './program';
import { projectedBounds, transparentGroups, type ScreenRect } from './transparency';
import { asVector as numbers } from './probe-grid';
import { materialRows } from './material-table';
import { worldEnvironments } from './environment';
import { Frustum, Matrix4, PerspectiveCamera, Vector3, Box3 } from 'three';
import { decodeVertices } from './geometry';
import { MeshoptDecoder } from 'meshoptimizer';
import { assetReader } from './asset-reader';
import { type Manifest } from './format';
import { createTextureStream } from './stream';
import { vertex, worldFrag, screenVertex, skyFrag, postFrag } from './shaders';

export interface ComposedFrame {
  camera: PerspectiveCamera;
  framebuffer: WebGLFramebuffer;
  hdr: WebGLTexture;
  opaque: () => void;
  transparent: () => void;
  equipment: () => void;
}
export interface ViewOptions {
  composed?: ComposedFrame;
  shadow?: { texture: WebGLTexture; projection: Float32Array; bias: number };
  skybox3D?: boolean;
  fog?: boolean;
}
export interface Pose {
  pos: number[];
  ang: number[];
  fov: number;
}
const rad = Math.PI / 180;
export async function createRenderer(
  gl: WebGL2RenderingContext,
  dir: URL,
  manifest: Manifest,
  signal?: AbortSignal,
  forcedTier?: TextureTier,
) {
  const tier = capabilities(gl, forcedTier);
  const textures = tier === 'phone' ? manifest.phone : manifest;
  const resources = worldResources(gl);
  const abort = () => resources.dispose();
  signal?.throwIfAborted();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const sky = program(gl, screenVertex, skyFrag),
      post = program(gl, screenVertex, postFrag);
    resources.retain(sky.dispose);
    resources.retain(post.dispose);
    const ext = gl.getExtension('WEBGL_multi_draw');
    let textureBytes = 0;
    const reader = assetReader(dir, manifest);
    resources.retain(reader.close);
    const fetchAsset = reader.read;
    const streaming = createTextureStream(gl, fetchAsset, resources, signal);
    const arrays: WebGLTexture[] = [],
      special = new Map<string, WebGLTexture>();
    for (const b of textures.arrays) {
      arrays.push(streaming.register(b.file, b.format, b.srgb, b.mips, b.textures.length, b.flags));
    }
    // The main world's enabled env_sky, else any world's; its cube texture, else no backdrop.
    const skies = [...manifest.environments]
      .sort((a, b) => Number(a.sky) - Number(b.sky))
      .flatMap((environment) => environment.entities.filter((e) => e.classname === 'env_sky'))
      .sort((a, b) => Number(Boolean(a.startdisabled)) - Number(Boolean(b.startdisabled)));
    const isCube = (name: unknown) =>
      typeof name === 'string' && (textures.specials[name]?.levels.at(-1)?.d ?? 0) % 6 === 0;
    let skyEntity: (typeof skies)[number] | undefined,
      skyMaterial: (typeof manifest.materials)[number] | undefined,
      skyName: string | undefined;
    for (const entity of skies) {
      const material = manifest.materials.find((mat) => mat.name === entity.skyname);
      const slots = Object.entries(material?.slots ?? {});
      const name = [material?.slots.g_tSkyTexture, ...slots.map(([, value]) => value)].find(isCube);
      if (material && typeof name === 'string') {
        [skyEntity, skyMaterial, skyName] = [entity, material, name];
        break;
      }
    }
    const required = new Set(['vrf/brdf_lut', ...(skyName ? [skyName] : [])]);
    for (const env of manifest.environments) {
      if (tier === 'phone') required.add(manifest.phone.lightmaps[env.world]);
      else
        for (const kind of ['irradiance', 'directional_irradiance', 'direct_light_shadows'])
          required.add(env.world + '/lightmaps/' + kind + '.vtex');
      for (const e of env.entities)
        for (const key of ['cubemaptexture', 'lightprobetexture', 'lightprobetexture_dlshd'])
          if (typeof e[key] === 'string' && !(tier === 'phone' && key.endsWith('_dlshd')))
            required.add(e[key]);
    }
    for (const [name, t] of Object.entries(textures.specials)) {
      if (!required.has(name)) continue;
      special.set(
        name.replaceAll('\\', '/'),
        streaming.register(t.file, t.format, false, t.levels, t.levels.at(-1)!.d!, t.flags | 3),
      );
    }
    textureBytes += streaming.allocatedBytes;
    const controller = manifest.environments
      .find((environment) => !environment.sky)
      ?.entities.find(
        (entity) =>
          entity.classname === 'post_processing_volume' && entity.master && !entity.startdisabled,
      );
    const params =
      manifest.post[String(controller?.postprocessing)] ?? Object.values(manifest.post)[0];
    const exposure = controller?.enableexposure ? Number(controller.minexposure ?? 1) : 1;
    const lut = resources.texture();
    const dimension = params.dimension;
    const [lutPayload, indexPayload, vertexPayload] = await Promise.all([
      fetchAsset(params.lut),
      fetchAsset(manifest.geometry.ib),
      fetchAsset(manifest.geometry.vb),
      streaming.bootstrap(),
    ]);
    signal?.throwIfAborted();
    const cube = lutPayload;
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
      const tex = resources.texture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, values);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      textureBytes += values.byteLength;
      return tex;
    }
    const environments = worldEnvironments(manifest, tier, special, table, materialRows(manifest));
    await MeshoptDecoder.ready;
    const geometrySpec = manifest.geometry,
      vertexArray = gl.createVertexArray();
    resources.retain(() => gl.deleteVertexArray(vertexArray));
    gl.bindVertexArray(vertexArray);
    const indices = new Uint32Array(geometrySpec.indices);
    MeshoptDecoder.decodeIndexBuffer(
      new Uint8Array(indices.buffer),
      geometrySpec.indices,
      4,
      indexPayload,
    );
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, resources.buffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    const vertices = decodeVertices(manifest, vertexPayload, indices);
    gl.bindBuffer(gl.ARRAY_BUFFER, resources.buffer());
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
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
      if (integer) gl.vertexAttribIPointer(index, count, type, geometrySpec.stride, offset);
      else gl.vertexAttribPointer(index, count, type, !!norm, geometrySpec.stride, offset);
    }
    gl.bindVertexArray(null);
    const hdr = resources.texture(),
      frame = gl.createFramebuffer(),
      depth = gl.createRenderbuffer();
    resources.retain(() => gl.deleteFramebuffer(frame));
    resources.retain(() => gl.deleteRenderbuffer(depth));
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
    const camera = new PerspectiveCamera(),
      viewProjection = new Matrix4(),
      frustum = new Frustum();
    camera.up.set(0, 0, 1);
    camera.near = 1;
    camera.far = 250000;
    const skyTexture = skyName ? special.get(skyName.replaceAll('\\', '/')) : undefined;
    const skyRange = tier === 'phone' && skyName ? (manifest.phone.hdr[skyName] ?? 0) : 0;
    const skyGain =
      Number(skyEntity?.brightnessscale ?? 1) *
      2 **
        ((skyMaterial?.scalars.g_flBrightnessExposureBias ?? 0) +
          (skyMaterial?.scalars.g_flRenderOnlyExposureBias ?? 0));
    const bounds = (a: number[]) =>
      new Box3(new Vector3(...a.slice(0, 3)), new Vector3(...a.slice(3)));
    const chunks = manifest.chunks.map((chunk) => ({
      ...chunk,
      box: bounds(chunk.bounds),
      ranges: chunk.ranges.map((range) => ({ ...range, box: bounds(range.bounds) })),
    }));
    const identity = new Matrix4();
    const transforms = new Map<number, Matrix4>();
    const visibility = manifest.entities.map((entity) => entity.initialVisibility);
    const entityChunks = new Map<number, typeof chunks>();
    for (const chunk of chunks) {
      const entity = chunk.ranges[0]?.entity ?? -1;
      if (entity >= 0) {
        const list = entityChunks.get(entity) ?? [];
        entityChunks.set(entity, list);
        list.push(chunk);
      }
    }
    function updateEntity(entity: number, matrix: Matrix4, visible: boolean) {
      visibility[entity] = visible;
      const previous = transforms.get(entity) ?? identity;
      if (matrix.equals(previous)) return;
      if (matrix.equals(identity)) transforms.delete(entity);
      else transforms.set(entity, matrix.clone());
      for (const chunk of entityChunks.get(entity) ?? []) {
        chunk.box.makeEmpty();
        for (const r of chunk.ranges) {
          r.box.copy(bounds(r.bounds)).applyMatrix4(matrix);
          chunk.box.union(r.box);
        }
      }
    }
    const transparent = (family: string) =>
      ['glass', 'blended', 'overlay', 'additive', 'modulate'].includes(family);
    function bind(unit: number, target: number, tex: WebGLTexture | null) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(target, tex);
    }
    const arrayTarget = gl.TEXTURE_2D_ARRAY;
    // Fixed lighting inputs take the first units; the variant's material slots follow.
    const fixedSamplers =
      tier === 'phone'
        ? ['sceneData', 'brdf', 'actorShadow', 'envMap', 'skyMap', 'lpv', 'lightAtlas']
        : [
            'sceneData',
            'brdf',
            'actorShadow',
            'envMap',
            'skyMap',
            'lpv',
            'lpvShadow',
            'irradiance',
            'directional',
            'shadowMap',
          ];
    const unit = Object.fromEntries(fixedSamplers.map((name, index) => [name, index]));
    const roleSamplers: Record<string, string> = {
      color: 'colorTex',
      normal: 'normalTex',
      ao: 'aoTex',
      color2: 'color2Tex',
      normal2: 'normal2Tex',
      blend: 'blendTex',
      detail: 'detailTex',
      metal: 'metalTex',
      aux0: 'aux0',
      aux1: 'aux1',
      aux2: 'aux2',
      illum: 'illumTex',
      detailMask: 'detailMask',
      ao2: 'ao2Tex',
      height: 'heightTex',
      rough: 'roughTex',
    };
    const slotLimit = tierUnits[tier] - fixedSamplers.length;
    type Variant = ReturnType<typeof program> & { version: number; slots: number[] };
    const variants = new Map<string, Variant>();
    const uniformState = new Map<string, (p: Variant) => void>();
    let stateVersion = 0,
      current: Variant | null = null;
    function setUniform(name: string, apply: (p: Variant) => void) {
      const fresh = current?.version === stateVersion;
      uniformState.set(name, apply);
      stateVersion++;
      if (current && fresh) {
        apply(current);
        current.version = stateVersion;
      }
    }
    // Unused roles alias slot 0; their material layers are -1, so they are never sampled.
    function variant(banks: number[]) {
      const used = manifest.roles.map((_, index) => index).filter((index) => banks[index] >= 0);
      const key = used.join();
      let found = variants.get(key);
      if (!found) {
        if (used.length > slotLimit) throw Error('Material uses more texture roles than supported');
        const declarations = [
          ...Array.from(
            { length: Math.max(1, used.length) },
            (_, slot) => `uniform sampler2DArray slot${slot};`,
          ),
          ...manifest.roles.map(
            (role, index) =>
              `#define ${roleSamplers[role]} slot${Math.max(0, used.indexOf(index))}`,
          ),
        ].join('\n');
        const source = worldFrag
          .replace('\n', tier === 'phone' ? '\n#define PACKED_LIGHTING\n' : '\n')
          .replace('#pragma roles', declarations);
        const compiled = program(gl, vertex, source);
        resources.retain(compiled.dispose);
        compiled.use();
        for (const [name, index] of Object.entries(unit)) gl.uniform1i(compiled.u(name), index);
        const slots = used.length ? used : [-1];
        slots.forEach((_, slot) =>
          gl.uniform1i(compiled.u('slot' + slot), fixedSamplers.length + slot),
        );
        found = Object.assign(compiled, { version: -1, slots });
        variants.set(key, found);
        current = null;
      }
      return found;
    }
    function uniform(method: string, name: string, ...values: unknown[]) {
      setUniform(name, (p) =>
        (gl as unknown as Record<string, (...args: unknown[]) => void>)[method](
          p.u(name),
          ...values,
        ),
      );
    }
    function useVariant(banks: number[]) {
      const next = variant(banks);
      if (current !== next) {
        next.use();
        current = next;
      }
      if (next.version !== stateVersion) {
        for (const apply of uniformState.values()) apply(next);
        next.version = stateVersion;
      }
      next.slots.forEach((role, slot) =>
        bind(fixedSamplers.length + slot, arrayTarget, arrays[banks[role]] ?? arrays[0]),
      );
    }
    // Compile the variants this map uses before the first frame.
    for (const chunk of manifest.chunks) variant(chunk.banks);
    const multiCounts = new Int32Array(8192),
      multiOffsets = new Int32Array(8192);
    let renderedFrames = 0;
    function render(pose: Pose, mode: number, options: ViewOptions = {}) {
      const start = performance.now();
      const composed = options.composed;
      if (composed) {
        width = gl.drawingBufferWidth;
        height = gl.drawingBufferHeight;
      } else if (width !== gl.drawingBufferWidth || height !== gl.drawingBufferHeight) resize();
      camera.aspect = width / height;
      camera.fov = pose.fov;
      camera.position.fromArray(pose.pos);
      const [pitch, yaw] = pose.ang.map((a) => a * rad);
      camera.lookAt(
        camera.position
          .clone()
          .add(
            new Vector3(
              Math.cos(pitch) * Math.cos(yaw),
              Math.cos(pitch) * Math.sin(yaw),
              -Math.sin(pitch),
            ),
          ),
      );
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld();
      viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      if (composed) {
        composed.camera.updateMatrixWorld();
        camera.matrixWorldInverse.multiplyMatrices(
          composed.camera.matrixWorldInverse,
          sourceToViewer,
        );
        viewProjection.multiplyMatrices(
          composed.camera.projectionMatrix,
          camera.matrixWorldInverse,
        );
      }
      frustum.setFromProjectionMatrix(viewProjection);
      gl.viewport(0, 0, width, height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, composed?.framebuffer ?? frame);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      gl.disable(gl.BLEND);
      sky.use();
      gl.uniformMatrix4fv(sky.u('unproject'), false, viewProjection.clone().invert().elements);
      gl.uniform3fv(sky.u('eye'), pose.pos);
      gl.uniform1f(sky.u('gain'), mode === 7 ? 0 : skyGain);
      gl.uniform1i(sky.u('skyMap'), 12);
      gl.uniform1f(sky.u('hdrRange'), skyRange);
      bind(12, arrayTarget, skyTexture ?? null);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      let draws = 1,
        triangles = 1;
      current = null;
      gl.bindVertexArray(vertexArray);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.cullFace(gl.BACK);
      uniform('uniformMatrix4fv', 'viewProjection', false, viewProjection.elements);
      uniform('uniform3fv', 'eye', pose.pos);
      uniform('uniform1i', 'mode', mode);
      bind(unit.brdf, arrayTarget, special.get('vrf/brdf_lut')!);
      uniform('uniform1i', 'hasActorShadow', Number(!!options.shadow));
      // A shadow sampler must never see an ordinary colour texture left on its unit.
      bind(unit.actorShadow, gl.TEXTURE_2D, options.shadow?.texture ?? null);
      if (options.shadow) {
        uniform('uniformMatrix4fv', 'actorProjection', false, options.shadow.projection);
        uniform('uniform1f', 'actorBias', options.shadow.bias);
      }
      gl.stencilMask(0xff);
      gl.clearStencil(0);
      gl.clear(gl.STENCIL_BUFFER_BIT);
      for (const env of environments) {
        if (env.sky && options.skybox3D === false) continue;
        gl.depthMask(true);
        gl.clear(gl.DEPTH_BUFFER_BIT);
        uniform('uniformMatrix4fv', 'localFromWorld', false, env.inverse.elements);
        uniform('uniform2fv', 'lightScale', env.lighting.m_vLightmapUvScale);
        uniform('uniform1f', 'envLastMip', env.envLastMip);
        uniform('uniform3fv', 'sunDir', env.lightDir);
        uniform('uniform3fv', 'sunColor', env.color);
        const gradient =
          options.fog !== false &&
          env.entities.find((e) => e.classname === 'env_gradient_fog' && !e.startdisabled);
        uniform(
          'uniform4fv',
          'gradientColor',
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
          uniform(
            'uniform4f',
            'gradientScale',
            -start / (end - start),
            heightScale === 0 ? 1 : -hi * heightScale,
            1 / (end - start),
            heightScale,
          );
          uniform(
            'uniform2f',
            'gradientExponents',
            Number(gradient.fogfalloffexponent ?? 1),
            Number(gradient.fogverticalexponent ?? 1),
          );
        }
        const fog = env.entities.find((e) => e.classname === 'env_cubemap_fog' && !e.startdisabled);
        uniform(
          'uniform4f',
          'fogDist',
          Number(fog?.cubemapfogstartdistance ?? 0),
          Number(fog?.cubemapfogenddistance ?? 1),
          Number(fog?.cubemapfogfalloffexponent ?? 1),
          options.fog === false ? 0 : Number(fog?.cubemapfogmaxopacity ?? 0),
        );
        uniform(
          'uniform4f',
          'fogHeight',
          Number(fog?.cubemapfogheightstart ?? 0),
          Number(fog?.cubemapfogheightend ?? 1),
          Number(fog?.cubemapfogheightexponent ?? 1),
          Number(fog?.cubemapfoglodbiase ?? 1),
        );
        for (const blended of [false, true]) {
          if (blended && composed && !env.sky) {
            composed.opaque();
            gl.bindFramebuffer(gl.FRAMEBUFFER, composed.framebuffer);
            gl.viewport(0, 0, width, height);
            current = null;
            gl.bindVertexArray(vertexArray);
            gl.enable(gl.DEPTH_TEST);
            gl.depthFunc(gl.LEQUAL);
            gl.cullFace(gl.BACK);
            bind(unit.brdf, arrayTarget, special.get('vrf/brdf_lut')!);
            bind(unit.actorShadow, gl.TEXTURE_2D, options.shadow?.texture ?? null);
          }
          env.lightmaps.forEach((texture, index) =>
            bind(unit[env.lightmapSamplers[index]], arrayTarget, texture),
          );
          bind(unit.envMap, arrayTarget, env.env);
          bind(unit.skyMap, arrayTarget, skyTexture ?? null);
          bind(unit.lpv, arrayTarget, env.lpv);
          if (tier === 'desktop') bind(unit.lpvShadow, arrayTarget, env.shadow);
          bind(unit.sceneData, gl.TEXTURE_2D, env.data);
          uniform('uniform1i', 'probeBase', env.probeBase);
          uniform('uniform1i', 'cellColumn', env.cellColumn);
          uniform('uniform4fv', 'volumeLayers', env.volumeLayers);
          uniform('uniform4f', 'hdrRange', env.hdr[0], env.hdr[1], skyRange, env.hdr[2]);
          uniform('uniform3fv', 'gridMin', env.spatial.min);
          uniform('uniform3fv', 'gridInv', env.spatial.invStep);
          if (blended && mode !== 7) {
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
          } else gl.disable(gl.BLEND);
          gl.depthMask(!blended);
          type Group = {
            banks: number[];
            side: boolean;
            family: string;
            entity?: number;
            list: { first: number; count: number }[];
          };
          const groups: Group[] = [],
            opaqueGroups = new Map<string, Group>();
          const byDepth: {
            chunk: (typeof chunks)[number];
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
          for (const chunk of chunks) {
            if (
              chunk.sky !== env.sky ||
              transparent(chunk.family) !== blended ||
              !frustum.intersectsBox(chunk.box)
            )
              continue;
            const placed = chunk.ranges[0].entity;
            const key =
              chunk.family +
              '/' +
              chunk.side +
              '/' +
              chunk.banks.join() +
              '/' +
              (transforms.has(placed) ? placed : -1);
            for (const range of chunk.ranges) {
              if (
                (range.entity >= 0 && !visibility[range.entity]) ||
                !frustum.intersectsBox(range.box)
              )
                continue;
              if (mode === 7) gl.disable(gl.BLEND);
              if (blended && mode !== 7) {
                const center = range.box
                  .getCenter(new Vector3())
                  .applyMatrix4(camera.matrixWorldInverse);
                byDepth.push({
                  chunk,
                  key,
                  first: range.first,
                  count: range.count,
                  depth: center.z,
                  rect: projectedBounds(
                    transforms.has(placed)
                      ? [...range.box.min.toArray(), ...range.box.max.toArray()]
                      : range.bounds,
                    viewProjection.elements,
                    width,
                    height,
                  ),
                });
                continue;
              }
              let group = opaqueGroups.get(key);
              if (!group) {
                group = { ...chunk, entity: placed, list: [] };
                opaqueGroups.set(key, group);
                groups.push(group);
              }
              append(group, range.first, range.count);
            }
          }
          byDepth.sort((a, b) => a.depth - b.depth || a.first - b.first);
          for (const batch of transparentGroups(byDepth)) {
            const group: Group = {
              ...batch[0].chunk,
              entity: batch[0].chunk.ranges[0].entity,
              list: [],
            };
            groups.push(group);
            for (const range of batch) append(group, range.first, range.count);
          }
          for (const { side, family, banks, list, entity } of groups) {
            if (!list.length) continue;
            uniform(
              'uniformMatrix4fv',
              'entityTransform',
              false,
              (transforms.get(entity ?? -1) ?? identity).elements,
            );
            if (mode === 7) gl.disable(gl.BLEND);
            if (blended && mode !== 7) {
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
            useVariant(banks);
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
              for (const range of list) {
                gl.drawElements(gl.TRIANGLES, range.count, gl.UNSIGNED_INT, range.first * 4);
                draws++;
              }
          }
        }
      }
      composed?.transparent();
      composed?.equipment();
      gl.disable(gl.POLYGON_OFFSET_FILL);
      gl.disable(gl.BLEND);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      gl.bindVertexArray(null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, width, height);
      post.use();
      bind(0, gl.TEXTURE_2D, composed?.hdr ?? hdr);
      bind(1, gl.TEXTURE_2D, lut);
      gl.uniform1i(post.u('hdr'), 0);
      gl.uniform1i(post.u('lut'), 1);
      const curve = params.tonemap,
        bloomParams = params.bloom;
      gl.uniform4f(
        post.u('curve'),
        curve.m_flShoulderStrength,
        curve.m_flLinearStrength,
        curve.m_flLinearAngle,
        curve.m_flToeStrength,
      );
      gl.uniform4f(
        post.u('toe'),
        curve.m_flToeNum,
        curve.m_flToeDenom,
        2.8 * curve.m_flWhitePoint,
        2.8 * exposure * 2 ** (curve.m_flExposureBias - 0.4),
      );
      gl.uniform4f(
        post.u('bloom'),
        bloomParams.m_flBloomThreshold,
        bloomParams.m_flBloomThresholdWidth,
        bloomParams.m_flBloomStrength,
        0,
      );
      gl.uniform1i(post.u('materialIds'), Number(mode === 7));
      gl.uniform1i(post.u('bypass'), mode === 0 ? 0 : 1);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      // getError waits for the GPU process, so it samples the first and every 60th frame.
      if (renderedFrames++ % 60 === 0) {
        const error = gl.getError();
        if (error) throw Error('Render GL error 0x' + error.toString(16));
      }
      return {
        draws: draws + 1,
        triangles: triangles + 1,
        textureBytes: textureBytes + 8 * width * height,
        submissionMs: performance.now() - start,
        multiDraw: Boolean(ext),
      };
    }
    const tone = params.tonemap;
    return {
      render,
      updateEntity,
      // Display-referred overlays (x-ray shells) scale by this so the fixed exposure and
      // white point of the map grade return their authored colour.
      displayScale:
        (2.8 * tone.m_flWhitePoint) / (2.8 * exposure * 2 ** (tone.m_flExposureBias - 0.4)),
      environments,
      geometry: { vertices, indices },
      dispose() {
        signal?.removeEventListener('abort', abort);
        resources.dispose();
      },
      refine: (invalidate: () => void) => streaming.refine(invalidate).finally(reader.close),
    };
  } catch (error) {
    signal?.removeEventListener('abort', abort);
    resources.dispose();
    throw error;
  }
}
export type NativeRenderer = Awaited<ReturnType<typeof createRenderer>>;
