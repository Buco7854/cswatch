import { createHash } from 'node:crypto';
import type { Page } from '@playwright/test';
import { nativeWorldPack } from '../../../tools/assets/fixtures/native-world.mjs';
import { rooms } from './original-map';

const inch = 1 / 0.0254;
/** Viewer Y-up meters to Source Z-up inches, the inverse of the app's world transform. */
export const sourcePoint = ([x, y, z]: number[]) => [x * inch, -z * inch, y * inch];
/** The original fixtures' map-root frame, which the viewer turns +90 degrees about Y. */
const mapRootPoint = ([x, y, z]: number[]) => [z, y, -x];
/** The original room floors plus optional faces given in the original map-root frame. */
export function nativeMap(map: string, faces: number[][][] = []) {
  const pack = nativeWorldPack({
    map,
    quads: rooms.map(([left, top, right, bottom]) => [
      -1024 + left * 2,
      1024 - bottom * 2,
      -1024 + right * 2,
      1024 - top * 2,
    ]),
    faces: faces.map((face) => face.map((point) => sourcePoint(mapRootPoint(point)))),
  });
  const hash = createHash('sha256').update(pack.model).digest('hex');
  return {
    pack,
    model: (demoId: string, generation = 'manual') =>
      `/api/demos/${demoId}/world/${generation}/${hash}/map.json`,
    async route(page: Page) {
      await page.route(`**/world/*/${hash}/*`, (route) => {
        const name = new URL(route.request().url()).pathname.split('/').at(-1)!;
        const body = name === 'map.json' ? pack.model : pack.files.get(name);
        return body
          ? route.fulfill({
              contentType: name === 'map.json' ? 'application/json' : 'application/octet-stream',
              body,
            })
          : route.fulfill({ status: 404 });
      });
    },
  };
}
