import { Extension, ExtensionProperty, PropertyType, TextureInfo } from '@gltf-transform/core';
import format from '../../shared/map-baked-lighting.json' with { type: 'json' };

const layerSlots = ['layerColorTexture', 'layerBlendTexture', 'layerDetailTexture'];

class BakedLighting extends ExtensionProperty {
  init() {
    this.extensionName = format.extension;
    this.propertyType = 'BakedLighting';
    this.parentTypes = [PropertyType.MATERIAL];
  }
  getDefaults() {
    return {
      ...super.getDefaults(),
      irradianceTexture: null,
      irradianceTextureInfo: new TextureInfo(this.graph, 'irradianceTextureInfo'),
      lightingDirectionTexture: null,
      lightingDirectionTextureInfo: new TextureInfo(this.graph, 'lightingDirectionTextureInfo'),
      layerColorTexture: null,
      layerColorTextureInfo: new TextureInfo(this.graph, 'layerColorTextureInfo'),
      layerBlendTexture: null,
      layerBlendTextureInfo: new TextureInfo(this.graph, 'layerBlendTextureInfo'),
      layerDetailTexture: null,
      layerDetailTextureInfo: new TextureInfo(this.graph, 'layerDetailTextureInfo'),
      layerDetailScale: null,
      layerDetailStrength: 0,
    };
  }
  getTexture() {
    return this.getRef('irradianceTexture');
  }
  setTexture(texture) {
    return this.setRef('irradianceTexture', texture);
  }
  getTextureInfo() {
    return this.getRef('irradianceTextureInfo');
  }
  getDirection() {
    return this.getRef('lightingDirectionTexture');
  }
  setDirection(texture) {
    return this.setRef('lightingDirectionTexture', texture);
  }
  getDirectionInfo() {
    return this.getRef('lightingDirectionTextureInfo');
  }
  getLayerTexture(slot) {
    return this.getRef(slot);
  }
  setLayerTexture(slot, texture) {
    return this.setRef(slot, texture);
  }
  getLayerTextureInfo(slot) {
    return this.getRef(slot + 'Info');
  }
  setLayerDetail(scale, strength) {
    return this.set('layerDetailScale', scale).set('layerDetailStrength', strength);
  }
  getLayerDetail() {
    return {
      detailScale: this.get('layerDetailScale'),
      detailStrength: this.get('layerDetailStrength'),
    };
  }
}

/** The material owns the graph edge, so deduplication and texture budgeting retain the atlas. */
export class MapBakedLightingExtension extends Extension {
  static EXTENSION_NAME = format.extension;
  extensionName = format.extension;
  prereadTypes = [PropertyType.MESH];
  prewriteTypes = [PropertyType.MESH];

  createLighting() {
    return new BakedLighting(this.document.getGraph());
  }
  read() {
    return this;
  }
  write() {
    return this;
  }
  preread(context) {
    const json = context.jsonDoc.json;
    const textureOf = (info) => {
      const texture = json.textures?.[info?.index];
      const source = texture?.extensions?.EXT_texture_webp?.source ?? texture?.source;
      return context.textures[source];
    };
    for (const [index, definition] of (json.materials ?? []).entries()) {
      const extension = definition.extensions?.[format.extension];
      if (!extension) continue;
      const info = extension.irradianceTexture;
      const texture = textureOf(info);
      if (
        extension.schemaVersion !== format.schemaVersion ||
        info?.texCoord !== format.texCoord ||
        !texture
      )
        throw Error('Unsupported map baked-lighting extension.');
      const lighting = this.createLighting().setTexture(texture);
      context.setTextureInfo(lighting.getTextureInfo(), info);
      if (extension.directionTexture !== undefined) {
        const direction = extension.directionTexture;
        const directionTexture = textureOf(direction);
        if (!directionTexture || direction.texCoord !== format.texCoord)
          throw Error('Unsupported directional map lighting texture.');
        lighting.setDirection(directionTexture);
        context.setTextureInfo(lighting.getDirectionInfo(), direction);
      }
      if (extension.layers !== undefined) {
        for (const slot of layerSlots) {
          const info = extension.layers[slot];
          if (slot === 'layerDetailTexture' && info === undefined) continue;
          const texture = textureOf(info);
          if (!texture || (info.texCoord ?? 0) !== 0) throw Error('Unsupported map layer texture.');
          lighting.setLayerTexture(slot, texture);
          context.setTextureInfo(lighting.getLayerTextureInfo(slot), info);
        }
        if (lighting.getLayerTexture('layerDetailTexture'))
          lighting.setLayerDetail(extension.layers.detailScale, extension.layers.detailStrength);
      }
      context.materials[index].setExtension(format.extension, lighting);
    }
    return this;
  }
  prewrite(context) {
    for (const material of this.document.getRoot().listMaterials()) {
      const lighting = material.getExtension(format.extension);
      if (!lighting) continue;
      const index = context.materialIndexMap.get(material);
      const definition = context.jsonDoc.json.materials[index];
      definition.extensions ??= {};
      const extension = {
        schemaVersion: format.schemaVersion,
        irradianceTexture: context.createTextureInfoDef(
          lighting.getTexture(),
          lighting.getTextureInfo(),
        ),
      };
      const direction = lighting.getDirection();
      if (direction)
        extension.directionTexture = context.createTextureInfoDef(
          direction,
          lighting.getDirectionInfo(),
        );
      if (lighting.getLayerTexture('layerColorTexture')) {
        extension.layers = {};
        for (const slot of layerSlots) {
          const layer = lighting.getLayerTexture(slot);
          if (layer)
            extension.layers[slot] = context.createTextureInfoDef(
              layer,
              lighting.getLayerTextureInfo(slot),
            );
        }
        if (extension.layers.layerDetailTexture)
          Object.assign(extension.layers, lighting.getLayerDetail());
      }
      definition.extensions[format.extension] = extension;
    }
    return this;
  }
}
