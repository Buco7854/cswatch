import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { ALL_EXTENSIONS } from '../../tools/assets/node_modules/@gltf-transform/extensions/dist/index.js';
import { NodeIO } from '../../tools/assets/node_modules/@gltf-transform/core/dist/index.js';
import { meshoptMapFixture } from '../../tools/assets/fixtures/meshopt-map.mjs';
import { readBoundVisualAudit } from '../../tools/assets/map-graphics-contract.mjs';
import { writeMapTier } from '../../tools/assets/map-tier-output.mjs';
import {
  compareView,
  evaluateLimits,
  coordinateSystem,
  digest,
  externalKind,
  rgbMetrics,
} from './capture-report.mjs';

const sharp = createRequire(new URL('../../tools/assets/package.json', import.meta.url))('sharp');
const color = (rgb) =>
  sharp(Buffer.from(rgb), { raw: { width: 1, height: 1, channels: 3 } })
    .png()
    .toBuffer();
const temp = async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cswatch-graphics-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};
test('external references require a local hash-bound opaque frame, camera, map revision, source and color declarations', async (t) => {
  const dir = await temp(t),
    png = await color([0, 0, 0]),
    white = await color([255, 255, 255]);
  const report = {
    map: 'de_fixture',
    sourceSha256: 'b'.repeat(64),
    assetVersion: 'qa-test',
    coordinateSystem,
    projection: { width: 1, height: 1 },
    colorSpace: 'srgb',
    hudFree: true,
  };
  const view = { index: 0, eye: [0, 0, 1], target: [0, 0, 0] };
  const ref = {
    ...report,
    schemaVersion: 1,
    kind: externalKind,
    provenance: {
      producer: 'CS2',
      version: 'synthetic test',
      renderSettings: 'opaque neutral sRGB test pixel',
      captureSource: 'original synthetic pixel',
    },
    views: [{ ...view, png: 'one.png', sha256: digest(white) }],
  };
  await writeFile(join(dir, 'one.png'), white);
  const compare = (r) => compareView(report, view, png, r, join(dir, 'reference.json'));
  const result = await compare(ref);
  assert.equal(result.status, 'matched-external');
  assert.deepEqual(result.metrics, {
    pixels: 1,
    changedPixels: 1,
    maxError: 255,
    mae: 255,
    rmse: 255,
  });
  for (const patch of [
    { assetVersion: null },
    { coordinateSystem: 'wrong' },
    { provenance: undefined },
    { sourceSha256: undefined },
    { hudFree: false },
    { projection: {} },
    { views: [{ ...ref.views[0], eye: [2, 3, 4] }] },
    { views: [{ ...ref.views[0], png: '../one.png' }] },
    { views: [{ ...ref.views[0], sha256: digest(png) }] },
  ]) {
    const comparison = await compare({ ...ref, ...patch });
    assert.equal(comparison.status, 'unverified');
    assert.equal(comparison.metrics, null);
  }
  assert.equal((await compare({ ...ref, views: [] })).status, 'missing-view');
  await assert.rejects(rgbMetrics(png, white, 2, 2));
  const frame = { comparison: result, performance: {} };
  assert.deepEqual(
    evaluateLimits(report, frame, ref, { maxMae: 0, maxP95Ratio: 1 }).map((c) => c.status),
    ['fail', 'unverified'],
  );
});

