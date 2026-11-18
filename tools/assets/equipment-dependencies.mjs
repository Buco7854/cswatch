/** Selective model closure, seeded ONLY by explicitly registered model resources. */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readVpkDirectory, resourcePath, source2References } from './source2-dependencies.mjs';
import { staticModelDependency } from './equipment-source-model.mjs';
import { agentAnimationRegistry } from './agent-animation-registry.mjs';
export const agentIdleResource = agentAnimationRegistry.idle;
const fixedAnimationResources = new Set(Object.values(agentAnimationRegistry));
export async function scanEquipmentDependencies({ game, seeds, index = readVpkDirectory }) {
  if (
    !Array.isArray(seeds) ||
    !seeds.length ||
    seeds.length > 96 ||
    seeds.some(
      (x) =>
        !/^((weapons|agents)\/models\/[a-z0-9_/-]+\.vmdl_c)$/.test(x) &&
        !fixedAnimationResources.has(x),
    )
  )
    throw Error('Equipment closure requires fixed selected model seeds.');
  const sources = [];
  for (const group of ['csgo', 'core'])
    sources.push({ group, index: await index(join(game, `game/${group}/pak01_dir.vpk`)) });
  const queue = [...new Set(seeds.map((x) => resourcePath(x, { compiled: true })))],
    queued = new Set(queue),
    pending = { csgo: [], core: [] },
    unknown = [],
    skipped = [],
    materials = [];
  let readBytes = 0,
    read = 0;
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const resource = queue[cursor];
    if (
      !staticModelDependency(resource) &&
      !(fixedAnimationResources.has(resource) && seeds.includes(resource))
    ) {
      skipped.push(resource);
      continue;
    }
    const owner = sources.find((source) => source.index.entries.has(resource));
    if (!owner) {
      unknown.push(resource);
      continue;
    }
    const entry = owner.index.entries.get(resource),
      length = entry.length + entry.preloadBytes;
    if (length > 128 * 1024 ** 2) throw Error('Selected equipment dependency exceeds 128 MiB.');
    const bytes = await owner.index.readEntry(resource);
    if (!bytes) {
      const { preload, ...record } = entry;
      pending[owner.group].push(record);
      continue;
    }
    read++;
    readBytes += bytes.length;
    if (readBytes > 1024 ** 3) throw Error('Selected static equipment closure exceeds 1 GiB.');
    if (resource.endsWith('.vmat_c'))
      materials.push({
        resource,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        source: { kind: 'vpk', path: owner.index.provenance.path },
      });
    for (const dependency of source2References(bytes))
      if (!queued.has(dependency)) {
        if (queue.length >= 8192) throw Error('Selected equipment resource count exceeds 8192.');
        queued.add(dependency);
        queue.push(dependency);
      }
  }
  return {
    schemaVersion: 1,
    sources: sources.map(({ group, index }) => ({ group, ...index.provenance })),
    counts: {
      initial: seeds.length,
      visited: queue.length,
      read,
      readBytes,
      pending: pending.csgo.length + pending.core.length,
      unknown: unknown.length,
    },
    pending,
    materials,
    unknown,
    skipped,
  };
}
