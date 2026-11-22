/** Fixed Source model identities. Runtime never accepts operator/client model URLs. */
import { readFileSync } from 'node:fs';
const registry = JSON.parse(
  readFileSync(new URL('../../shared/equipment-models.json', import.meta.url), 'utf8'),
);
export const equipmentModelRegistry = Object.freeze(registry.items);
export const equipmentModelIds = Object.freeze(Object.keys(registry.items));
export const equipmentModelLimits = Object.freeze({
  items: 96,
  modelBytes: 16 * 1024 ** 2,
  decodedTextureBytes: 16 * 1024 ** 2,
  geometryBytes: 8 * 1024 ** 2,
  metadataBytes: 16384,
  provenanceBytes: 1024 ** 2,
  sourceBytes: 512 * 1024 ** 2,
  sourceFileBytes: 128 * 1024 ** 2,
  sourceFiles: 512,
  maxTextureEdge: 1024,
});
export function selectedEquipmentModels(value) {
  const values =
    value === 'all'
      ? equipmentModelIds
      : Array.isArray(value)
        ? value
        : typeof value === 'string'
          ? value.split(',')
          : [];
  if (
    !values.length ||
    values.length > equipmentModelLimits.items ||
    new Set(values).size !== values.length ||
    values.some((id) => !Object.hasOwn(equipmentModelRegistry, id))
  )
    throw new Error('Select exact supported equipment IDs, or the explicit all selection.');
  return [...values];
}
