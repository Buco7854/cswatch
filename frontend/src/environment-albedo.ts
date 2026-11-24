import {
  Matrix3,
  Mesh,
  MeshStandardMaterial,
  NoColorSpace,
  SRGBColorSpace,
  Texture,
  Vector2,
  Vector3,
} from 'three';
import type { GLTF, GLTFLoader } from 'three-stdlib';

type TextureBinding = { index: number };
type Transform = { uv: number[]; channel: number };
type Layer = Transform & { values: number[]; facing: number[] };
type Overlay = Transform & {
  levels: number[];
  strength: number[];
  baseMask: number;
  maskLevels: number[];
};
type ColorCorrection = { scale: number[]; offset: number[]; mode: number; mask: number[] };
type EnvParameters = {
  baseCorrection?: ColorCorrection;
  baseOnlyOverlay: boolean;
  base: number[];
  modern: boolean;
  secondaryAttribute: boolean;
  layers: Layer[];
  overlay?: Overlay;
};
type Binding = {
  parameters: EnvParameters;
  baseHeight?: Texture;
  paintLayer2?: Texture;
  paintLayer3?: Texture;
  colorOverlay?: Texture;
};
const extensionName = 'CSWATCH_environment_albedo';
const slots = ['baseHeight', 'paintLayer2', 'paintLayer3', 'colorOverlay'] as const;
const prepared = new WeakMap<MeshStandardMaterial, Binding>();
const simpleScale = (t: Transform) =>
  t.uv[1] === 0 && t.uv[2] === 0 && t.uv[4] === 0 && t.uv[5] === 0;
const tuple = (value: unknown, size: number): value is number[] =>
  Array.isArray(value) &&
  value.length === size &&
  value.every((x) => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= 1024);
const transform = (v: Transform) => v && (v.channel === 1 || v.channel === 2) && tuple(v.uv, 6);
function valid(p: EnvParameters) {
  return (
    p &&
    typeof p.baseOnlyOverlay === 'boolean' &&
    typeof p.modern === 'boolean' &&
    typeof p.secondaryAttribute === 'boolean' &&
    (!p.baseCorrection ||
      (tuple(p.baseCorrection.scale, 2) &&
        tuple(p.baseCorrection.offset, 3) &&
        tuple(p.baseCorrection.mask, 2) &&
        [0, 1].includes(p.baseCorrection.mode))) &&
    tuple(p.base, 2) &&
    Array.isArray(p.layers) &&
    p.layers.length <= 2 &&
    p.layers.every(
      (l) =>
        transform(l) &&
        (l.channel === 1 || p.secondaryAttribute) &&
        tuple(l.values, 9) &&
        tuple(l.facing, 3),
    ) &&
    (!p.overlay ||
      (transform(p.overlay) &&
        (p.overlay.channel === 1 || p.secondaryAttribute) &&
        tuple(p.overlay.maskLevels, 2) &&
        tuple(p.overlay.levels, 2) &&
        tuple(p.overlay.strength, 3) &&
        Number.isFinite(p.overlay.baseMask) &&
        Math.abs(p.overlay.baseMask) <= 1)) &&
    (!p.baseCorrection || p.layers.length || p.overlay?.baseMask) &&
    (p.overlay || p.layers.length)
  );
}

