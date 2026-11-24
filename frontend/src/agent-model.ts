import { reusePackedMaterialSamples } from './packed-material';
import {
  Group,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  type Material,
  type Object3D,
} from 'three';
import { prepareEquipmentModel } from './equipment-model';

/** Operator agents retain S2V meters/Y-up axes. The viewer applies its one +90°Y correction. */
export function prepareAgentModel(source: Object3D) {
  const root = new Group(),
    instance = prepareEquipmentModel(source);
  root.rotation.y = Math.PI / 2;
  root.add(instance);
  const cloth = new Map<Material, MeshPhysicalMaterial>();
  function restoreSheen(material: Material): Material {
    const source = material.userData.vmat;
    const scale = source?.FloatParams?.g_flSheenScale;
    const tint = source?.VectorParams?.g_flSheenTintColor;
    if (
      !(material instanceof MeshStandardMaterial) ||
      source?.ShaderName !== 'csgo_character.vfx' ||
      source?.IntParams?.F_CLOTH_SHADING !== 1 ||
      !material.normalMap ||
      typeof scale !== 'number' ||
      !Number.isFinite(scale) ||
      !Array.isArray(tint) ||
      tint.slice(0, 3).length !== 3 ||
      !tint.slice(0, 3).every((value) => Number.isFinite(value) && value >= 0 && value <= 1)
    )
      return material;
    let result = cloth.get(material);
    if (result) return result;
    result = new MeshPhysicalMaterial();
    // Keep the packed normal, AO, roughness and metal textures. Add the cloth
    // lobe from the trusted Source material parameters using glTF's PBR model.
    MeshStandardMaterial.prototype.copy.call(result, material);
    result.sheen = Math.max(0, Math.min(1, scale));
    result.sheenColor.fromArray(tint);
    result.sheenColorMap = material.map;
    result.sheenRoughness = 0.8;
    reusePackedMaterialSamples(result);
    cloth.set(material, result);
    return result;
  }
  instance.traverse((node) => {
    if (!(node instanceof Mesh)) return;
    node.material = Array.isArray(node.material)
      ? node.material.map(restoreSheen)
      : restoreSheen(node.material);
  });
  return {
    root,
    instance,
    disposeMaterials() {
      for (const material of cloth.values()) material.dispose();
    },
  };
}
