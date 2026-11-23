import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { listTextureInfoByMaterial } from '@gltf-transform/functions';
import format from '../../shared/map-baked-lighting.json' with { type: 'json' };
import { MapBakedLightingExtension } from './map-baked-lighting-extension.mjs';
import { sampleSourceIrradiance } from './source-irradiance.mjs';
import { regularFile } from './toolchain-security.mjs';
import { mapLayerBinder, mapLayerBinding } from './prepare-map-layers.mjs';
import { nativeLightingKey } from './native-map-lighting-layout.mjs';

const shaders = new Set(['csgo_lightmappedgeneric.vfx', 'csgo_lightmapped_4wayblend.vfx']);
const vertexShaders = new Set([
  ...shaders,
  'csgo_vertexlitgeneric.vfx',
  'csgo_environment.vfx',
  'csgo_environment_blend.vfx',
]);
const sha = (data) => createHash('sha256').update(data).digest('hex');
const MiB = 1024 ** 2;

function atlasCoordinates(primitive, native) {
  const material = primitive.getMaterial();
  const vmat = material?.getExtras()?.vmat;
  const uv = primitive.getAttribute(`TEXCOORD_${native ?? format.texCoord}`);
  const position = primitive.getAttribute('POSITION');
  if (
    (!native && !shaders.has(vmat?.ShaderName)) ||
    typeof vmat?.Name !== 'string' ||
    !/^(?:materials|models)\/[a-zA-Z0-9_./-]{1,240}\.vmat$/.test(vmat.Name) ||
    (material.getAlphaMode() !== 'OPAQUE' && (!native || material.getAlphaMode() !== 'MASK')) ||
    material.getBaseColorTextureInfo()?.getTexCoord() !== 0 ||
    !primitive.getAttribute('TEXCOORD_0') ||
    !uv ||
    uv.getType() !== 'VEC2' ||
    uv.getComponentType() !== 5126 ||
    uv.getCount() !== position?.getCount()
  )
    return;
  if (
    native !== undefined &&
    native !== format.texCoord &&
    listTextureInfoByMaterial(material).some((info) => info.getTexCoord() === format.texCoord)
  )
    return;
  const indexed = primitive.getIndices()?.getArray();
  const values = uv.getArray();
  const count = indexed?.length ?? uv.getCount();
  for (let index = 0; index < count; index++) {
    const at = (indexed ? indexed[index] : index) * 2;
    if (!(values[at] >= 0 && values[at] <= 1 && values[at + 1] >= 0 && values[at + 1] <= 1)) return;
  }
  return uv;
}

function landscapeMeshes(document) {
  const meshes = new Set();
  for (const node of document.getRoot().listNodes())
    if (node.getExtras()?.cswatch?.kind === 'skybox')
      node.traverse((child) => {
        if (child.getMesh()) meshes.add(child.getMesh());
      });
  return meshes;
}

/** The pinned exporter preserves Source COLOR1 as _COLOR_1. Ordinary vertex tint is COLOR0. */
export function bindVertexLighting(document, nativeBindings) {
  if (!nativeBindings?.size) return;
  const sky = landscapeMeshes(document),
    materials = new Map();
  let primitives = 0;
  for (const mesh of document.getRoot().listMeshes()) {
    if (sky.has(mesh)) continue;
    for (const primitive of mesh.listPrimitives()) {
      const attribute = primitive.getAttribute(format.vertexAttribute);
      if (!attribute) continue;
      const original = primitive.getMaterial(),
        source = original?.getExtras();
      const position = primitive.getAttribute('POSITION');
      const binding = nativeLightingKey(
        mesh.getName(),
        source?.vmat?.Name,
        primitive.getIndices()?.getCount(),
        position?.getCount(),
      );
      if (
        !original ||
        nativeBindings.get(binding) !== 'vertex' ||
        !vertexShaders.has(source?.vmat?.ShaderName) ||
        original.getExtension(format.extension) ||
        original.getAlphaMode() === 'BLEND' ||
        attribute.getType() !== 'VEC4' ||
        attribute.getCount() !== position?.getCount()
      )
        continue;
      const type = attribute.getComponentType();
      if (type === 5126) {
        const bounded = (value) => value >= 0 && value <= 1;
        if (![...attribute.getMin([]), ...attribute.getMax([])].every(bounded)) continue;
      } else if (type !== 5121 || !attribute.getNormalized()) continue;
      let material = materials.get(original);
      if (!material) {
        material = original.clone().setExtras({
          ...source,
          cswatch: { ...source.cswatch, vertexLighting: true },
        });
        materials.set(original, material);
      }
      primitive.setMaterial(material);
      primitives++;
    }
  }
  return primitives || undefined;
}

/** Preserve source linear channels, including the fourth stationary shadow slot. */
async function sampleSourceImage(path, edge, requiredChannels) {
  const { handle, stat } = await regularFile(path, 32 * MiB);
  let data;
  try {
    data = await handle.readFile();
    if (data.length !== stat.size) throw Error('Native lighting image changed.');
  } finally {
    await handle.close();
  }
  const input = sharp(data, { limitInputPixels: 8192 ** 2 });
  const info = await input.metadata();
  if (
    info.format !== 'png' ||
    info.depth !== 'uchar' ||
    (requiredChannels > 1 && info.channels < Math.max(3, requiredChannels)) ||
    ![1024, 2048, 4096, 8192].includes(info.width) ||
    info.width !== info.height ||
    info.width < edge
  )
    throw Error('Unsupported native lighting image.');
  input.resize(edge, edge, { kernel: 'nearest' }).toColourspace('srgb');
  if (requiredChannels < 4) input.removeAlpha();
  return input.raw().toBuffer({ resolveWithObject: true });
}