/** GLTFLoader owns the bitmap source. The material owns the cloned sampler through model resource inspection. */
export function registerEnvironmentAlbedo(loader: GLTFLoader) {
  loader.register((parser) => ({
    name: extensionName,
    async afterRoot(gltf: GLTF) {
      const candidates = new Map<
        MeshStandardMaterial,
        { p: EnvParameters; data: Record<string, TextureBinding> }
      >();
      const invalid = new Set<MeshStandardMaterial>();
      for (const scene of gltf.scenes)
        scene.traverse((node) => {
          if (!(node instanceof Mesh)) return;
          for (const m of Array.isArray(node.material) ? node.material : [node.material]) {
            if (!(m instanceof MeshStandardMaterial) || !m.map) continue;
            const id = parser.associations.get(m)?.materials;
            if (id === undefined) continue;
            const d = parser.json.materials?.[id]?.extensions?.[extensionName],
              p = d?.parameters;
            if (!d || d.schemaVersion !== 1 || !valid(p)) continue;
            const position = node.geometry.getAttribute('position'),
              paint = node.geometry.getAttribute('_texcoord_4'),
              secondary = node.geometry.getAttribute('_cswatch_uv_second');
            if (
              !position ||
              !node.geometry.getAttribute('uv') ||
              ((p.layers.length || p.baseOnlyOverlay) &&
                (paint?.itemSize !== 4 || paint.count !== position.count)) ||
              (p.secondaryAttribute &&
                (secondary?.itemSize !== 2 || secondary.count !== position.count))
            )
              invalid.add(m);
            else candidates.set(m, { p, data: d });
          }
        });
      const images = new Map<number, Promise<Texture | undefined>>();
      const samplers = new Map<string, Texture>();
      function getImage(id: number) {
        const pending = images.get(id);
        if (pending) return pending;
        if (images.size >= 96) return;
        const read: Promise<Texture | undefined> = parser
          .getDependency('texture', id)
          .then((source: unknown) => {
            if (
              source instanceof Texture &&
              [source.image?.width, source.image?.height].every(
                (n) => Number.isInteger(n) && n > 0 && n <= 2048,
              )
            )
              return source;
          })
          .catch(() => undefined);
        images.set(id, read);
        return read;
      }
      await Promise.all(
        [...candidates].map(async ([material, { p, data }]) => {
          if (invalid.has(material)) return;
          const required = slots.filter((s) => {
            switch (s) {
              case 'baseHeight':
                return p.layers.length || p.overlay?.baseMask;
              case 'paintLayer2':
                return p.layers.length > 0;
              case 'paintLayer3':
                return p.layers.length > 1;
              case 'colorOverlay':
                return p.overlay;
            }
          });
          const ids = required.map((s) => data[s]?.index);
          if (
            ids.some(
              (id) => !Number.isInteger(id) || id < 0 || id >= (parser.json.textures?.length ?? 0),
            )
          )
            return;
          const sources = await Promise.all(ids.map(getImage));
          if (sources.some((s) => !s)) return;
          const textures: Binding = { parameters: p };
          for (const [i, slot] of required.entries()) {
            const srgb = slot !== 'baseHeight',
              key = ids[i] + '/' + srgb;
            let texture = samplers.get(key);
            if (!texture) {
              texture = sources[i]!.clone();
              texture.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
              samplers.set(key, texture);
            }
            textures[slot] = texture;
          }
          prepared.set(material, textures);
          for (const slot of slots)
            if (textures[slot]) Object.assign(material, { ['cswatchEnv_' + slot]: textures[slot] });
        }),
      );
    },
  }));
}

