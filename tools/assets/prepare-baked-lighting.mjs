import { createHash } from 'node:crypto';
import sharp from 'sharp';
import format from '../../shared/map-baked-lighting.json' with { type: 'json' };
import { MapBakedLightingExtension } from './map-baked-lighting-extension.mjs';
import { sampleSourceIrradiance } from './source-irradiance.mjs';
import { regularFile } from './toolchain-security.mjs';
import { mapLayerBinder, mapLayerBinding } from './prepare-map-layers.mjs';

const shader = 'csgo_lightmappedgeneric.vfx';
const sha = (data) => createHash('sha256').update(data).digest('hex');
const MiB = 1024 ** 2;

function supported(primitive) {
  const material = primitive.getMaterial();
  const vmat = material?.getExtras()?.vmat;
  const uv = primitive.getAttribute('TEXCOORD_1');
  const position = primitive.getAttribute('POSITION');
  if (
    vmat?.ShaderName !== shader ||
    typeof vmat.Name !== 'string' ||
    !/^materials\/[a-zA-Z0-9_./-]{1,240}\.vmat$/.test(vmat.Name) ||
    material.getAlphaMode() !== 'OPAQUE' ||
    material.getBaseColorTextureInfo()?.getTexCoord() !== 0 ||
    !primitive.getAttribute('TEXCOORD_0') ||
    !uv ||
    uv.getType() !== 'VEC2' ||
    uv.getComponentType() !== 5126 ||
    uv.getCount() !== position?.getCount()
  )
    return false;
  const min = uv.getMin([]),
    max = uv.getMax([]);
  return (
    min.every((value) => value >= 0 && value <= 1) && max.every((value) => value >= 0 && value <= 1)
  );
}

/** Mirrors the map-authored diffuse and sun attenuation in one linear-data atlas.
 * The RGB channels store fixed log-encoded HDR irradiance; alpha stores shadow channel 0. */
async function sampleSourceImage(path, edge) {
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
    ![1024, 2048, 4096, 8192].includes(info.width) ||
    info.width !== info.height ||
    info.width < edge
  )
    throw Error('Unsupported native lighting image.');
  return input
    .resize(edge, edge, { kernel: 'nearest' })
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });
}

export async function prepareBakedLightingAtlas({ irradiance, shadow, direction, edge }) {
  const floats = await sampleSourceIrradiance(irradiance, edge);
  const { data: mask, info: decoded } = await sampleSourceImage(shadow, edge);
  const encoded = Buffer.alloc(edge * edge * 4);
  const normalizer = Math.log2(1 + format.irradianceRange * format.irradianceBias);
  for (let pixel = 0; pixel < edge * edge; pixel++) {
    for (let channel = 0; channel < 3; channel++) {
      const value = floats[pixel * 3 + channel];
      if (value > format.irradianceRange) throw Error('Source irradiance exceeds encoding range.');
      encoded[pixel * 4 + channel] = Math.round(
        (255 * Math.log2(1 + value * format.irradianceBias)) / normalizer,
      );
    }
    // Zero alpha permits encoders to discard the otherwise useful hidden RGB.
    encoded[pixel * 4 + 3] = 1 + Math.round(mask[pixel * decoded.channels] * (254 / 255));
  }
  const bytes = await sharp(encoded, { raw: { width: edge, height: edge, channels: 4 } })
    .webp({ lossless: true, effort: 4 })
    .toBuffer();
  const directions = direction ? await sampleSourceImage(direction, edge) : undefined;
  const directionBytes = directions
    ? await sharp(directions.data, {
        raw: { width: edge, height: edge, channels: directions.info.channels },
      })
        .webp({ lossless: true, effort: 4 })
        .toBuffer()
    : undefined;
  return { bytes, sha256: sha(bytes), edge, directionBytes };
}

/** Bind only the lightmapped shader and explicit secondary atlas channel of this S2V export. */
export function bindBakedLighting(document, atlas, layers) {
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
  let layeredPrimitives = 0;
  for (const mesh of document.getRoot().listMeshes())
    for (const primitive of mesh.listPrimitives()) {
      if (!supported(primitive)) continue;
      const original = primitive.getMaterial();
      const layer = layers && mapLayerBinding(primitive, original.getExtras().vmat, layers);
      let variants = materials.get(original);
      if (!variants) materials.set(original, (variants = new Map()));
      let material = variants.get(Boolean(layer));
      if (!material) {
        const lighting = extension.createLighting().setTexture(texture);
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
      if (layer) layeredPrimitives++;
    }
  if (!primitives) throw Error('No supported native lightmap bindings in this export.');
  return {
    primitives,
    materials: [...materials.values()].reduce((count, variants) => count + variants.size, 0),
    edge: atlas.edge,
    sha256: atlas.sha256,
    ...(atlas.directionBytes ? { directionSha256: sha(atlas.directionBytes) } : {}),
    ...(layeredPrimitives ? { layeredPrimitives } : {}),
  };
}