test(
  'offline browser writes exact QA views and counters, with independently gated references',
  { timeout: 240000 },
  async (t) => {
    const dir = await temp(t),
      tierDir = join(dir, 'tier'),
      raw = await meshoptMapFixture(),
      io = new NodeIO().registerExtensions(ALL_EXTENSIONS),
      doc = await io.readBinary(raw);
    doc.getRoot().listMaterials()[0].setDoubleSided(true);
    const { manifest } = await writeMapTier({
      document: doc,
      io,
      target: tierDir,
      map: 'de_fixture',
      tier: 'desktop',
      assetVersion: 'synthetic-v1',
      source: { file: 'grid.glb', bytes: raw.length, sha256: digest(raw) },
    });
    const view = {
      feature: 'unknown',
      shader: 'gltf',
      action: 'surface',
      materialName: 'Original QA surface',
      eye: [0, 12, 10],
      target: [0, 0, 0],
    };
    const audit = {
      schemaVersion: 1,
      map: manifest.map,
      tier: manifest.tier,
      assetVersion: manifest.assetVersion,
      sourceSha256: manifest.sourceSha256,
      modelSha256: manifest.outputSha256,
      coordinateSystem,
      materials: ['surface', 'omit_effect'].map((action) => ({
        feature: view.feature,
        shader: view.shader,
        action,
        coverage: action === 'surface' ? 'unknown' : 'omitted',
        primitives: 1,
      })),
      views: [view, { ...view, action: 'omit_effect' }],
    };
    const validateAudit = (data) => {
      const bytes = Buffer.from(JSON.stringify(data));
      return readBoundVisualAudit(bytes, { ...manifest, visualAuditSha256: digest(bytes) });
    };
    assert.throws(() => validateAudit({ ...audit, views: [{ ...view, target: view.eye }] }));
    assert.throws(() => validateAudit({ ...audit, views: Array(25).fill(view) }));
    const auditBytes = Buffer.from(JSON.stringify(audit)),
      auditPath = join(tierDir, 'visual-audit.json');
    await writeFile(auditPath, auditBytes);
    await writeFile(
      join(tierDir, 'manifest.json'),
      JSON.stringify({ ...manifest, visualAuditSha256: digest(auditBytes) }),
    );
    const run = (name, extra = []) =>
      promisify(execFile)(
        process.execPath,
        [
          fileURLToPath(new URL('../capture-graphics.mjs', import.meta.url)),
          '--audit',
          auditPath,
          '--out',
          join(dir, name),
          '--software',
          '--device-id',
          'local-test',
          '--width',
          '128',
          '--height',
          '96',
          '--samples',
          '5',
          ...extra,
        ],
        { timeout: 120000 },
      );
    await run('first');
    const baseline = join(dir, 'first', 'capture.json'),
      read = async (name) => JSON.parse(await readFile(join(dir, name, 'capture.json')));
    const first = await read('first');
    assert.equal(first.views.length, 2);
    assert.equal(first.auditBinding, 'tier-manifest');
    const [surface, omitted] = first.views;
    assert.equal(surface.visibility.status, 'visible');
    assert.ok(surface.visibility.changedPixels > 50);
    assert.equal(omitted.visibility.reason, 'omission-policy');
    assert.ok(surface.performance.work.triangles > 0);
    assert.ok(surface.performance.p95Ms >= surface.performance.p50Ms);
    await run('second', ['--reference', baseline, '--max-mae', '0']);
    const second = await read('second');
    assert.equal(second.verdict, 'pass');
    assert.equal(second.views[0].comparison.metrics.changedPixels, 0);
    const otherDevice = { ...first, renderer: { ...first.renderer, deviceId: 'other-device' } };
    assert.equal(
      evaluateLimits(second, second.views[0], otherDevice, { maxP95Ratio: 1 })[0].status,
      'unverified',
    );
    await assert.rejects(
      run('unmatched', ['--reference', baseline, '--max-mae', '0', '--fov', '65']),
      (err) => err.code === 3,
    );
    const bad = await read('unmatched');
    assert.equal(bad.verdict, 'unverified');
    assert.deepEqual(bad.views[0].comparison.reasons, ['projection']);
    const old = {
      ...first,
      views: first.views.map((v) => ({ ...v, performance: { ...v.performance, p95Ms: 0.000001 } })),
    };
    const slow = join(dir, 'first', 'prior.json');
    await writeFile(slow, JSON.stringify(old));
    await assert.rejects(
      run('regression', ['--reference', slow, '--max-p95-ratio', '1']),
      (err) => err.code === 2,
    );
    assert.equal((await read('regression')).verdict, 'fail');
    await writeFile(auditPath, Buffer.concat([auditBytes, Buffer.from('\n')]));
    await assert.rejects(run('altered'), /Graphics audit hash mismatch/);
    await writeFile(join(tierDir, 'manifest.json'), JSON.stringify(manifest));
    await assert.rejects(run('unbound'), /Graphics audit hash mismatch/);
  },
);
