import assert from 'node:assert/strict';
import { lstat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  readMapCatalog,
  resolveMap,
  latestOfficialSelection,
  latestMapRequestId,
} from '../../backend/dist/map-catalog.js';
import {
  readMapRequest,
  readMapResult,
  readOfficialMapInventory,
  prepareMapJobs,
} from '../../backend/dist/map-jobs.js';
import {
  inspectManagedPack,
  readMapRemoval,
  unsettledMapRemoval,
} from '../../backend/dist/map-removals.js';
import { mapIdentitySchema } from '../../backend/dist/map-identity.js';
import { preparerRevision } from '../../backend/dist/asset-preparer.js';
import { withDirectory } from '../../backend/dist/map-asset-files.js';
import { readPresentationStatus } from '../../backend/dist/presentation-assets.js';

// Select only through the recorder identity, current worker protocol and immutable pack marker.
// All paths in the operator queue are read through the application's bounded no-follow readers.
export async function readManagedPack({ jobs, catalogFile, assets, map, identity }) {
  if (identity !== undefined) {
    const parsed = mapIdentitySchema.parse(identity);
    assert(
      parsed.map === map && !parsed.conflicted && parsed.addonPresence !== 'present',
      'Managed map selection conflicts with the recording',
    );
  }
  let catalog;
  if (catalogFile) {
    assert((await lstat(catalogFile)).isFile(), 'Expected a regular map catalog');
    catalog = await readMapCatalog(catalogFile);
    assert(catalog, 'Invalid operator map catalog');
  }
  const exact = resolveMap(identity, catalog ?? { schemaVersion: 1, entries: [] });
  assert(exact.status !== 'ambiguous', 'Ambiguous historical map approvals');
  const approval = exact.status === 'approved' ? exact.approval : null;
  const exactResult = approval ? await readMapResult(jobs, exact.packId) : null;
  const useLatest =
    !approval || (exactResult?.status === 'failed' && exactResult.code === 'source_unavailable');
  let inventory = null,
    requestId = exact.packId;
  if (useLatest) {
    const full = await readOfficialMapInventory(jobs, Math.floor(Date.now() / 1000), {
      allowStale: true,
    });
    const selected = full && latestOfficialSelection(full, map);
    assert(selected, 'No matching installed official inventory entry');
    requestId = latestMapRequestId(selected);
    inventory = { ...full, maps: full.maps.filter((m) => m.map === map) };
  }
  const request = await readMapRequest(jobs, requestId),
    result = useLatest ? await readMapResult(jobs, requestId) : exactResult;
  assert(request && result?.status === 'ready', 'Matching installed map job is not ready');
  const marker = await inspectManagedPack(assets, request, result);
  assert(
    marker?.map === map && marker.preparedAt <= Date.now() / 1000 + 300,
    'Invalid installed pack marker',
  );
  for (const dir of ['removals', 'removal-results'])
    assert(await withDirectory(jobs, [dir], async () => true), 'Removal state unavailable');
  // A completed removal for these same bytes also blocks a stale ready record.
  const removal = await readMapRemoval(jobs, marker.packId);
  assert(
    !(await unsettledMapRemoval(jobs, marker.packId)) &&
      !(removal?.generation === request.generation && removal.markerSha256 === marker.version),
    'Managed pack removal',
  );
  return {
    marker,
    request,
    result,
    inventory,
    approval,
    historicalFailure: useLatest ? exactResult : null,
    source: useLatest ? result.source : approval.source,
    verification: useLatest ? 'latest-official' : 'operator-approved',
  };
}

export async function snapshotManagedPack(state, sourceJobs, scratchConfig) {
  const jobs = scratchConfig.mapJobsDir;
  await prepareMapJobs(jobs);
  const write = (path, data) => writeFile(path, JSON.stringify(data), { flag: 'wx', mode: 0o600 });
  if (state.inventory) await write(join(jobs, 'official-inventory.json'), state.inventory);
  if (state.approval)
    await write(scratchConfig.mapCatalogFile, { schemaVersion: 1, entries: [state.approval] });
  if (state.historicalFailure)
    await write(
      join(jobs, 'results', state.historicalFailure.packId + '.json'),
      state.historicalFailure,
    );
  await write(join(jobs, 'requests', state.request.packId + '.json'), state.request);
  await write(join(jobs, 'results', state.result.packId + '.json'), state.result);
  const status = await readPresentationStatus(sourceJobs);
  if (status) await write(join(jobs, 'presentation-status-v' + preparerRevision + '.json'), status);
}