// Height blending follows the pinned ValveResourceFormat surface_height_blend.slang
// implementation (942df5b37ebbde6153f6c488880b91d4bed003e6, see public/licenses/valve-resource-format.txt).
// The native layer range is signed around the painted midpoint. The carried height
// keeps a third layer in the same band as the first two.
const blendFunctions = /* glsl */ `
float saturateLayer(float value) {
  return clamp(value, 0.0, 1.0);
}

float paintedHeightWeight(float paint, float height, vec4 shape, float softness,
                          float heightMask, inout vec3 carry) {
  if (paint <= 0.0) {
    carry.xy = vec2(0.0);
    return 0.0;
  }
  float signedPaint = paint * 2.0 - 1.0;
  float upper = (height - shape.y) * shape.x + signedPaint + max(carry.x, 0.0);
  float difference = upper - mix(carry.y, carry.z, shape.w);
  float margin = softness * 0.25;
  float edge = 0.02 + margin;
  float weight = saturateLayer(0.5 + difference / (2.0 * softness));
  float highEdge = saturateLayer((saturateLayer(paint + difference * 0.1 + 0.2) - (0.98 - margin)) / edge);
  float lowEdge = saturateLayer((edge - saturateLayer(paint + difference * 0.05 - 0.05)) / edge);
  weight = mix(mix(weight, 1.0, highEdge), 0.0, lowEdge);
  weight = saturateLayer(weight * mix(1.0, height * 2.0, heightMask));

  carry.x = signedPaint;
  carry.y = weight > 0.05 ? signedPaint * weight : 0.0;
  if (weight > 0.05) carry.z = mix(carry.z, max(carry.z, upper), weight);
  return weight;
}

// Older materials use the intersection of overlapping height bands.
float overlappingHeightWeight(float paint, float height, vec4 shape, float softness,
                              float heightMask, vec2 base, float baseHeight, int layer, inout vec3 carry) {
  float lowerScale = layer == 0 ? base.x + softness : carry.x;
  float firstHeight = (baseHeight - base.y) * lowerScale;
  float lowerHeight = layer == 0 ? firstHeight : carry.y;
  float upperScale = shape.x + softness;
  float minOffset = -base.y * lowerScale - (1.0 - shape.y) * upperScale - softness;
  float maxOffset = (1.0 - base.y) * lowerScale + shape.y * upperScale;
  float upperRelative = (height - shape.y) * (shape.x - softness);
  float upperHeight = upperRelative + mix(minOffset, maxOffset, paint);
  float pivot = max(lowerHeight, upperHeight);
  float lowerBand = max(0.0, firstHeight - pivot + softness);
  if (layer == 1) lowerBand += max(0.0, carry.z - pivot + softness);
  float upperBand = max(0.0, upperHeight - pivot + softness);
  float weight = upperBand / (lowerBand + upperBand + 0.0001);
  weight = saturateLayer(weight * mix(1.0, height * 2.0, heightMask));

  if (layer == 0) {
    carry.x = lowerScale;
    carry.y = weight > 0.05 ? mix(firstHeight, upperRelative, weight) : firstHeight;
    carry.z = upperHeight;
  }
  return weight > 0.05 ? weight : 0.0;
}
`;

function matrix(uv: number[]) {
  return new Matrix3().set(uv[0], uv[1], uv[4], uv[2], uv[3], uv[5], 0, 0, 1);
}
type Shader = Parameters<MeshStandardMaterial['onBeforeCompile']>[0];

