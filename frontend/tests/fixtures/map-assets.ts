import type { DemoMapAssets } from '../../../shared/map-acquisition';
import type { MapAssets } from '../../../shared/map-assets';
import type { Page } from '@playwright/test';
import { originalMapGLB, originalOverviewPNG, qaOverview } from './original-map';
const model = originalMapGLB(),
  image = originalOverviewPNG();
export function manualMapAssets(assets: MapAssets): DemoMapAssets {
  return {
    resolution: { status: 'unknown' },
    canAcquire: false,
    acquisition: 'disabled',
    verification:
      assets.model || assets.mobile || assets.overview ? 'version-unverified' : 'unavailable',
    packId: null,
    assets,
  };
}
export async function installDemoMapDescriptor(
  page: Page,
  id: string,
  assets: MapAssets = { model: null, mobile: null, overview: null, environment: null },
) {
  await page.route(`**/api/demos/${id}/map-assets`, (route) =>
    route.fulfill({ json: manualMapAssets(assets) }),
  );
}
/** Original test artwork supplies real geometry/calibration where a journey needs a map. */
export async function installMapFixture(page: Page, map: string, id = '*') {
  const overview = { ...qaOverview, image: `/api/maps/${map}/overview.png` };
  await installDemoMapDescriptor(page, id, {
    model: `/map-assets/${map}/desktop/scene.glb`,
    mobile: null,
    overview,
  });
  await page.route(`**/map-assets/${map}/desktop/scene.glb`, (route) =>
    route.fulfill({ contentType: 'model/gltf-binary', body: model }),
  );
  await page.route(`**/api/maps/${map}/overview.png`, (route) =>
    route.fulfill({ contentType: 'image/png', body: image }),
  );
}
