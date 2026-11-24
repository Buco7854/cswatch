import { Material, MeshPhysicalMaterial, Vector2 } from 'three';

export function preparedWater(material: Material) {
  const p = material.userData?.cswatch?.water;
  return material instanceof MeshPhysicalMaterial &&
    material.transparent &&
    !material.transmission &&
    material.userData.vmat?.ShaderName === 'csgo_water_fancy.vfx' &&
    p?.schemaVersion === 1 &&
    Number.isFinite(p.reflectance) &&
    p.reflectance >= 0 &&
    p.reflectance <= 0.5 &&
    Number.isFinite(p.exponent) &&
    p.exponent >= 1 &&
    p.exponent <= 32
    ? (p as { reflectance: number; exponent: number })
    : undefined;
}

/** Fixed fog coverage and the authored angular reflectance share the ordinary
 * transparent surface draw. The PBR lighting already includes the sky and sun. */
export function applyPreparedWater(material: Material) {
  const p = preparedWater(material);
  if (!p || material.onBeforeCompile !== Material.prototype.onBeforeCompile) return;
  material.forceSinglePass = true;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.cswatchWaterFresnel = { value: new Vector2(p.reflectance, p.exponent) };
    shader.fragmentShader =
      'uniform vec2 cswatchWaterFresnel;\n' +
      shader.fragmentShader.replace(
        '#include <opaque_fragment>',
        `float facing = clamp(dot(geometryViewDir, normal), 0.0, 1.0);
       float reflected = mix(cswatchWaterFresnel.x, 1.0, pow(1.0 - facing, cswatchWaterFresnel.y));
       float scatter = diffuseColor.a * (1.0 - reflected);
       diffuseColor.a = reflected + scatter;
       outgoingLight = (totalDiffuse * scatter + totalSpecular) / max(diffuseColor.a, 0.00001);
       #include <opaque_fragment>`,
      );
  };
  material.customProgramCacheKey = () => 'cswatch-static-water';
}