export async function prepareBakedLightingAtlas({
  irradiance,
  shadow,
  direction,
  edge,
  sunChannel = 0,
}) {
  if (!Number.isInteger(sunChannel) || sunChannel < -1 || sunChannel > 3)
    throw Error('Unsupported stationary sun channel.');
  const floats = await sampleSourceIrradiance(irradiance, edge);
  const { data: mask, info: decoded } = await sampleSourceImage(
    shadow,
    edge,
    Math.max(1, sunChannel + 1),
  );
  if (sunChannel >= decoded.channels) throw Error('The authored sun channel is absent.');
  const encoded = Buffer.alloc(edge * edge * 4);
  let maximum = format.irradianceRange;
  for (const value of floats) if (value > maximum) maximum = value;
  const irradianceRange = 2 ** Math.ceil(Math.log2(maximum));
  if (irradianceRange > format.maximumIrradianceRange)
    throw Error('Source irradiance exceeds the supported HDR bounds.');
  const normalizer = Math.log2(1 + irradianceRange * format.irradianceBias);
  for (let pixel = 0; pixel < edge * edge; pixel++) {
    for (let channel = 0; channel < 3; channel++) {
      const value = floats[pixel * 3 + channel];
      encoded[pixel * 4 + channel] = Math.round(
        (255 * Math.log2(1 + value * format.irradianceBias)) / normalizer,
      );
    }
    // Zero alpha permits encoders to discard the otherwise useful hidden RGB.
    encoded[pixel * 4 + 3] =
      sunChannel < 0
        ? 1
        : 1 + Math.round(mask[pixel * decoded.channels + sunChannel] * (254 / 255));
  }
  const bytes = await sharp(encoded, { raw: { width: edge, height: edge, channels: 4 } })
    .webp({ lossless: true, effort: 4 })
    .toBuffer();
  const directions = direction ? await sampleSourceImage(direction, edge, 3) : undefined;
  const directionBytes = directions
    ? await sharp(directions.data, {
        raw: { width: edge, height: edge, channels: directions.info.channels },
      })
        .webp({ lossless: true, effort: 4 })
        .toBuffer()
    : undefined;
  return { bytes, sha256: sha(bytes), edge, directionBytes, irradianceRange };
}

/** Bind only the lightmapped shader and explicit secondary atlas channel of this S2V export. */
export function bindBakedLighting(document, atlas, layers, nativeBindings) {
  const skyMeshes = landscapeMeshes(document);
  const extension = document.createExtension(MapBakedLightingExtension);
  const texture = document
    .createTexture('cswatch-baked-irradiance')
    .setImage(atlas.bytes)
    .setMimeType('image/webp');
  const direction = atlas.directionBytes
    ? document
        .createTexture('cswatch-baked-light-direction')
        .setImage(atlas.directionBytes)
        .setMimeType('image/webp')
    : undefined;
  const setSampler = (info) =>
    info
      .setTexCoord(format.texCoord)
      .setMinFilter(9729)
      .setMagFilter(9729)
      .setWrapS(33071)
      .setWrapT(33071);
  const materials = new Map();
  const bindLayers = mapLayerBinder(document);
  let primitives = 0;
  let nativePrimitives = 0;
  let layeredPrimitives = 0;
  for (const mesh of document
    .getRoot()
    .listMeshes()
    .filter((item) => !skyMeshes.has(item)))
    for (const primitive of mesh.listPrimitives()) {
      const original = primitive.getMaterial();
      const native = nativeBindings?.get(
        nativeLightingKey(
          mesh.getName(),
          original?.getExtras().vmat?.Name,
          primitive.getIndices()?.getCount(),
          primitive.getAttribute('POSITION')?.getCount(),
        ),
      );
      if (native === 'vertex') continue;
      const uv = atlasCoordinates(primitive, native);
      if (!uv) continue;
      primitive.setAttribute(`TEXCOORD_${format.texCoord}`, uv);
      const layer = layers && mapLayerBinding(primitive, original.getExtras().vmat, layers);
      let variants = materials.get(original);
      if (!variants) materials.set(original, (variants = new Map()));
      let material = variants.get(Boolean(layer));
      if (!material) {
        const lighting = extension
          .createLighting()
          .setTexture(texture)
          .setRange(atlas.irradianceRange ?? format.irradianceRange);
        setSampler(lighting.getTextureInfo());
        if (direction) {
          lighting.setDirection(direction);
          setSampler(lighting.getDirectionInfo());
        }
        if (layer) bindLayers(lighting, layer);
        material = original.clone().setExtension(format.extension, lighting);
        variants.set(Boolean(layer), material);
      }
      primitive.setMaterial(material);
      primitives++;
      if (native) nativePrimitives++;
      if (layer) layeredPrimitives++;
    }
  if (!primitives) {
    extension.dispose();
    texture.dispose();
    direction?.dispose();
    return undefined;
  }
  return {
    primitives,
    materials: [...materials.values()].reduce((count, variants) => count + variants.size, 0),
    edge: atlas.edge,
    sha256: atlas.sha256,
    ...(atlas.irradianceRange > format.irradianceRange
      ? { irradianceRange: atlas.irradianceRange }
      : {}),
    ...(atlas.directionBytes ? { directionSha256: sha(atlas.directionBytes) } : {}),
    ...(layeredPrimitives ? { layeredPrimitives } : {}),
    ...(nativePrimitives ? { nativePrimitives } : {}),
  };
}
