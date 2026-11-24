import { Extension, ExtensionProperty, PropertyType, TextureInfo } from '@gltf-transform/core';

export const environmentLayerExtension = 'CSWATCH_environment_albedo';
export const environmentSlots = ['baseHeight', 'paintLayer2', 'paintLayer3', 'colorOverlay'];

class EnvironmentAlbedo extends ExtensionProperty {
  init() {
    this.extensionName = environmentLayerExtension;
    this.propertyType = 'EnvironmentAlbedo';
    this.parentTypes = [PropertyType.MATERIAL];
  }
  getDefaults() {
    const defaults = { ...super.getDefaults(), parameters: {} };
    for (const slot of environmentSlots) {
      defaults[slot] = null;
      defaults[slot + 'Info'] = new TextureInfo(this.graph, slot + 'Info');
    }
    return defaults;
  }
  setParameters(parameters) {
    return this.set('parameters', parameters);
  }
  getParameters() {
    return this.get('parameters');
  }
  getTexture(slot) {
    return this.getRef(slot);
  }
  setTexture(slot, texture) {
    return this.setRef(slot, texture);
  }
  getTextureInfo(slot) {
    return this.getRef(slot + 'Info');
  }
}

/** Keep layer textures referenced through pruning, per-tier resampling and meshopt serialization. */
export class MapEnvironmentAlbedoExtension extends Extension {
  static EXTENSION_NAME = environmentLayerExtension;
  extensionName = environmentLayerExtension;
  prereadTypes = [PropertyType.MESH];
  prewriteTypes = [PropertyType.MESH];
  createBinding() {
    return new EnvironmentAlbedo(this.document.getGraph());
  }
  read() {
    return this;
  }
  write() {
    return this;
  }
  preread(context) {
    const json = context.jsonDoc.json;
    for (const [index, material] of (json.materials ?? []).entries()) {
      const data = material.extensions?.[environmentLayerExtension];
      if (!data) continue;
      if (data.schemaVersion !== 1 || !data.parameters)
        throw Error('Unsupported environment albedo binding.');
      const binding = this.createBinding().setParameters(data.parameters);
      for (const slot of environmentSlots) {
        const info = data[slot];
        if (!info) continue;
        const texture = json.textures?.[info.index];
        const image =
          context.textures[texture?.extensions?.EXT_texture_webp?.source ?? texture?.source];
        if (!image) throw Error('Missing environment albedo image.');
        binding.setTexture(slot, image);
        context.setTextureInfo(binding.getTextureInfo(slot), info);
      }
      context.materials[index].setExtension(environmentLayerExtension, binding);
    }
    return this;
  }
  prewrite(context) {
    for (const material of this.document.getRoot().listMaterials()) {
      const binding = material.getExtension(environmentLayerExtension);
      if (!binding) continue;
      const data = { schemaVersion: 1, parameters: binding.getParameters() };
      for (const slot of environmentSlots) {
        const texture = binding.getTexture(slot);
        if (texture)
          data[slot] = context.createTextureInfoDef(texture, binding.getTextureInfo(slot));
      }
      const definition = context.jsonDoc.json.materials[context.materialIndexMap.get(material)];
      definition.extensions ??= {};
      definition.extensions[environmentLayerExtension] = data;
    }
    return this;
  }
}
