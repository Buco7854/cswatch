// Bundled only by the offline CLI. All routes including the model are fulfilled locally.
import * as T from 'three';
import { GLTFLoader, MeshoptDecoder } from 'three-stdlib';
import {
  applyEnvironmentAlbedo,
  registerEnvironmentAlbedo,
} from '../../frontend/src/environment-albedo';
import { registerMapBakedLighting } from '../../frontend/src/map-baked-lighting';
import { reusePackedSceneSamples } from '../../frontend/src/packed-material';
import { improveMapTextureDetail } from '../../frontend/src/map-texture-detail';
import { assertMapBaseColorTextures, prepareMapModel } from '../../frontend/src/map-model';
import { installMapDrawRanges } from '../../frontend/src/map-draw-range';

window.prepareCapture = async ({ tier, projection, settings }) => {
  const renderer = new T.WebGLRenderer({
    antialias: false,
    alpha: false,
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(1);
  renderer.setSize(projection.width, projection.height);
  renderer.outputColorSpace = T.SRGBColorSpace;
  renderer.toneMapping = T.ACESFilmicToneMapping;
  renderer.toneMappingExposure = settings.exposure;
  renderer.setClearColor(settings.clearColor);
  document.body.append(renderer.domElement);
  const gl = renderer.getContext(),
    debug = gl.getExtension('WEBGL_debug_renderer_info');
  const loader = new GLTFLoader().setMeshoptDecoder(
    typeof MeshoptDecoder === 'function' ? MeshoptDecoder() : MeshoptDecoder,
  );
  registerMapBakedLighting(loader);
  registerEnvironmentAlbedo(loader);
  const gltf = await loader.loadAsync('scene.glb');
  assertMapBaseColorTextures(gltf);
  applyEnvironmentAlbedo(gltf);
  reusePackedSceneSamples(gltf.scenes);
  improveMapTextureDetail(gltf.scenes, tier);
  const { main } = prepareMapModel(gltf.scene, gltf.animations);
  const scene = new T.Scene();
  scene.add(
    main,
    new T.HemisphereLight(
      settings.hemisphere.sky,
      settings.hemisphere.ground,
      settings.hemisphere.intensity,
    ),
  );
  const key = new T.DirectionalLight(settings.key.color, settings.key.intensity);
  key.position.fromArray(settings.key.position);
  scene.add(key);
  installMapDrawRanges(renderer, scene, main);
  const camera = new T.PerspectiveCamera(
    projection.verticalFovDegrees,
    projection.width / projection.height,
    projection.near,
    projection.far,
  );
  const definitions = gltf.parser.json.materials ?? [];
  const live = new Map();
  main.traverse((node) => {
    if (!node.isMesh) return;
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
      const index = gltf.parser.associations.get(material)?.materials;
      if (index === undefined) continue;
      if (!live.has(index)) live.set(index, new Set());
      live.get(index).add(material);
    }
  });
  function findMaterials(view) {
    if (view.action === 'omit' || view.action.startsWith('omit_'))
      return { status: 'unavailable', reason: 'omission-policy' };
    if (!view.materialName) return { status: 'unavailable', reason: 'missing-material-name' };
    const indices = [];
    for (const [index, material] of definitions.entries()) {
      const vmat = material.extras?.vmat;
      if ((vmat?.Name || material.name) !== view.materialName) continue;
      if (
        vmat?.ShaderName &&
        view.shader &&
        vmat.ShaderName.replace(/\.vfx$/, '') !== view.shader.replace(/\.vfx$/, '')
      )
        continue;
      indices.push(index);
    }
    if (indices.length > 1) return { status: 'ambiguous', reason: 'multiple-material-definitions' };
    const materials = live.get(indices[0]);
    return materials?.size
      ? { materials }
      : { status: 'unavailable', reason: 'no-matching-main-world-material' };
  }
  const pixel = new Uint8Array(4);
  function render() {
    renderer.render(scene, camera);
    // Force actual framebuffer completion; covers CPU submission, GPU work and the readback.
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    if (gl.isContextLost() || gl.getError() !== gl.NO_ERROR) throw Error('WebGL capture failed');
  }
  window.captureView = ({ view, samples, warmup }) => {
    const rotate = ([x, y, z]) => new T.Vector3(z, y, -x);
    const target = rotate(view.target);
    camera.position.copy(rotate(view.eye));
    const dir = target.clone().sub(camera.position).normalize();
    camera.up.set(0, 1, 0);
    if (Math.abs(dir.y) > 0.999999) camera.up.set(1, 0, 0); // glTF +Z after viewer rotation.
    camera.lookAt(target);
    for (let i = 0; i < warmup; i++) render();
    const ms = [];
    for (let i = 0; i < samples; i++) {
      const start = performance.now();
      render();
      ms.push(performance.now() - start);
    }
    const { calls, triangles, lines, points } = renderer.info.render;
    const work = {
      calls,
      triangles,
      lines,
      points,
      ...renderer.info.memory,
      programs: renderer.info.programs.length,
    };
    const image = renderer.domElement.toDataURL('image/png');
    const { materials, status, reason } = findMaterials(view);
    let changedPixels = null;
    if (materials) {
      const read = () => {
        const data = new Uint8Array(projection.width * projection.height * 4);
        gl.readPixels(0, 0, projection.width, projection.height, gl.RGBA, gl.UNSIGNED_BYTE, data);
        return data;
      };
      const visible = read();
      const original = [...materials].map((m) => m.visible);
      try {
        for (const m of materials) m.visible = false;
        render();
        const hidden = read();
        changedPixels = 0;
        for (let i = 0; i < hidden.length; i += 4)
          if (
            hidden[i] !== visible[i] ||
            hidden[i + 1] !== visible[i + 1] ||
            hidden[i + 2] !== visible[i + 2]
          )
            changedPixels++;
      } finally {
        [...materials].forEach((m, i) => (m.visible = original[i]));
      }
    }
    ms.sort((a, b) => a - b);
    const percentile = (p) => ms[Math.ceil(ms.length * p) - 1];
    return {
      image,
      visibility: {
        status: status ?? (changedPixels ? 'visible' : 'no-pixel-change'),
        reason: reason ?? null,
        changedPixels,
      },
      performance: { warmup, samples, p50Ms: percentile(0.5), p95Ms: percentile(0.95), work },
    };
  };
  const gpu = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null;
  return {
    three: T.REVISION,
    webgl: gl.getParameter(gl.VERSION),
    gpu,
    deviceClass: !gpu
      ? 'unknown'
      : /swiftshader|llvmpipe|software|lavapipe/i.test(gpu)
        ? 'software'
        : 'hardware-reported',
  };
};
