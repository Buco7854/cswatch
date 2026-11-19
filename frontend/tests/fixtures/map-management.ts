import type { Page } from '@playwright/test';
import type { ManagedMap } from '../../../shared/map-acquisition';
import { installMemberWorkspace, memberAdminData } from './member-workspace';

export const managedSnapshot: ManagedMap = {
  packId: 'a'.repeat(64),
  map: 'de_ancient',
  manifest: '807392217824910805',
  preparedAt: 1795090000,
  version: 'b'.repeat(64),
  removal: 'none',
};
export async function installMapManagement(page: Page, maps: ManagedMap[] = [managedSnapshot]) {
  await installMemberWorkspace(page);
  const state = {
    maps: structuredClone(maps),
    requests: [] as { path: string; body: unknown }[],
    retried: false,
    retryAt: undefined as number | undefined,
    terminal: false,
  };
  await page.route('**/api/admin/maps**', async (route) => {
    if (route.request().method() === 'DELETE') {
      state.requests.push({
        path: new URL(route.request().url()).pathname,
        body: route.request().postDataJSON(),
      });
      state.maps = state.maps.map((map) =>
        map.packId === managedSnapshot.packId ? { ...map, removal: 'queued' } : map,
      );
      return route.fulfill({ status: 202, json: { queued: true } });
    }
    return route.fulfill({
      json: { maps: state.maps, workerAvailable: true, operatorMaps: [{ map: 'de_cache' }] },
    });
  });
  await page.route('**/api/admin', (route) =>
    route.fulfill({
      json: {
        ...memberAdminData(),
        mapReadiness: {
          enabled: true,
          worker: { available: true },
          inventory: { status: 'fresh', mapCount: 42, updatedAt: 1795090000 },
          catalog: { status: 'empty', entries: 0 },
        },
        presentationAssets: {
          schemaVersion: 1,
          categories: {
            agents: {
              manifest: managedSnapshot.manifest,
              generation: 'c'.repeat(24),
              attempts: state.retried ? 0 : 3,
              updatedAt: 1795090000,
              status: state.retried ? 'preparing' : 'failed',
              ...(state.retried
                ? { stage: 'converting', item: 'ct' }
                : { code: state.terminal ? 'source_mismatch' : 'preparation_failed' }),
              ...(state.retryAt ? { retryAt: state.retryAt } : {}),
            },
            equipment: {
              manifest: managedSnapshot.manifest,
              generation: 'd'.repeat(24),
              attempts: 1,
              updatedAt: 1795090000,
              status: 'ready',
              counts: { ready: 67, unavailable: 0, total: 67 },
            },
            'equipment-models': {
              manifest: managedSnapshot.manifest,
              generation: 'e'.repeat(24),
              attempts: 1,
              updatedAt: 1795090000,
              status: 'preparing',
              stage: 'converting',
              item: 'ak47',
              counts: { ready: 8, unavailable: 1, total: 67 },
              unsupported: ['scar20'],
            },
          },
        },
      },
    }),
  );
  await page.route('**/api/admin/assets/presentation/agents/retry', (route) => {
    state.requests.push({
      path: new URL(route.request().url()).pathname,
      body: route.request().postDataJSON(),
    });
    state.retried = true;
    return route.fulfill({ status: 202, json: { queued: true } });
  });
  return state;
}
