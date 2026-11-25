import type { DemoMapAssets } from '../../../shared/map-acquisition';
import type { MapAssets } from '../../../shared/map-assets';
import type { Page } from '@playwright/test';
import { originalOverviewPNG, qaOverview } from './original-map';
import { nativeMap } from './native-map';
const image = originalOverviewPNG();
export function manualMapAssets(assets: MapAssets): DemoMapAssets {
  return {
    resolution: { status: 'unknown' },
    canAcquire: false,
    acquisition: 'disabled',
    verification: assets.model || assets.overview ? 'version-unverified' : 'unavailable',
    packId: null,
    assets,
  };
}
export async function installDemoMapDescriptor(
  page: Page,
  id: string,
  assets: MapAssets = { model: null, overview: null },
) {
  await page.route(`**/api/demos/${id}/map-assets`, (route) =>
    route.fulfill({ json: manualMapAssets(assets) }),
  );
}
/** Original test geometry and calibration where a journey needs a map, for any demo ID. */
export async function installMapFixture(page: Page, map: string, id = '*') {
  const overview = { ...qaOverview, image: `/api/maps/${map}/overview.png` };
  const world = nativeMap(map);
  await page.route(`**/api/demos/${id}/map-assets`, (route) => {
    const demo = new URL(route.request().url()).pathname.split('/')[3];
    return route.fulfill({ json: manualMapAssets({ model: world.model(demo), overview }) });
  });
  await world.route(page);
  await page.route(`**/api/maps/${map}/overview.png`, (route) =>
    route.fulfill({ contentType: 'image/png', body: image }),
  );
}
