// Material and lighting bindings adapted from ValveResourceFormat 21.1 (MIT). See tools/cs2export/THIRD_PARTY_NOTICES.txt.
import { capabilities } from './textures';
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
) {
  capabilities(gl);
  const resources = worldResources(gl);
  const abort = () => resources.dispose();
  signal?.throwIfAborted();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const world = program(gl, vertex, worldFrag),
      sky = program(gl, screenVertex, skyFrag),
      post = program(gl, screenVertex, postFrag);
    resources.retain(world.dispose);
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
    for (const b of manifest.arrays) {
      arrays.push(streaming.register(b.file, b.format, b.srgb, b.mips, b.textures.length, b.flags));
    }
    const skyEntity = manifest.environments
      .find((e) => !e.sky)
      ?.entities.find((e) => e.classname === 'env_sky' && !e.startdisabled);
    const skyMaterial = manifest.materials.find((mat) => mat.name === skyEntity?.skyname);
    const skyName = skyMaterial?.slots?.g_tSkyTexture;
    if (typeof skyName !== 'string') throw Error('Missing sky material texture');
    const required = new Set([skyName, 'vrf/brdf_lut']);
    for (const env of manifest.environments) {
      for (const kind of ['irradiance', 'directional_irradiance', 'direct_light_shadows'])
        required.add(env.world + '/lightmaps/' + kind + '.vtex');
      for (const e of env.entities)
        for (const key of ['cubemaptexture', 'lightprobetexture', 'lightprobetexture_dlshd'])
          if (typeof e[key] === 'string') required.add(e[key]);
    }
    for (const [name, t] of Object.entries(manifest.specials)) {
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
    const materialTable = table(36, manifest.materials.length, materialRows(manifest));
    const environments = worldEnvironments(manifest, special, table);
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
    const skyTexture = special.get(skyName)!;
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
    const transparent = (family: string) =>
      ['glass', 'blended', 'overlay', 'additive', 'modulate'].includes(family);
    function bind(unit: number, target: number, tex: WebGLTexture | null) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(target, tex);
    }
    const arrayTarget = gl.TEXTURE_2D_ARRAY;
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
      bind(12, arrayTarget, skyTexture);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      let draws = 1,
        triangles = 1;
      world.use();
      gl.bindVertexArray(vertexArray);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.cullFace(gl.BACK);
      gl.uniformMatrix4fv(world.u('viewProjection'), false, viewProjection.elements);
      gl.uniform3fv(world.u('eye'), pose.pos);
      gl.uniform1i(world.u('mode'), mode);
      bind(15, gl.TEXTURE_2D, materialTable);
      bind(20, arrayTarget, special.get('vrf/brdf_lut')!);
      gl.uniform1i(world.u('hasActorShadow'), Number(!!options.shadow));
      gl.uniform1i(world.u('actorShadow'), 27);
      if (options.shadow) {
        bind(27, gl.TEXTURE_2D, options.shadow.texture);
        gl.uniformMatrix4fv(world.u('actorProjection'), false, options.shadow.projection);
        gl.uniform1f(world.u('actorBias'), options.shadow.bias);
      }
      for (const env of environments) {
        if (env.sky && options.skybox3D === false) continue;
        gl.depthMask(true);
        gl.clear(gl.DEPTH_BUFFER_BIT);
        gl.uniformMatrix4fv(world.u('localFromWorld'), false, env.inverse.elements);
        gl.uniform2fv(world.u('lightScale'), env.lighting.m_vLightmapUvScale);
        gl.uniform1f(world.u('envLastMip'), env.envLastMip);
        gl.uniform3fv(world.u('sunDir'), env.lightDir);
        gl.uniform3fv(world.u('sunColor'), env.color);
        const gradient =
          options.fog !== false &&
          env.entities.find((e) => e.classname === 'env_gradient_fog' && !e.startdisabled);
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
          options.fog === false ? 0 : Number(fog?.cubemapfogmaxopacity ?? 0),
        );
        gl.uniform4f(
          world.u('fogHeight'),
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
            world.use();
            gl.bindVertexArray(vertexArray);
            gl.enable(gl.DEPTH_TEST);
            gl.depthFunc(gl.LEQUAL);
            gl.cullFace(gl.BACK);
            bind(15, gl.TEXTURE_2D, materialTable);
            bind(20, arrayTarget, special.get('vrf/brdf_lut')!);
          }
          for (const [i, tex] of [
            'irradiance',
            'directional_irradiance',
            'direct_light_shadows',
          ].entries())
            bind(i + 8, arrayTarget, special.get(env.world + '/lightmaps/' + tex + '.vtex')!);
          bind(11, arrayTarget, env.env);
          bind(12, arrayTarget, skyTexture);
          bind(13, arrayTarget, env.lpv);
          bind(14, arrayTarget, env.shadow);
          bind(16, gl.TEXTURE_2D, env.probes);
          bind(21, gl.TEXTURE_2D, env.grid);
          gl.uniform3fv(world.u('gridMin'), env.spatial.min);
          gl.uniform3fv(world.u('gridInv'), env.spatial.invStep);
          if (blended && mode !== 7) {
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
            const key = chunk.family + '/' + chunk.side + '/' + chunk.banks.join();
            for (const range of chunk.ranges) {
              if (
                (range.entity >= 0 && !manifest.entities[range.entity].initialVisibility) ||
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
                  rect: projectedBounds(range.bounds, viewProjection.elements, width, height),
                });
                continue;
              }
              let group = opaqueGroups.get(key);
              if (!group) {
                group = { ...chunk, list: [] };
                opaqueGroups.set(key, group);
                groups.push(group);
              }
              append(group, range.first, range.count);
            }
          }
          byDepth.sort((a, b) => a.depth - b.depth || a.first - b.first);
          for (const batch of transparentGroups(byDepth)) {
            const group: Group = { ...batch[0].chunk, list: [] };
            groups.push(group);
            for (const range of batch) append(group, range.first, range.count);
          }
          for (const { side, family, banks, list } of groups) {
            if (!list.length) continue;
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
            banks.forEach((id, i) =>
              bind(i < 8 ? i : i < 11 ? i + 9 : i + 11, arrayTarget, arrays[id] ?? arrays[0]),
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
      const error = gl.getError();
      if (error) throw Error('Render GL error 0x' + error.toString(16));
      return {
        draws: draws + 1,
        triangles: triangles + 1,
        textureBytes: textureBytes + 8 * width * height,
        submissionMs: performance.now() - start,
        multiDraw: Boolean(ext),
      };
    }
    return {
      render,
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
