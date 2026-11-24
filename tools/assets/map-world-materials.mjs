/** Compiled material meaning, applied to both the playable world and its sky landscape. */
const helpers = /^(?:tools|nodraw|sky|debug|error|(?:csgo_)?(?:depth|collision|visibility)(?:_|$))/;
const translucentSurfaces = new Set(['csgo_glass', 'csgo_water', 'water', 'csgo_static_overlay']);
const projected = new Set(['csgo_projected_decals', 'projected_decals', 'projected_decal']);
const effects = /(?:^|_)(?:effects|particle|particles|sprite|beam|fog)(?:_|$)/;

export function worldMaterialAction(material, preparedWater) {
  if (!material) return 'surface';
  const extras = material.getExtras(),
    vmat = extras.vmat;
  const name = vmat?.Name ?? '';
  const shader = vmat?.ShaderName?.replace(/\.vfx$/, '') ?? '';
  if (name === 'materials/dev/black_simple.vmat' && shader === 'csgo_black_unlit')
    return 'fog_surface';
  if (/^(?:materials\/)?(?:tools|editor|dev)\//.test(name) || helpers.test(shader))
    return 'omit_helper';
  if (effects.test(shader) || /^(?:materials\/)?(?:effects|particles)\//.test(name)) {
    if (
      shader === 'csgo_effects' &&
      extras.cswatch?.atmosphere?.static === true &&
      material.getAlphaMode() === 'BLEND'
    )
      return 'verified_atmosphere';
    return 'omit_effect';
  }
  if (projected.has(shader) && material.getAlphaMode() === 'OPAQUE') return 'omit_projector';
  if (shader === 'csgo_water_fancy')
    return preparedWater?.has(material) ? 'approximated_water' : 'omit_unsupported_refraction';
  if (translucentSurfaces.has(shader) && material.getAlphaMode() === 'OPAQUE')
    return 'omit_unresolved_transparency';
  return material.getAlphaMode() === 'MASK' ? 'cutout' : 'surface';
}

export function filterMapWorldMaterials(document, preparedWater) {
  // S2V packs the height texture's metal channel even when the compiled shader
  // disables metalness. A zero factor keeps the shared roughness and AO intact.
  for (const material of document.getRoot().listMaterials()) {
    const vmat = material.getExtras().vmat;
    const flags = vmat?.IntParams;
    if (flags?.g_bMetalness1 !== 0) continue;
    const allLayersDielectric =
      vmat.ShaderName === 'csgo_environment.vfx' ||
      (vmat.ShaderName === 'csgo_environment_blend.vfx' &&
        flags.g_bMetalness2 === 0 &&
        ((flags.F_ENABLE_LAYER_3 ?? 0) === 0 || flags.g_bMetalness3 === 0));
    if (allLayersDielectric) material.setMetallicFactor(0);
  }
  const result = new Map();
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const material = primitive.getMaterial(),
        shader = material?.getExtras().vmat?.ShaderName;
      const name =
        typeof shader === 'string' && /^[a-z0-9_]{1,100}\.vfx$/.test(shader) ? shader : 'gltf';
      const action = worldMaterialAction(material, preparedWater);
      const key = `${name}:${action}`;
      const row = result.get(key) ?? { shader: name, action, primitives: 0 };
      row.primitives++;
      result.set(key, row);
      if (action.startsWith('omit_')) primitive.dispose();
      else if (action === 'approximated_water') primitive.setAttribute('COLOR_0', null);
      else if (action === 'cutout') {
        const sampler = material?.getBaseColorTextureInfo();
        if (sampler && sampler.getMagFilter() !== 9728)
          sampler.setMinFilter(9987).setMagFilter(9729);
      }
    }
    if (!mesh.listPrimitives().length) mesh.dispose();
  }
  if ([...result.values()].length > 128)
    throw Error('Map material decision count exceeds its bound.');
  return [...result.values()].sort(
    (a, b) => a.shader.localeCompare(b.shader) || a.action.localeCompare(b.action),
  );
}
