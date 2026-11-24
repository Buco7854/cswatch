import {
  Box3,
  DepthTexture,
  Frustum,
  FrontSide,
  LessEqualCompare,
  LinearFilter,
  Matrix4,
  Mesh,
  MeshDepthMaterial,
  MeshStandardMaterial,
  NearestFilter,
  OrthographicCamera,
  RedFormat,
  Scene,
  Sphere,
  ShaderChunk,
  Vector3,
  WebGLRenderTarget,
  type Camera,
  type Material,
  type Object3D,
  type Texture,
  type WebGLRenderer,
} from 'three';
import type { MapSun } from './map-sun';

const size = 1536;
// A normal-mapped surface can face away from the sun even when the source
// geometry faces it. Standard direct lighting multiplies both BRDF lobes by
// max(dot(N,L), 0). Clearcoat uses an independent normal and still needs the light.
const directional =
  /(getDirectionalLightInfo\( directionalLight, directLight \);)([\s\S]*?RE_Direct\([^;]+;)/;
const attenuation = `
  #ifndef USE_CLEARCOAT
    if (dot(geometryNormal, directionalLight.direction) > 0.0)
  #endif
  {
    $1
    directLight.color *= playerSunVisibility();
    $2
  }
`;

/** A separate depth target contains only posed players and their equipment. */
export function playerShadows() {
  const camera = new OrthographicCamera();
  const scene = new Scene();
  const viewFrustum = new Frustum();
  const viewMatrix = new Matrix4();
  const casterSphere = new Sphere(new Vector3(), 9);
  const lightBounds = new Box3();
  const center = new Vector3();
  // WebGL validates shadow samplers before drawing, even when their branch
  // is disabled. A depth texture must be bound before the first caster appears.
  const emptyDepth = new DepthTexture(1, 1);
  emptyDepth.compareFunction = LessEqualCompare;
  emptyDepth.needsUpdate = true;
  const depth = {
    cswatchPlayerDepth: { value: emptyDepth as Texture | null },
    cswatchPlayerProjection: { value: new Matrix4() },
    cswatchPlayerBias: { value: 0 },
    cswatchPlayerShadows: { value: false },
  };
  const proxies = new Map<Mesh, Mesh>();
  const materials = new Map<Material, MeshDepthMaterial>();
  let target: WebGLRenderTarget | undefined;
  let projection: MapSun | undefined;
  function shadowMaterial(material: Material) {
    let result = materials.get(material);
    if (result) return result;
    const surface = material as Material & { map?: Texture; alphaMap?: Texture };
    result = new MeshDepthMaterial({
      map: material.alphaTest ? (surface.map ?? null) : null,
      alphaMap: material.alphaTest ? (surface.alphaMap ?? null) : null,
      alphaTest: material.alphaTest,
      side: material.shadowSide ?? FrontSide,
      visible: material.visible && !material.transparent,
      colorWrite: false,
    });
    materials.set(material, result);
    return result;
  }
  return {
    render(renderer: WebGLRenderer, root: Object3D, sun: MapSun, view?: Camera) {
      if (projection !== sun) {
        projection = sun;
        Object.assign(camera, sun.shadow);
        camera.position.fromArray(sun.position);
        camera.up.fromArray(sun.up);
        camera.lookAt(...sun.target);
        camera.updateMatrixWorld();
        // In normalized depth, bias by two centimeters along the sun ray.
        depth.cswatchPlayerBias.value = 0.02 / (camera.far - camera.near);
      }
      root.updateWorldMatrix(true, true);
      const active = new Set<Mesh>();
      const sources = new Set<Material>();
      if (view) {
        view.updateWorldMatrix(true, false);
        viewFrustum.setFromProjectionMatrix(
          viewMatrix.multiplyMatrices(view.projectionMatrix, view.matrixWorldInverse),
          view.coordinateSystem,
          view.reversedDepth,
        );
      }
      lightBounds.makeEmpty();
      for (const actor of root.children) {
        if (!actor.visible) continue;
        casterSphere.center.setFromMatrixPosition(actor.matrixWorld);
        // Retain nearby offscreen casters whose projected shadow can enter the view.
        if (view && !viewFrustum.intersectsSphere(casterSphere)) continue;
        center.copy(casterSphere.center).applyMatrix4(camera.matrixWorldInverse);
        lightBounds.expandByPoint(center);
        actor.traverseVisible((object) => {
          if (!(object instanceof Mesh) || !object.userData.playerShadowCaster) return;
          active.add(object);
          let proxy = proxies.get(object);
          if (!proxy) {
            proxy = object.clone(false);
            proxy.matrixAutoUpdate = false;
            scene.add(proxy);
            proxies.set(object, proxy);
          }
          const material = object.material;
          for (const item of Array.isArray(material) ? material : [material]) sources.add(item);
          proxy.material = Array.isArray(material)
            ? material.map(shadowMaterial)
            : shadowMaterial(material);
          proxy.matrix.copy(object.matrixWorld);
          proxy.matrixWorldNeedsUpdate = true;
        });
      }
      for (const [object, proxy] of proxies) {
        if (active.has(object)) continue;
        proxy.removeFromParent();
        proxies.delete(object);
      }
      for (const [material, shadow] of materials) {
        if (sources.has(material)) continue;
        shadow.dispose();
        materials.delete(material);
      }
      if (!active.size || renderer.getContext().isContextLost()) {
        depth.cswatchPlayerShadows.value = false;
        return;
      }
      // Fit only the player casters. The sun's full-map depth range still
      // permits receivers anywhere below them, including stairs and ledges.
      // A two-metre grid keeps the projection stable within ordinary motion.
      const low = (value: number) => Math.floor((value - 3) / 2) * 2;
      const high = (value: number) => Math.ceil((value + 3) / 2) * 2;
      camera.left = low(lightBounds.min.x);
      camera.right = high(lightBounds.max.x);
      camera.bottom = low(lightBounds.min.y);
      camera.top = high(lightBounds.max.y);
      camera.updateProjectionMatrix();
      depth.cswatchPlayerProjection.value.multiplyMatrices(
        camera.projectionMatrix,
        camera.matrixWorldInverse,
      );
      if (!target) {
        const texture = new DepthTexture(size, size);
        texture.compareFunction = LessEqualCompare;
        texture.minFilter = texture.magFilter = LinearFilter;
        target = new WebGLRenderTarget(size, size, {
          depthTexture: texture,
          format: RedFormat,
          minFilter: NearestFilter,
          magFilter: NearestFilter,
        });
        target.texture.name = 'cswatch-player-shadow';
      }
      depth.cswatchPlayerDepth.value = target.depthTexture;
      depth.cswatchPlayerShadows.value = true;
      const previous = renderer.getRenderTarget();
      const autoClear = renderer.autoClear;
      try {
        renderer.autoClear = false;
        renderer.setRenderTarget(target);
        renderer.clear(false, true, false);
        renderer.render(scene, camera);
      } finally {
        renderer.setRenderTarget(previous);
        renderer.autoClear = autoClear;
      }
    },
    disable() {
      depth.cswatchPlayerShadows.value = false;
    },
    dispose() {
      depth.cswatchPlayerShadows.value = false;
      depth.cswatchPlayerDepth.value = null;
      emptyDepth.dispose();
      target?.dispose();
      target = undefined;
      scene.clear();
      proxies.clear();
      for (const material of materials.values()) material.dispose();
      materials.clear();
    },
    /** Preserve the Source material hooks and make both prepared map paths receive sun occlusion. */
    receivers(root: Object3D) {
      const clones = new Map<Material, Material>();
      const originals = new Map<Mesh, Mesh['material']>();
      function receiver(material: Material) {
        if (!(material instanceof MeshStandardMaterial)) return material;
        let result = clones.get(material);
        if (result) return result;
        result = material.clone();
        result.onBeforeCompile = (shader, renderer) => {
          // Source material closures own baked/fog uniforms and authored texture metadata.
          material.onBeforeCompile(shader, renderer);
          Object.assign(shader.uniforms, depth);
          shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\nvarying vec3 vPlayerWorld;')
            .replace(
              '#include <project_vertex>',
              `#include <project_vertex>
              vec4 playerWorld = vec4(transformed, 1.0);
              #ifdef USE_BATCHING
                playerWorld = batchingMatrix * playerWorld;
              #endif
              #ifdef USE_INSTANCING
                playerWorld = instanceMatrix * playerWorld;
              #endif
              vPlayerWorld = (modelMatrix * playerWorld).xyz;`,
            );
          shader.fragmentShader = shader.fragmentShader
            .replace(
              '#include <common>',
              `#include <common>
              varying vec3 vPlayerWorld;
              uniform bool cswatchPlayerShadows;
              uniform highp sampler2DShadow cswatchPlayerDepth;
              uniform mat4 cswatchPlayerProjection;
              uniform float cswatchPlayerBias;

              float playerSunVisibility() {
                if (!cswatchPlayerShadows) return 1.0;
                vec4 clip = cswatchPlayerProjection * vec4(vPlayerWorld, 1.0);
                vec3 uv = clip.xyz * 0.5 + 0.5;
                if (any(lessThanEqual(uv, vec3(0.0))) || any(greaterThanEqual(uv, vec3(1.0))))
                  return 1.0;
                return texture(cswatchPlayerDepth, vec3(uv.xy, uv.z - cswatchPlayerBias));
              }`,
            )
            .replace('#include <lights_fragment_begin>', ShaderChunk.lights_fragment_begin)
            .replace(directional, attenuation);
        };
        result.customProgramCacheKey = () =>
          material.customProgramCacheKey() + ':player-sun-depth-compare';
        clones.set(material, result);
        return result;
      }
      root.traverse((object) => {
        if (!(object instanceof Mesh)) return;
        originals.set(object, object.material);
        object.material = Array.isArray(object.material)
          ? object.material.map(receiver)
          : receiver(object.material);
      });
      return () => {
        for (const [mesh, original] of originals) mesh.material = original;
        for (const material of clones.values()) material.dispose();
      };
    },
  };
}
