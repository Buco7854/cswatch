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
const identity = (position) => ({ position, rotation: [0, 0, 0], scale: 1 });
/** Review attachments, not native hand bones. The source-sized model is never normalized. */
export function equipmentAttachmentPreset(id, bounds) {
  const entry = equipmentModelRegistry[id];
  if (!entry) throw new Error('Unknown fixed equipment model.');
  const pov = entry.preset === 'long-gun' ? [0.45, -0.22, 0.14] : [0.38, -0.22, 0.15];
  if (bounds) {
    pov[0] = Math.max(pov[0], 0.08 - bounds.min[0]);
    if (!Number.isFinite(pov[0]) || pov[0] > 4)
      throw new Error('Native model origin cannot fit a bounded static POV preset.');
  }
  return {
    approximate: true,
    hold: identity(entry.preset === 'long-gun' ? [0.15, 1.25, 0.1] : [0.2, 1.2, 0.12]),
    pov: identity(pov),
  };
}