function apply(shader: Shader, binding: Binding) {
  const p = binding.parameters,
    hasPaint = p.layers.length > 0,
    hasFacing = p.layers.some((l) => l.facing.some((x) => x !== 0));
  const uniforms = shader.uniforms;
  let declarations = '',
    body = '';
  const add = (type: string, name: string, value: unknown) => {
    declarations += 'uniform ' + type + ' ' + name + ';\n';
    uniforms[name] = { value };
  };
  const uvFor = (t: Transform, name: string) => {
    const coords = t.channel === 1 ? 'vMapUv' : 'envSecondUV';
    if (simpleScale(t)) {
      add('vec2', name, new Vector2(t.uv[0], t.uv[3]));
      return `(${coords} * ${name})`;
    }
    add('mat3', name, matrix(t.uv));
    return `(${name} * vec3(${coords}, 1.0)).xy`;
  };
  let vertexDecl = '',
    varyings = '',
    vertexBody = '';
  if (hasPaint || p.baseOnlyOverlay) {
    vertexDecl += 'attribute vec4 _texcoord_4;\n';
    varyings += 'varying vec4 envPaint;\n';
    vertexBody += 'envPaint=_texcoord_4;\n';
  }
  if (p.secondaryAttribute) {
    vertexDecl += 'attribute vec2 _cswatch_uv_second;\n';
    varyings += 'varying vec2 envSecondUV;\n';
    vertexBody += 'envSecondUV=_cswatch_uv_second;\n';
  }
  if (hasFacing) {
    varyings += 'varying vec3 envNormal;\n';
    vertexBody += 'envNormal=inverseTransformDirection(transformedNormal,viewMatrix);\n';
  }
  if (binding.baseHeight) {
    add('sampler2D', 'envHeight', binding.baseHeight);
    body += 'vec2 envBaseSample=texture2D(envHeight,vMapUv).rg;\n';
  }
  if (p.baseCorrection) {
    const c = p.baseCorrection;
    add('vec2', 'mapColorScale', new Vector2(...c.scale));
    add('vec3', 'mapColorOffset', new Vector3(...c.offset));
    add('vec2', 'mapColorMask', new Vector2(...c.mask));
    // The exporter can multiply the particular instance's tint into diffuse.
    // Apply the optical transform in linear texture space first.
    body += `
      const vec3 luminanceAxis = normalize(vec3(0.2125, 0.7154, 0.0721));
      float greyLevel = dot(sampledDiffuseColor.rgb, luminanceAxis * luminanceAxis);
      vec3 adjustedBase = mapColorScale.x * sampledDiffuseColor.rgb + mapColorScale.y * greyLevel + mapColorOffset;
      float adjustedShare = ${c.mode === 1 ? '1.0' : 'clamp(((envBaseSample.g - 0.5) * mapColorMask.x + 0.5) * mapColorMask.y, 0.0, 1.0)'};
      diffuseColor.rgb = mix(diffuseColor.rgb, diffuse * adjustedBase, adjustedShare);
    `;
  }
  if (hasPaint) {
    add('vec2', 'envBaseParams', new Vector2(...p.base));
    body += `
      vec3 envCarry = vec3(0.0, 0.0, (envBaseSample.r - envBaseParams.y) * envBaseParams.x);
      vec3 envWeights = vec3(1.0, 0.0, 0.0);
    `;
    for (const [i, l] of p.layers.entries()) {
      const n = String(i),
        u = uvFor(l, 'envTransform' + n);
      const shared = i === 1 && binding.paintLayer3 === binding.paintLayer2;
      const sampler = shared ? 'envLayer0' : 'envLayer' + n;
      if (!shared) add('sampler2D', sampler, i === 0 ? binding.paintLayer2 : binding.paintLayer3);
      add('vec4', 'envShape' + n, l.values.slice(0, 4));
      add('vec3', 'envBlend' + n, l.values.slice(4, 7));
      const facing = l.facing.some((x) => x !== 0);
      const sample = 'envSample' + n,
        share = 'envShare' + n,
        weight = 'envWeight' + n;
      const paintChannel = i === 0 ? 'x' : 'y';
      body += `
        vec4 ${sample} = texture2D(${sampler}, ${u});
        float ${share} = saturateLayer(envPaint.${paintChannel} * 1.1 - 0.05);
      `;
      if (facing) {
        const dir = new Vector3(l.facing[0], l.facing[1], l.facing[2]).normalize();
        add('vec3', 'envFace' + n, dir);
        add('vec2', 'envSpread' + n, new Vector2(l.values[7], l.values[8]));
        body += `
          float facing${n} = dot(normalize(envNormal), envFace${n});
          float spread${n} = envSpread${n}.x;
          float softness${n} = max(0.0001, 2.0 * envSpread${n}.y);
          ${share} *= saturateLayer((facing${n} - 1.0 + 2.0 * spread${n}) / softness${n} + 0.5);
        `;
      }
      const mask = l.values[4] === 0 ? '0.0' : `envBlend${n}.x`;
      const argumentsList = `${share}, height${n}, envShape${n}, band${n}, ${mask}`;
      const calculation = p.modern
        ? `paintedHeightWeight(${argumentsList}, envCarry)`
        : `overlappingHeightWeight(${argumentsList}, envBaseParams, envBaseSample.r, ${i}, envCarry)`;
      body += `
        float height${n} = clamp((${sample}.a * 255.0 - 1.0) / 254.0, 0.0, 1.0);
        float band${n} = clamp(envPaint.w + envShape${n}.z, 0.0001, 1.0);
        float ${weight} = ${calculation};
      `;
      if (p.overlay)
        body += `
        envWeights *= 1.0 - ${weight};
        envWeights[${i + 1}] = ${weight};
      `;
      // A zero authored overlay skips the linear-to-display transfer entirely.
      if (l.values[5] !== 0)
        body += `
        vec3 overlayColor${n} = 2.0 * sRGBTransferOETF(vec4(clamp(${sample}.rgb, 0.0, 1.0), 1.0)).rgb;
        diffuseColor.rgb *= mix(vec3(1.0), overlayColor${n}, ${weight} * envBlend${n}.y);
      `;
      if (l.values[6] !== 0) {
        const replace = l.values[6] === 1 ? weight : `(${weight} * envBlend${n}.z)`;
        body += `diffuseColor.rgb = mix(diffuseColor.rgb, diffuse * ${sample}.rgb, ${replace});
`;
      }
    }
  }
  if (p.overlay) {
    const o = p.overlay,
      u = uvFor(o, 'envOverlayUV');
    add('sampler2D', 'envOverlay', binding.colorOverlay);
    add('vec2', 'envContrast', new Vector2(...o.levels));
    add('vec2', 'envTintContrast', new Vector2(...o.maskLevels));
    add('vec3', 'envOverlayStrength', new Vector3(...o.strength));
    add('float', 'envOverlayMask', o.baseMask);
    const shares = hasPaint
      ? 'envWeights'
      : p.baseOnlyOverlay
        ? 'vec3(step(max(envPaint.x,envPaint.y),0.04545),0.0,0.0)'
        : 'vec3(1.0,0.0,0.0)';
    body += `
      vec3 signedOverlay = texture2D(envOverlay, ${u}).rgb * 2.0 - 1.0;
      vec3 lighter = 1.0 - pow(1.0 - max(vec3(0.0), signedOverlay), vec3(envContrast.x));
      vec3 darker = pow(1.0 + min(vec3(0.0), signedOverlay), vec3(envContrast.y)) - 1.0;
      vec3 modulation = max(vec3(0.0), 1.0 + envContrast.x * lighter + envContrast.y * darker);
      float tintMask = ${binding.baseHeight ? 'clamp(((envBaseSample.g - 0.5) * envTintContrast.x + 0.5) * envTintContrast.y, 0.0, 1.0)' : '1.0'};
      float baseMask = mix(1.0, envOverlayMask > 0.0 ? tintMask : 1.0 - tintMask, abs(envOverlayMask));
      float amount = dot(${shares}, envOverlayStrength * vec3(baseMask, 1.0, 1.0));
      diffuseColor.rgb *= mix(vec3(1.0), modulation, clamp(amount, 0.0, 1.0));
    `;
  }
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\n' + vertexDecl + varyings)
    .replace('#include <normal_vertex>', '#include <normal_vertex>\n' + vertexBody);
  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <common>',
      '#include <common>\n' + varyings + declarations + (hasPaint ? blendFunctions : ''),
    )
    .replace('#include <map_fragment>', '#include <map_fragment>\n' + body);
}

