import { fulfillReplayFixture } from './fixtures/streamed-replay';
import { test, expect } from '@playwright/test';
import { NodeIO } from '../../tools/assets/node_modules/@gltf-transform/core/dist/index.js';
import { batchMapMeshes } from '../../tools/assets/batch-map-meshes.mjs';
import { originalMapGLB, originalMapReplay } from './fixtures/original-map';
import { installDemoMapDescriptor } from './fixtures/map-assets';

test('static batching reduces original map submissions while preserving actual opaque map pixels and source hierarchy', async ({
  page,
}, info) => {
  test.skip(Boolean(process.env.E2E_PRIVATE));
  await page.setViewportSize({ width: 768, height: 600 });
  const io = new NodeIO(),
    document = await io.readBinary(originalMapGLB()),
    root = document.getRoot(),
    scene = root.listScenes()[0],
    source = root.listMeshes()[0].listPrimitives()[0],
    buffer = root.listBuffers()[0];
  for (const node of scene.listChildren()) node.dispose();
  for (let room = 0; room < 3; room++) {
    const primitive = document.createPrimitive().setMaterial(source.getMaterial());
    for (const semantic of source.listSemantics()) {
      const a = source.getAttribute(semantic),
        size = a.getElementSize();
      primitive.setAttribute(
        semantic,
        document
          .createAccessor()
          .setType(a.getType())
          .setArray(a.getArray().slice(room * 6 * size, (room + 1) * 6 * size))
          .setBuffer(buffer),
      );
    }
    scene.addChild(
      document
        .createNode('original-room-' + room)
        .setMesh(document.createMesh('original-room-' + room).addPrimitive(primitive)),
    );
  }
  const before = Buffer.from(await io.writeBinary(document)),
    report = await batchMapMeshes(document),
    after = Buffer.from(await io.writeBinary(document));
  expect(report.initialPrimitives).toBe(3);
  expect(report.finalPrimitives).toBeLessThan(3);
  await page.addInitScript(() => {
    localStorage.setItem('cswatch.language', 'en');
    localStorage.setItem(
      'viewer-settings-v2',
      JSON.stringify({
        quality: 'low',
        autoHideControls: false,
        matchScore: false,
        radar: false,
        economy: false,
        crosshair: false,
        killReplay: false,
        grenadeLanding: false,
      }),
    );
  });
  const pixels: Buffer[] = [];
  for (const [name, body] of [
    ['before', before],
    ['after', after],
  ] as const) {
    const id = 'batch-' + name,
      map = 'de_original_batch_' + name,
      data = originalMapReplay(map);
    data.events = [];
    data.grenades = [];
    data.frames = data.frames.map((f) => ({ ...f, players: [] }));
    await page.route(`**/api/demos/${id}`, (route) =>
      route.fulfill({
        json: {
          id,
          name: 'Original static batching QA, not game artwork',
          status: 'ready',
          owned: false,
          public: true,
          map,
        },
      }),
    );
    await page.route(`**/api/demos/${id}/playback`, (route) => fulfillReplayFixture(route, data));
    await installDemoMapDescriptor(page, id, {
      model: `/map-assets/${map}/desktop/scene.glb`,
      mobile: null,
      overview: null,
    });
    await page.route(`**/map-assets/${map}/desktop/scene.glb`, (route) =>
      route.fulfill({ contentType: 'model/gltf-binary', body }),
    );
    await page.goto('/watch/' + id);
    await expect(page.locator('.scene')).toHaveAttribute('data-map-model-state', 'ready');
    await page.locator('.viewer-stage').focus();
    await page.keyboard.press('h');
    await expect(page.locator('.viewer-frame')).toHaveAttribute('data-chrome-visible', 'false');
    await expect
      .poll(() =>
        page
          .locator('[data-viewer-chrome]')
          .evaluateAll((nodes) => nodes.every((node) => getComputedStyle(node).opacity === '0')),
      )
      .toBe(true);
    const screenshot = await page.locator('.scene canvas').screenshot({ animations: 'disabled' });
    pixels.push(screenshot);
    await info.attach(name, { body: screenshot, contentType: 'image/png' });
  }
  const comparison = await page.evaluate(
    async ({ a, b }) => {
      const decode = async (text: string) => {
          const bitmap = await createImageBitmap(
              new Blob([Uint8Array.from(atob(text), (c) => c.charCodeAt(0))], {
                type: 'image/png',
              }),
            ),
            canvas = new OffscreenCanvas(bitmap.width, bitmap.height),
            context = canvas.getContext('2d')!;
          context.drawImage(bitmap, 0, 0);
          bitmap.close();
          return context.getImageData(0, 0, canvas.width, canvas.height).data;
        },
        left = await decode(a),
        right = await decode(b);
      let changed = 0,
        contrast = 0;
      for (let i = 0; i < left.length; i += 4) {
        if (Math.max(...[0, 1, 2].map((c) => Math.abs(left[i + c] - right[i + c]))) > 3) changed++;
        if (
          Math.max(left[i], left[i + 1], left[i + 2]) -
            Math.min(left[i], left[i + 1], left[i + 2]) >
          10
        )
          contrast++;
      }
      return { changedRatio: changed / (left.length / 4), contrast };
    },
    { a: pixels[0].toString('base64'), b: pixels[1].toString('base64') },
  );
  expect(comparison.contrast, 'Original colored geometry must actually render').toBeGreaterThan(
    1000,
  );
  expect(comparison.changedRatio, 'Static batching must preserve rendered map pixels').toBeLessThan(
    0.001,
  );
});
