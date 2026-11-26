// Official agent models a demo may record, keyed by the recorded model resource handle.
// The team defaults (ct.glb, t.glb) are not listed: their handles keep the team model.
import catalogue from './agent-models.json' with { type: 'json' };
import { modelResourceId } from './model-resource-id.mjs';

export const agentModelLimits = Object.freeze({
  /** Distinct recorded handles kept per demo. A match has at most a few dozen. */
  perDemo: 64,
  /** Catalogue entries; every one of them may be requested at once. */
  catalogue: 128,
  requestBytes: 16384,
});
export const agentModelHandle = (value) =>
  typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value);

function load() {
  if (
    catalogue?.schemaVersion !== 1 ||
    !/^[1-9]\d{0,19}$/.test(catalogue.manifest) ||
    !Array.isArray(catalogue.agents) ||
    !catalogue.agents.length ||
    catalogue.agents.length > agentModelLimits.catalogue ||
    new Set(catalogue.agents).size !== catalogue.agents.length
  )
    throw Error('Invalid official agent catalogue.');
  const models = new Map();
  for (const entry of catalogue.agents) {
    const match = /^((ctm|tm)_[a-z0-9_]{1,40})\/(ctm|tm)_[a-z0-9_]{1,60}$/.exec(entry);
    if (!match || match[2] !== match[3]) throw Error('Invalid official agent entry.');
    const handle = modelResourceId(`characters/models/${entry}.vmdl`);
    if (models.has(handle)) throw Error('Duplicate official agent handle.');
    models.set(
      handle,
      Object.freeze({
        handle,
        entry,
        team: match[2] === 'ctm' ? 'ct' : 't',
        resource: `agents/models/${entry}.vmdl_c`,
      }),
    );
  }
  return models;
}
/** handle -> { handle, entry, team, resource } */
export const officialAgentModels = load();
export const officialAgentManifest = catalogue.manifest;