/** Compose after the base lightmap, water and glass hooks have been installed. */
export function applyEnvironmentAlbedo(gltf: GLTF) {
  for (const scene of gltf.scenes)
    scene.traverse((node) => {
      if (!(node instanceof Mesh)) return;
      for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
        const binding = prepared.get(material);
        if (!binding) continue;
        prepared.delete(material);
        const previous = material.onBeforeCompile,
          priorKey = material.customProgramCacheKey(),
          p = binding.parameters;
        // Reserve environment lighting, BRDF, baked direction and both shadow maps.
        // Distinct glTF samplers can share image bytes in the map resource cache.
        const stockSlots = Object.entries(material).filter(
          ([name, texture]) =>
            name !== 'cswatchLightingDirection' &&
            !name.startsWith('cswatchEnv_') &&
            texture instanceof Texture,
        ).length;
        const layerSlots = new Set(slots.map((slot) => binding[slot]).filter(Boolean)).size;
        const activeSamplerBudget = stockSlots + 5 + layerSlots;
        const shape = [
          activeSamplerBudget,
          p.modern,
          p.baseCorrection?.mode,
          p.baseOnlyOverlay,
          p.secondaryAttribute,
          ...p.layers.map((l) => [
            l.channel,
            simpleScale(l),
            l.facing.some((x) => x !== 0),
            l.values[4] === 0,
            l.values[5] === 0,
            l.values[6] === 0,
            l.values[6] === 1,
          ]),
          binding.paintLayer2 === binding.paintLayer3,
          p.overlay && simpleScale(p.overlay),
          p.overlay?.channel,
          Boolean(binding.baseHeight),
        ];
        material.onBeforeCompile = function (
          shader: Shader,
          renderer: Parameters<MeshStandardMaterial['onBeforeCompile']>[1],
        ) {
          previous.call(this, shader, renderer);
          if (activeSamplerBudget <= renderer.capabilities.maxTextures) apply(shader, binding);
        };
        material.customProgramCacheKey = () =>
          priorKey + ':environment-albedo:' + JSON.stringify(shape);
      }
    });
}
