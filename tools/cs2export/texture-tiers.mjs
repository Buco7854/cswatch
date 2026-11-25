// Texture size and phone encoding decisions derived from the exported data.
const target = Number(process.env.CS2EXPORT_TEXELS_PER_INCH ?? 1.25);
if (!(target > 0 && target <= 64)) throw Error('Invalid texel density target');
const maxPhoneCap = Number(process.env.CS2EXPORT_PHONE_CAP ?? 512);
if (![256, 512, 1024].includes(maxPhoneCap)) throw Error('Phone cap must be 256, 512 or 1024');
const MiB = 1024 ** 2;
// Phone budgets: 70 MB (66.8 MiB) download and 120 MB of GPU memory at 1280x720, of which about
// 11 MB is render targets. Compression factors are Vertigo's measured Brotli/raw ratios per
// category (0.73, 0.45, 0.46 and 0.77), rounded up. Across ten official maps the download estimate
// was 7.3 MiB high to 2.0 MiB low, so the plan keeps 2.3 MiB in reserve.
const phoneWire = 64.5 * MiB,
  phoneTextures = 100 * MiB;
const wireFactor = { array: 0.75, lightmap: 0.5, volume: 0.5, special: 0.8 };

/** Smallest retained size at which UV0 reaches the target texels per placed inch. */
export function materialCap(material, area, texels = target, maxCap = 1024) {
  const scale = material.vectors.g_vTexCoordScale ?? material.vectors.g_vTexCoordScale1 ?? [1, 1];
  const ratio =
    area && area.world > 0 ? Math.sqrt((area.uv * Math.abs(scale[0] * scale[1])) / area.world) : 0;
  const caps = [256, 512, 1024].filter((cap) => cap <= maxCap);
  if (!(ratio > 0)) return Math.min(256, maxCap);
  return caps.find((cap) => cap * ratio >= (texels ?? target)) ?? caps.at(-1);
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
function planWith(manifest, scene, sourceLevels, phoneCap, lightmapBlock, lightmapCap = 4096) {
  const items = [],
    targets = [];
  for (const bank of manifest.arrays) {
    const all = scene.textures[bank.textures[0]].levels.map((level, index) => ({ level, index }));
    const fitting = all.filter(({ level }) => Math.max(level.w, level.h) <= phoneCap);
    // A texture stored without smaller mips keeps its smallest level.
    const levels = fitting.length ? fitting : all.slice(0, 1);
    items.push({
      block: roleBlocks[bank.role] ?? [6, 6],
      levels: levels.map(({ level, index }) => ({
        w: level.w,
        h: level.h,
        slices: bank.textures.map((name) =>
          slice(
            scene.textures[name],
            scene.textures[name].levels[index],
            bank.srgb ? 'srgb' : 'linear',
          ),
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
    // The atlas takes the irradiance extent. Larger directional or shadow levels are
    // box-reduced and smaller ones (a 3D sky's 4x4 placeholder shadow) are repeated, each by a
    // whole factor while decoding.
    const levelsOf = (name) => sourceLevels.get(name);
    // Like the desktop tier, irradiance is capped at 4096.
    // A distant 3D-sky world keeps at most 1024; whole-factor halvings reach the cap.
    const limit = env.sky ? Math.min(1024, lightmapCap) : lightmapCap;
    let size = levelsOf(kinds[0]).at(-1);
    while (Math.max(size.w, size.h) > limit && size.w % 2 === 0 && size.h % 2 === 0)
      size = { w: size.w / 2, h: size.h / 2 };
    const whole = (a, b) => a.w % b.w === 0 && a.h % b.h === 0 && a.w / b.w === a.h / b.h;
    const pick = (name) => {
      const levels = levelsOf(name);
      const level =
        levels.find((l) => l.w >= size.w && l.h >= size.h && whole(l, size)) ??
        levels.findLast((l) => l.w <= size.w && l.h <= size.h && whole(size, l));
      if (!level) throw Error('Unmatched lightmap extents for ' + env.world);
      return level;
    };
    const [irradianceLevel, directionLevel, shadowLevel] = kinds.map(pick);
    const reduced = (texture, level, profile) => ({
      ...slice(texture, level, profile),
      w: level.w,
      h: level.h,
    });
    items.push({
      block: lightmapBlock,
      levels: [
        {
          w: size.w,
          h: size.h,
          slices: [
            reduced(irradiance, irradianceLevel, hdr(irradiance.format) ? 'hdr' : 'linear'),
            reduced(directional, directionLevel, 'linear'),
            reduced(scene.textures[kinds[2]], shadowLevel, 'linear'),
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
              slice(volume, a, hdr(volume.format) ? 'hdr' : 'linear'),
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
        slices: [slice(scene.textures[name], level, hdr(texture.format) ? 'hdr' : 'linear')],
      })),
    });
    targets.push({ kind: 'special', name });
  }
  return { items, targets };
}

const astcBytes = (item) =>
  item.levels.reduce(
    (sum, level) =>
      sum +
      Math.ceil(level.w / item.block[0]) *
        Math.ceil(level.h / item.block[1]) *
        16 *
        level.slices.reduce((n, slice) => n + slice.layers, 0),
    0,
  );
/** The largest phone texture cap, then the finest lightmap block, whose estimate fits the budget. */
export function phonePlan(manifest, scene, sourceLevels) {
  const base = [manifest.geometry.vb, manifest.geometry.ib, manifest.visibility?.file]
    .filter(Boolean)
    .reduce((sum, file) => sum + manifest.files[file].size, 0);
  // Lower the material cap first, then coarsen the lightmap atlas at the smallest cap.
  const caps = [512, 256, 128].filter((cap) => cap <= maxPhoneCap);
  const candidates = [
    ...caps.map((cap) => [cap, lightmapBlock]),
    [caps.at(-1), [5, 5]],
    [caps.at(-1), [6, 6]],
    [caps.at(-1), [6, 6], 2048],
  ];
  let plan;
  for (const [cap, block, lightmapCap] of candidates) {
    plan = planWith(manifest, scene, sourceLevels, cap, block, lightmapCap);
    let gpu = 0,
      wire = base;
    plan.items.forEach((item, index) => {
      const bytes = astcBytes(item),
        kind = plan.targets[index].kind;
      gpu += bytes;
      wire += bytes * (wireFactor[kind] ?? 1);
    });
    plan.estimate = {
      cap,
      lightmapBlock: block,
      ...(lightmapCap ? { lightmapCap } : {}),
      gpuMiB: +(gpu / MiB).toFixed(1),
      wireMiB: +(wire / MiB).toFixed(1),
    };
    if (gpu <= phoneTextures && wire <= phoneWire) break;
  }
  return plan;
}
