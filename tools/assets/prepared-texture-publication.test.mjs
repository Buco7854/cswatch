import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, unlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import sharp from 'sharp';
import { meshoptMapFixture } from './fixtures/meshopt-map.mjs';
import { writeMapTier } from './map-tier-output.mjs';
import { validatePreparedMap } from './prepared-map-publication.mjs';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cswatch-texture-publish-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const map = 'de_fixture',
    version = 'synthetic-fixture',
    raw = await meshoptMapFixture(),
    io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  for (const tier of ['desktop', 'mobile'])
    await writeMapTier({
      document: await io.readBinary(raw),
      io,
      target: join(root, map, tier),
      map,
      tier,
      assetVersion: version,
      source: { file: 'original-qa.glb', sha256: hash(raw), bytes: raw.length },
      s2v: 'original QA',
    });
  const png = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#8090a0' } })
      .png()
      .toBuffer(),
    overview = join(root, 'overviews', map),
    environment = join(root, 'environments', map);
  await mkdir(overview, { recursive: true });
  await mkdir(environment, { recursive: true });
  await writeFile(join(overview, 'overview.png'), png);
  await writeFile(
    join(overview, 'overview.json'),
    JSON.stringify({
      schemaVersion: 1,
      map,
      assetVersion: version,
      origin: { x: 0, y: 0 },
      scale: 1,
      referenceSize: 1024,
      imageSha256: hash(png),
    }),
  );
  await writeFile(join(overview, 'provenance.json'), '{}');
  const faces = {};
  for (const face of ['px', 'nx', 'py', 'ny', 'pz', 'nz']) {
    await writeFile(join(environment, face + '.png'), png);
    faces[face] = hash(png);
  }
  await writeFile(
    join(environment, 'environment.json'),
    JSON.stringify({
      schemaVersion: 2,
      map,
      assetVersion: version,
      source: 'Original QA pixels',
      landscape: true,
      sky: { brightness: 1, faces },
    }),
  );
  await writeFile(join(environment, 'provenance.json'), '{}');
  return { root, map, version };
}

test('publication includes both bounded SHA-bound texture plans beside actual valid Meshopt output', async (t) => {
  const s = await fixture(t),
    files = await validatePreparedMap(s.root, s.map, s.version);
  for (const tier of ['desktop', 'mobile']) {
    const plan = await readFile(join(s.root, s.map, tier, 'texture-plan.json'));
    assert.ok(
      files.some(
        (file) => file.path === `${s.map}/${tier}/texture-plan.json` && file.sha256 === hash(plan),
      ),
    );
  }
});
test('missing, mismatched, oversized and internally overflowing texture plans cannot publish', async (t) => {
  const s = await fixture(t),
    dir = join(s.root, s.map, 'desktop'),
    planPath = join(dir, 'texture-plan.json'),
    manifestPath = join(dir, 'manifest.json'),
    original = await readFile(planPath),
    manifest = await readFile(manifestPath);
  await unlink(planPath);
  await assert.rejects(validatePreparedMap(s.root, s.map, s.version));
  await writeFile(planPath, Buffer.concat([original, Buffer.from(' ')]));
  await assert.rejects(validatePreparedMap(s.root, s.map, s.version), /binding/);
  await writeFile(planPath, Buffer.alloc(4 * 1024 ** 2 + 1));
  await assert.rejects(validatePreparedMap(s.root, s.map, s.version), /bounded/);
  const data = JSON.parse(original),
    meta = JSON.parse(manifest);
  data.policy.budgetBytes = 1;
  data.summary.budgetBytes = 1;
  meta.textureBudget.budgetBytes = 1;
  const changed = Buffer.from(JSON.stringify(data));
  meta.textureBudget.planSha256 = hash(changed);
  await writeFile(planPath, changed);
  await writeFile(manifestPath, JSON.stringify(meta));
  await assert.rejects(validatePreparedMap(s.root, s.map, s.version), /overflows/);
  await writeFile(planPath, original);
  await writeFile(manifestPath, manifest);
  assert.ok((await validatePreparedMap(s.root, s.map, s.version)).length > 0);
});
test('publication requires texture-plan and model bindings in both tiers', async (t) => {
  const s = await fixture(t);
  const path = join(s.root, s.map, 'desktop', 'manifest.json');
  const { textureBudget, outputSha256, ...rest } = JSON.parse(await readFile(path));
  await writeFile(path, JSON.stringify({ ...rest, textureBudget }));
  await assert.rejects(validatePreparedMap(s.root, s.map, s.version), /model differs/);
  await writeFile(path, JSON.stringify({ ...rest, outputSha256 }));
  await assert.rejects(validatePreparedMap(s.root, s.map, s.version), /binding/);
  await unlink(join(s.root, s.map, 'desktop', 'texture-plan.json'));
  await assert.rejects(validatePreparedMap(s.root, s.map, s.version));
});

test('graphics audit publication binds source, model, tier and camera plan', async (t) => {
  const s = await fixture(t),
    dir = join(s.root, s.map, 'desktop'),
    auditPath = join(dir, 'visual-audit.json'),
    manifestPath = join(dir, 'manifest.json');
  const bytes = await readFile(auditPath),
    manifest = JSON.parse(await readFile(manifestPath));
  await unlink(auditPath);
  await assert.rejects(validatePreparedMap(s.root, s.map, s.version));
  await writeFile(auditPath, Buffer.concat([bytes, Buffer.from(' ')]));
  await assert.rejects(validatePreparedMap(s.root, s.map, s.version), /audit hash/i);
  const changed = Buffer.from(
    JSON.stringify({ ...JSON.parse(bytes), sourceSha256: '0'.repeat(64) }),
  );
  await writeFile(auditPath, changed);
  await writeFile(manifestPath, JSON.stringify({ ...manifest, visualAuditSha256: hash(changed) }));
  await assert.rejects(validatePreparedMap(s.root, s.map, s.version), /does not match/i);
});
