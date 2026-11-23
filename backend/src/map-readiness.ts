/** Read-only local operational diagnostics. Never contacts Steam or chooses a source. */
import type { Config } from './config.js';
import type { MapPreparationDiagnostics } from '../../shared/map-acquisition.js';
import { officialMapInventoryLimits, readMapCatalog } from './map-catalog.js';
import { readMapWorkerStatus, readOfficialMapInventory } from './map-jobs.js';
export async function readMapPreparationState(c: Config, at = Math.floor(Date.now() / 1000)) {
  const [catalog, inventory, worker] = await Promise.all([
    readMapCatalog(c.mapCatalogFile),
    readOfficialMapInventory(c.mapJobsDir, at, { allowStale: true }),
    readMapWorkerStatus(c.mapJobsDir),
  ]);
  const inventoryFresh = Boolean(
    inventory && inventory.updatedAt >= at - officialMapInventoryLimits.maxAgeSeconds,
  );
  const diagnostics: Omit<MapPreparationDiagnostics, 'enabled'> = {
    worker: {
      available: Boolean(worker && worker.updatedAt <= at + 5 && worker.updatedAt >= at - 90),
      ...(worker?.inventoryFailure ? { inventoryFailure: worker.inventoryFailure } : {}),
    },
    inventory: {
      status: inventory ? (inventoryFresh ? 'fresh' : 'stale') : 'unavailable',
      mapCount: inventory?.maps.length ?? 0,
      ...(inventory ? { manifest: inventory.manifest, updatedAt: inventory.updatedAt } : {}),
    },
    catalog: {
      status: catalog ? (catalog.entries.length ? 'configured' : 'empty') : 'unavailable',
      entries: catalog?.entries.length ?? 0,
    },
  };
  return { catalog, inventory, inventoryFresh, diagnostics };
}
