// Material and lighting bindings adapted from ValveResourceFormat 21.1 (MIT). See tools/cs2export/THIRD_PARTY_NOTICES.txt.
import type { Manifest, Entity } from './format';
import type { TextureTier } from './textures';
import { Matrix4 } from 'three';
import { probeGrid, asVector } from './probe-grid';
const rad = Math.PI / 180;
export function worldEnvironments(
  manifest: Manifest,
  tier: TextureTier,
  special: Map<string, WebGLTexture>,
  table: (width: number, height: number, values: Float32Array<ArrayBuffer>) => WebGLTexture,
  materials: Float32Array,
) {
  const textures = tier === 'phone' ? manifest.phone : manifest;
  return manifest.environments.map((environment) => {
    const entries = environment.entities.filter((x) => x.cubemaptexture && x.array_index != null);
    const height = Math.max(...entries.map((probe) => Number(probe.array_index))) + 1,
      values = new Float32Array(9 * height * 4);
    for (const probe of entries) {
      const index = Number(probe.array_index),
        offset = 36 * index;
      values.set(asVector(probe.edge_fade_dists ?? [0, 0, 0]), offset + 32);
      const key = String(probe.cubemaptexture),
        coefficients = textures.specials[key]?.radiance;
      if (coefficients && coefficients.length >= (index + 1) * 27) {
        const luma = [0, 1, 2, 3].map(
          (k) =>
            0.2126 * coefficients[index * 27 + k] +
            0.7152 * coefficients[index * 27 + k + 9] +
            0.0722 * coefficients[index * 27 + k + 18],
        );
        const dc = luma[0] * 0.282095,
          linear = [-luma[3], -luma[1], luma[2]].map((x) => x * 0.325735);
        const scale = Math.min((dc * 0.99) / Math.max(1e-8, Math.hypot(...linear, dc)), 1);
        values.set(dc <= 0 ? [0, 0, 0, 0.01] : [...linear.map((x) => x * scale), dc], offset + 20);
      }
      values.set(asVector(probe.boxproject_mins ?? probe.box_mins), offset + 24);
      values.set(asVector(probe.boxproject_maxs ?? probe.box_maxs), offset + 28);
      for (const [index, value] of [
        asVector(probe.origin),
        asVector(probe.box_mins),
        asVector(probe.box_maxs),
        ['x', 'y', 'z'].map((k) => Number(probe['light_probe_atlas_' + k])),
        ['x', 'y', 'z'].map((k) => Number(probe['light_probe_size_' + k])),
      ].entries())
        values.set(value, offset + index * 4);
    }
    const get = (entity: Entity, slot: string) =>
      special.get(String(entity[slot]).replaceAll('\\', '/'))!;
    const sun = environment.entities.find(
        (x) => x.classname === 'light_environment' || x.classname === 'env_global_light',
      )!,
      angles = asVector(sun.angles).map((x) => x * rad);
    const lightDir = [
      -Math.cos(angles[0]) * Math.cos(angles[1]),
      -Math.cos(angles[0]) * Math.sin(angles[1]),
      Math.sin(angles[0]),
    ];
    const color = asVector(sun.color).map(
      (c) =>
        Math.pow(c / 255, 2.2) * Number(sun.brightness ?? 1) * Number(sun.brightnessscale ?? 1),
    );
    const spatial = probeGrid(entries);
    // Material rows, then probe rows, in columns 0-35; the cell list in the columns after them.
    const rows = manifest.materials.length,
      cellColumn = 36,
      width = cellColumn + spatial.width,
      tableHeight = Math.max(rows + height, spatial.height);
    const data = new Float32Array(width * tableHeight * 4);
    for (let row = 0; row < rows; row++)
      data.set(materials.subarray(row * 144, row * 144 + 144), row * width * 4);
    for (let row = 0; row < height; row++)
      data.set(values.subarray(row * 36, row * 36 + 36), (rows + row) * width * 4);
    for (let row = 0; row < spatial.height; row++)
      data.set(
        spatial.data.subarray(row * spatial.width * 4, (row + 1) * spatial.width * 4),
        (row * width + cellColumn) * 4,
      );
    const lpvName = String(entries[0].lightprobetexture),
      shadowName = String(entries[0].lightprobetexture_dlshd);
    const layers = (name: string) => textures.specials[name]?.levels.at(-1)?.d ?? 1;
    const phoneVolume = tier === 'phone' ? manifest.phone.volumes[lpvName] : undefined;
    if (tier === 'phone' && !phoneVolume) throw Error('Missing phone probe volume');
    const lpvLayers = phoneVolume ? phoneVolume.shadowBase : layers(lpvName);
    const range = (name: string) => (tier === 'phone' ? (manifest.phone.rgbm[name] ?? 0) : 0);
    const lightmapNames =
      tier === 'phone'
        ? [manifest.phone.lightmaps[environment.world]]
        : ['irradiance', 'directional_irradiance', 'direct_light_shadows'].map(
            (kind) => environment.world + '/lightmaps/' + kind + '.vtex',
          );
    return {
      ...environment,
      spatial,
      grid: table(spatial.width, spatial.height, spatial.data),
      probes: table(9, height, values),
      data: table(width, tableHeight, data),
      probeBase: rows,
      cellColumn,
      inverse: new Matrix4().fromArray(environment.transform).invert(),
      lightDir,
      color,
      envLastMip: textures.specials[String(entries[0].cubemaptexture)].levels.length - 2,
      env: get(entries[0], 'cubemaptexture'),
      lpv: get(entries[0], 'lightprobetexture'),
      shadow: phoneVolume
        ? get(entries[0], 'lightprobetexture')
        : get(entries[0], 'lightprobetexture_dlshd'),
      volumeLayers: phoneVolume
        ? [0, lpvLayers, lpvLayers, layers(lpvName) - lpvLayers]
        : [0, lpvLayers, 0, layers(shadowName)],
      // Irradiance, cubemap and probe volume RGBM ranges.
      rgbm: [range(lightmapNames[0]), range(String(entries[0].cubemaptexture)), range(lpvName)],
      lightmaps: lightmapNames.map((name) => special.get(name.replaceAll('\\', '/'))!),
      lightmapSamplers:
        tier === 'phone' ? ['lightAtlas'] : ['irradiance', 'directional', 'shadowMap'],
    };
  });
}
