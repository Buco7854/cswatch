// Texture size and phone encoding decisions derived from the exported data.
const target = Number(process.env.CS2EXPORT_TEXELS_PER_INCH ?? 1.25);
if (!(target > 0 && target <= 64)) throw Error('Invalid texel density target');
const phoneCap = Number(process.env.CS2EXPORT_PHONE_CAP ?? 512);
if (![256, 512, 1024].includes(phoneCap)) throw Error('Phone cap must be 256, 512 or 1024');

/** Smallest retained size at which UV0 reaches the target texels per placed inch. */
export function materialCap(material, area) {
  const scale = material.vectors.g_vTexCoordScale ?? [1, 1];
  const ratio =
    area && area.world > 0 ? Math.sqrt((area.uv * Math.abs(scale[0] * scale[1])) / area.world) : 0;
  if (!(ratio > 0)) return 256;
  return [256, 512, 1024].find((cap) => cap * ratio >= target) ?? 1024;
}

// Block sizes chosen by pixel difference against the desktop tier on the Mirage lab poses.
const blocks = (name, fallback) =>
  (process.env['CS2EXPORT_PHONE_' + name] ?? fallback).split('x').map(Number);
const lightmapBlock = blocks('LIGHTMAP_BLOCK', '4x4'),
  volumeBlock = blocks('VOLUME_BLOCK', '6x6'),
  normalBlock = blocks('NORMAL_BLOCK', '6x6');
const roleBlocks = { normal: normalBlock, normal2: normalBlock };
const slice = (texture, level, profile) => ({
  file: texture.file,
  offset: level.offset,
  format: texture.format,
  profile,
  layers: level.d ?? 1,
});
const hdr = (format) => format === 'BC6H' || format === 'RGBA16161616F';

/** Phone items reuse the desktop bank layers and levels, so material bindings stay valid. */
export function phonePlan(manifest, scene, sourceLevels) {
  const items = [],
    targets = [];
  for (const bank of manifest.arrays) {
    const levels = scene.textures[bank.textures[0]].levels
      .map((level, index) => ({ level, index }))
      .filter(({ level }) => Math.max(level.w, level.h) <= phoneCap);
    items.push({
      block: roleBlocks[bank.role] ?? [6, 6],
      levels: levels.map(({ level, index }) => ({
        w: level.w,
        h: level.h,
        slices: bank.textures.map((name) =>
          slice(scene.textures[name], scene.textures[name].levels[index], bank.srgb ? 'srgb' : 'linear'),
        ),
      })),
    });
    targets.push({ kind: 'array', bank: bank.id });
  }
  const packedVolumes = new Set();
  for (const env of manifest.environments) {
    const kinds = ['irradiance', 'directional_irradiance', 'direct_light_shadows'].map(
      (kind) => env.world + '/lightmaps/' + kind + '.vtex',
    );
    const [irradiance, directional] = kinds.map((name) => scene.textures[name]);
    if (!irradiance || !directional || !scene.textures[kinds[2]])
      throw Error('Missing baked lighting for ' + env.world);
    const top = irradiance.levels.at(-1);
    const shadow = sourceLevels.get(kinds[2]).find((level) => level.w === top.w && level.h === top.h);
    const direction = directional.levels.find((level) => level.w === top.w && level.h === top.h);
    if (!shadow || !direction) throw Error('Unmatched lightmap extents for ' + env.world);
    // Lightmap charts are small; 4x4 blocks match the desktop BC grid and avoid cross-chart bleeding.
    items.push({
      block: lightmapBlock,
      levels: [
        {
          w: top.w,
          h: top.h,
          slices: [
            slice(irradiance, top, hdr(irradiance.format) ? 'rgbm' : 'linear'),
            slice(directional, direction, 'linear'),
            slice(scene.textures[kinds[2]], shadow, 'linear'),
          ],
        },
      ],
    });
    targets.push({ kind: 'lightmap', world: env.world, name: env.world + '/lightmaps/phone.vtex' });
    for (const probe of env.entities.filter((e) => e.lightprobetexture)) {
      const name = String(probe.lightprobetexture),
        shadowName = String(probe.lightprobetexture_dlshd ?? '');
      if (packedVolumes.has(name)) continue;
      packedVolumes.add(name);
      const volume = scene.textures[name],
        occlusion = scene.textures[shadowName];
      if (!volume || !occlusion) throw Error('Missing light probe volume ' + name);
      const [a, b] = [volume.levels.at(-1), occlusion.levels.at(-1)];
      if (a.w !== b.w || a.h !== b.h) throw Error('Unmatched probe atlas extents ' + name);
      items.push({
        block: volumeBlock,
        levels: [
          {
            w: a.w,
            h: a.h,
            slices: [
              slice(volume, a, hdr(volume.format) ? 'rgbm' : 'linear'),
              slice(occlusion, b, 'linear'),
            ],
          },
        ],
      });
      targets.push({ kind: 'volume', name, shadow: shadowName, shadowBase: a.d ?? 1 });
    }
  }
  for (const [name, texture] of Object.entries(manifest.specials)) {
    const category = scene.files[scene.textures[name]?.file]?.category;
    if (category !== 'cubemaps' && category !== 'sky') continue;
    items.push({
      block: [6, 6],
      levels: scene.textures[name].levels.map((level) => ({
        w: level.w,
        h: level.h,
        slices: [slice(scene.textures[name], level, hdr(texture.format) ? 'rgbm' : 'linear')],
      })),
    });
    targets.push({ kind: 'special', name });
  }
  return { items, targets };
}
