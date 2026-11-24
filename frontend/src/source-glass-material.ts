import { Material, MeshPhysicalMaterial, MeshStandardMaterial } from 'three';

export function preparedGlass(material: Material) {
  const glass = material.userData.cswatch;
  const data = glass?.texturedGlass ?? glass?.constantGlass;
  return data?.schemaVersion === 1 && typeof data.castsShadow === 'boolean'
    ? (data as { castsShadow: boolean })
    : undefined;
}

/** The pack contains linear dust color, its opacity and a dielectric material.
 * Its verified neutral transmission needs no background render target. */
export function applyPreparedGlass(material: MeshStandardMaterial) {
  if (
    !preparedGlass(material) ||
    material instanceof MeshPhysicalMaterial ||
    !material.transparent ||
    (material.map && !material.userData.cswatch?.texturedGlass) ||
    material.alphaMap ||
    material.metalness !== 0 ||
    material.onBeforeCompile !== Material.prototype.onBeforeCompile ||
    material.customProgramCacheKey !== Material.prototype.customProgramCacheKey
  )
    return;
  // Native untinted glass transmits (1 - Fresnel) × (1 - dust opacity).
  // Convert reflected light to straight alpha for the ordinary transparent pass.
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <opaque_fragment>',
      `float glassFacing = clamp(dot(geometryViewDir, normal), 0.0, 1.0);
       float glassFresnel = 0.04 + 0.96 * pow(1.0 - glassFacing, 5.0);
       float glassCoverage = mix(glassFresnel, 1.0, diffuseColor.a);
       outgoingLight = (totalDiffuse * diffuseColor.a + totalSpecular + totalEmissiveRadiance) / glassCoverage;
       diffuseColor.a = glassCoverage;
       #include <opaque_fragment>`,
    );
  };
  material.customProgramCacheKey = () => 'cswatch-source-glass';
  material.needsUpdate = true;
}
