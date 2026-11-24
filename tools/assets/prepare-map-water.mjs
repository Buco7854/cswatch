import { PropertyType } from '@gltf-transform/core';
import { KHRMaterialsIOR } from '@gltf-transform/extensions';
import { staticWaterInputs } from './map-water-inputs.mjs';

// Map authored fog strength to bounded, static alpha. The water column at the
// current pixel, waves, caustics, interactions and refraction are unresolved.
export function bindPreparedWater(document, bindings) {
  const prepared = new Set();
  if (!bindings.size) return prepared;
  for (const material of document.getRoot().listMaterials()) {
    const extras = material.getExtras(),
      vmat = extras.vmat,
      row = bindings.get(vmat?.Name);
    if (
      !row ||
      !material.listParents().some((parent) => parent.propertyType === PropertyType.PRIMITIVE)
    )
      continue;
    const exported = staticWaterInputs(vmat);
    if (
      !exported ||
      !['density', 'reflectance', 'exponent', 'roughness'].every(
        (k) => Math.abs(exported[k] - row[k]) < 0.00001,
      ) ||
      row.fog.some((n, i) => Math.abs(exported.fog[i] - n) >= 0.00001)
    )
      continue;
    // Replace the exporter's fallback PBR surface as a unit. Native water
    // detail maps have different channels/UVs and cannot be used as color or ORM.
    for (const extension of material.listExtensions())
      material.setExtension(extension.extensionName, null);
    prepared.add(material);
    const srgbToLinear = (n) => (n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4);
    const r = Math.sqrt(row.reflectance);
    const ior = document
      .createExtension(KHRMaterialsIOR)
      .createIOR()
      .setIOR((1 + r) / (1 - r));
    material
      .setExtension('KHR_materials_ior', ior)
      .setBaseColorTexture(null)
      .setEmissiveTexture(null)
      .setEmissiveFactor([0, 0, 0])
      .setMetallicRoughnessTexture(null)
      .setOcclusionTexture(null)
      .setNormalTexture(null)
      .setAlphaMode('BLEND')
      .setMetallicFactor(0)
      .setRoughnessFactor(row.roughness)
      .setBaseColorFactor([...row.fog.map(srgbToLinear), row.density / (1 + row.density)])
      .setExtras({
        ...extras,
        cswatch: {
          ...extras.cswatch,
          water: { schemaVersion: 1, reflectance: row.reflectance, exponent: row.exponent },
        },
      });
  }
  return prepared;
}
