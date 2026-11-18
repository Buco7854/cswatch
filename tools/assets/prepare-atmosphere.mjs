/** Exact-source, static-phase approximation of the native three-mask dust effect. */
import { dirname, resolve } from 'node:path';
import { statfs, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { localDirectory, regularFile } from './toolchain-security.mjs';
import {
  readAtmosphereGlb,
  atmosphericMaterialNames,
  isSupportedAtmosphericMaterial,
} from './atmosphere-glb.mjs';
import { linearToSrgb, srgbToLinear } from './environment-space.mjs';
import { steamAssetLimits } from './steam-assets-plan.mjs';
export {
  patchAtmosphericGlb,
  atmosphericMaterialNames,
  isSupportedAtmosphericMaterial,
} from './atmosphere-glb.mjs';
const masks = ['mask1', 'mask2', 'mask3'];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
function resource(value) {
  if (
    typeof value !== 'string' ||
    value.length > 512 ||
    !/^materials\/[a-z0-9_/-]+\.vtex$/.test(value) ||
    value.split('/').some((part) => !part || part === '..')
  )
    throw new Error('Atmosphere texture must be an exact local material resource.');
  return value;
}
function vector(value, label) {
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    value.some((part) => !Number.isFinite(part) || Math.abs(part) > 16)
  )
    throw new Error(`Invalid authored atmosphere ${label}.`);
  return value.slice(0, 2);
}
function specification(material) {
  if (!isSupportedAtmosphericMaterial(material))
    throw new Error('Unsupported source atmosphere material.');
  const ints = material.IntParams ?? {},
    floats = material.FloatParams ?? {},
    vectors = material.VectorParams ?? {},
    textures = material.TextureParams ?? {};
  const features = new Set([
    'F_DEPTH_FEATHER',
    'F_DO_NOT_CAST_SHADOWS',
    'F_RENDER_BACKFACES',
    'F_DONT_FLIP_BACKFACE_NORMALS',
    'F_ADDITIVE_BLEND',
    'F_TINT_MASK',
  ]);
  if (
    Object.entries(ints).some(
      ([name, value]) =>
        name.startsWith('F_') && (![0, 1].includes(value) || (!features.has(name) && value !== 0)),
    )
  )
    throw new Error('Unsupported enabled atmosphere shader feature.');
  const tint = vectors.g_vColorTint;
  vector(tint, 'color tint');
  if (tint.slice(0, 3).some((component) => component !== 1))
    throw new Error('Atmosphere bake requires the supported white authored RGB tint.');
  if (
    (ints.F_ADDITIVE_BLEND ?? 0) !== 0 ||
    (ints.F_TINT_MASK ?? 0) !== 0 ||
    (ints.g_nTextureAddressModeU ?? 0) !== 0 ||
    (ints.g_nTextureAddressModeV ?? 0) !== 0
  )
    throw new Error('Atmosphere bake supports the authored normal blend and wrap sampler only.');
  if (
    !Number.isFinite(floats.g_flOpacityScale) ||
    floats.g_flOpacityScale < 0 ||
    floats.g_flOpacityScale > 16 ||
    !Number.isFinite(floats.g_flColorBoost) ||
    floats.g_flColorBoost < 0 ||
    floats.g_flColorBoost > 16
  )
    throw new Error('Unsupported authored atmosphere opacity or color boost.');
  // Native csgo_effects_vulkan_50_ps.vcs (CRC ab01f065) declares defaults
  // mask scale=(1,1) and pan=(0,0), confirmed in its variable DATA metadata.
  const scales = masks.map((_, index) =>
    vector(vectors[`g_vMask${index + 1}Scale`] ?? [1, 1, 0, 0], 'mask scale'),
  );
  const pan = masks.map((_, index) =>
    vector(vectors[`g_vMask${index + 1}PanSpeed`] ?? [0, 0, 0, 0], 'mask pan'),
  );
  if (scales.some((scale) => scale.some((value) => value <= 0 || value > 8)))
    throw new Error('Atmosphere mask scale is outside its supported range.');
  const period = [0, 1].map((axis) => {
    for (let p = 1; p <= 8; p++)
      if (scales.every((scale) => Math.abs(scale[axis] * p - Math.round(scale[axis] * p)) < 1e-7))
        return p;
    throw new Error('Atmosphere mask periods exceed the bounded eight-repeat bake.');
  });
  const resources = {
    color: resource(textures.g_tColor),
    ...Object.fromEntries(
      masks.map((name, index) => [name, resource(textures[`g_tMask${index + 1}`])]),
    ),
  };
  return {
    material,
    resources,
    scales,
    pan,
    period,
    opacity: floats.g_flOpacityScale,
    colorBoost: floats.g_flColorBoost,
  };
}
export async function discoverAtmosphericMaterials(path) {
  const { document } = await readAtmosphereGlb(path);
  return document.materials.flatMap((candidate, index) =>
    atmosphericMaterialNames.includes(candidate.extras?.vmat?.Name)
      ? [{ index, ...specification(candidate.extras.vmat) }]
      : [],
  );
}
async function decode(path) {
  await localDirectory(dirname(resolve(path)));
  const { handle, stat } = await regularFile(path, 32 * 1024 ** 2);
  let input;
  try {
    input = await handle.readFile();
    if (input.length !== stat.size) throw new Error('Atmosphere input changed while reading.');
  } finally {
    await handle.close();
  }
  if (!input.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    throw new Error('Atmosphere sources must be S2V decoded PNG files.');
  const { data, info } = await sharp(input, { limitInputPixels: 4096 ** 2 })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.width < 1 || info.height < 1 || info.width > 4096 || info.height > 4096)
    throw new Error('Atmosphere source exceeds its pixel bound.');
  return { data, width: info.width, height: info.height, sha256: hash(input), bytes: input.length };
}
/** Linear scalar masks use wrap and bilinear filtering; sRGB is only for color. */
function sample(image, u, v, channel, color = false) {
  const x = (u - Math.floor(u)) * image.width - 0.5,
    y = (v - Math.floor(v)) * image.height - 0.5,
    x0 = Math.floor(x),
    y0 = Math.floor(y),
    tx = x - x0,
    ty = y - y0;
  const at = (px, py) => {
    const value =
      image.data[
        ((((py % image.height) + image.height) % image.height) * image.width +
          (((px % image.width) + image.width) % image.width)) *
          4 +
          channel
      ] / 255;
    return color ? srgbToLinear(value) : value;
  };
  return (
    (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) +
    (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty
  );
}
export async function prepareAtmosphericMaterial({ material, colorPath, maskPaths, output }) {
  const spec = specification(material);
  if (
    !maskPaths ||
    Object.keys(maskPaths).length !== 3 ||
    masks.some((mask) => typeof maskPaths[mask] !== 'string')
  )
    throw new Error('Provide exactly three local decoded mask images.');
  const color = await decode(colorPath),
    decoded = [];
  for (const name of masks) decoded.push(await decode(maskPaths[name]));
  if (color.bytes + decoded.reduce((sum, image) => sum + image.bytes, 0) > 128 * 1024 ** 2)
    throw new Error('Atmosphere sources exceed their aggregate bound.');
  const width = Math.min(4096, color.width * spec.period[0]),
    height = Math.min(4096, color.height * spec.period[1]);
  const data = Buffer.alloc(width * height * 4);
  let minimum = 255,
    maximum = 0,
    total = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const u = ((x + 0.5) / width) * spec.period[0],
        v = ((y + 0.5) / height) * spec.period[1],
        offset = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel++)
        data[offset + channel] = Math.round(
          linearToSrgb(sample(color, u, v, channel, true) * spec.colorBoost) * 255,
        );
      let alpha = sample(color, u, v, 3) * spec.opacity;
      for (let index = 0; index < 3; index++)
        alpha *= sample(decoded[index], u * spec.scales[index][0], v * spec.scales[index][1], 0);
      const byte = Math.max(0, Math.min(255, Math.round(alpha * 255)));
      data[offset + 3] = byte;
      minimum = Math.min(minimum, byte);
      maximum = Math.max(maximum, byte);
      total += byte;
    }
  const png = await sharp(data, { raw: { width, height, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
  if (png.length > 32 * 1024 ** 2) throw new Error('Baked atmosphere PNG exceeds 32 MiB.');
  await localDirectory(dirname(resolve(output)));
  const disk = await statfs(dirname(resolve(output)), { bigint: true });
  if (disk.bavail * disk.bsize < BigInt(png.length + steamAssetLimits.reserveBytes))
    throw new Error('Insufficient disk space for atmosphere image and 512 MiB reserve.');
  await writeFile(output, png, { flag: 'wx', mode: 0o644 });
  return {
    imagePath: resolve(output),
    textureScale: spec.period.map((value) => 1 / value),
    report: {
      schemaVersion: 1,
      materialName: material.Name,
      shader: material.ShaderName,
      phase: 0,
      colorBoost: spec.colorBoost,
      sourceShaderCommit: '942df5b37ebbde6153f6c488880b91d4bed003e6',
      nativeShaderMetadataCrc: 'ab01f065',
      defaultedVectors: Object.fromEntries(
        masks.flatMap((_, index) => {
          const scale = `g_vMask${index + 1}Scale`,
            pan = `g_vMask${index + 1}PanSpeed`;
          return [
            ...(material.VectorParams?.[scale] === undefined ? [[scale, [1, 1]]] : []),
            ...(material.VectorParams?.[pan] === undefined ? [[pan, [0, 0]]] : []),
          ];
        }),
      ),
      period: spec.period,
      width,
      height,
      alpha: { min: minimum, max: maximum, mean: total / (width * height) },
      source: {
        color: { path: spec.resources.color, sha256: color.sha256 },
        masks: decoded.map((image, index) => ({
          path: spec.resources[masks[index]],
          sha256: image.sha256,
          scale: spec.scales[index],
          pan: spec.pan[index],
        })),
      },
      output: { sha256: hash(png), bytes: png.length },
      resolution:
        'Linear masks are bilinearly resampled into the repeated color image, capped at 4096 pixels per axis.',
      omitted: [
        'Animated mask panning. Static authored time 0 is used.',
        'View-dependent Fresnel and distance fading.',
        'Scene-depth feathering and native effects fog.',
        'Boosted linear RGB above one is clipped by the LDR texture representation.',
      ],
      color:
        'Native sRGB RGB and linear alpha retained; masks multiply linear red; color-tint fourth component is ignored.',
    },
  };
}
