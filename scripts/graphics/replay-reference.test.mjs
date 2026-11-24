import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { digest } from './capture-report.mjs';
import { compareReplayFrame } from './replay-reference.mjs';

test('recorded POV comparisons require a bound frame and a declared HUD-free, projection-matched external reference', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cswatch-frame-reference-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sharp = createRequire(new URL('../../tools/assets/package.json', import.meta.url))('sharp');
  const image = await sharp({
    create: { width: 16, height: 12, channels: 3, background: '#477588' },
  })
    .png()
    .toBuffer();
  await writeFile(join(root, 'shot.png'), image);
  const referencePath = join(root, 'ref.json');
  const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 4, 6, 1];
  const frame = {
    schemaVersion: 1,
    kind: 'cswatch-replay-frame',
    scope: 'production-pov-canvas',
    theme: 'dark',
    imageSource: 'chromium-composited-canvas',
    replaySha256: 'a'.repeat(64),
    modelSha256: 'b'.repeat(64),
    sourceSha256: 'c'.repeat(64),
    map: 'de_fixture',
    assetVersion: 'fixture-export',
    tick: 1024,
    player: '76561198000000001',
    cameraMode: 'pov',
    coordinateSystem: 'viewer-meters-y-up',
    viewport: { width: 16, height: 12 },
    buffer: [16, 12],
    camera: { worldMatrix: matrix, projectionMatrix: matrix },
    equipmentProjection: matrix,
    settings: { quality: 'high' },
    hudFree: true,
    colorSpace: 'srgb',
    png: 'shot.png',
    sha256: digest(image),
  };
  const external = {
    ...frame,
    kind: 'external-replay-frame-reference',
    provenance: {
      producer: 'reference',
      version: 'synthetic-test',
      captureSource: 'original test pixels',
      renderSettings: 'opaque test swatch',
      mapRevisionEvidence: 'generated test model',
    },
  };
  async function compare(ref) {
    await writeFile(referencePath, JSON.stringify(ref));
    return compareReplayFrame(frame, image, referencePath);
  }
  const result = await compare(external);
  assert.equal(result.status, 'matched-external');
  assert.equal(result.metrics.changedPixels, 0);
  assert.equal((await compare(frame)).status, 'matched-baseline');
  for (const patch of [
    { hudFree: false },
    { tick: 1023 },
    { player: 12345 },
    { replaySha256: null },
    { assetVersion: 'different' },
    { sourceSha256: 'd'.repeat(64) },
    { viewport: { width: 8, height: 6 } },
    { buffer: [12, 16] },
    { camera: { ...frame.camera, projectionMatrix: matrix.map((x) => x + 0.1) } },
    { camera: { ...frame.camera, worldMatrix: null } },
    { equipmentProjection: null },
    { provenance: { producer: 'CS2' } },
    { png: '../shot.png' },
    { sha256: '0'.repeat(64) },
  ]) {
    const r = await compare({ ...external, ...patch });
    assert.equal(r.status, 'unverified');
    assert.equal(r.metrics, null);
  }
  const mapSource = { appId: 730, depotId: 2347770, manifest: '123', mapSha256: 'f'.repeat(64) };
  await writeFile(referencePath, JSON.stringify(external));
  const missingSource = await compareReplayFrame({ ...frame, mapSource }, image, referencePath);
  assert.deepEqual(missingSource.reasons, ['mapSource']);
  await writeFile(referencePath, JSON.stringify({ ...external, mapSource }));
  assert.equal(
    (await compareReplayFrame({ ...frame, mapSource }, image, referencePath)).status,
    'matched-external',
  );
  const translucent = await sharp({
    create: { width: 16, height: 12, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 0.5 } },
  })
    .png()
    .toBuffer();
  await writeFile(join(root, 'raw.png'), translucent);
  const rawResult = await compare({ ...external, png: 'raw.png', sha256: digest(translucent) });
  assert.equal(rawResult.status, 'unverified');
  assert.equal(rawResult.metrics, null);
  assert.equal((await compare({ ...frame, imageSource: 'raw-buffer' })).status, 'unverified');
  assert.equal((await compare({ ...frame, theme: 'light' })).status, 'unverified');
  const wrong = await compare({
    ...frame,
    settings: { quality: 'low' },
    modelSha256: '0'.repeat(64),
  });
  assert.deepEqual(wrong.reasons, ['modelSha256', 'settings']);
});
