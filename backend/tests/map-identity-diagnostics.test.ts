import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseMapIdentity } from '../src/map-catalog.js';

const identity = {
  map: 'de_mirage',
  buildNum: 9842,
  patchVersion: 13984,
  demoVersionGuid: '8e9d71ab-04a1-4c01-bb61-acfede27c046',
  addonPresence: 'none',
};
const approval = {
  identity,
  source: {
    appId: 730,
    depotId: 2347770,
    manifest: '18014398509481985',
    mapSha256: 'a'.repeat(64),
  },
};
const catalog = { schemaVersion: 1, entries: [approval] };

test('map diagnostics distinguish absent, incomplete and conflicting evidence without inventing values', () => {
  const absent = diagnoseMapIdentity(undefined, catalog);
  assert.equal(absent.recordedIdentity, null);
  assert.equal(absent.resolution, 'unknown');
  assert.equal(absent.selected, null);
  assert.ok(absent.issues.includes('identity_missing'));
  assert.ok(absent.missingFields.includes('buildNum'));
  const partial = diagnoseMapIdentity({ map: 'de_mirage', patchVersion: 13984 }, catalog);
  assert.deepEqual(partial.recordedIdentity, { map: 'de_mirage', patchVersion: 13984 });
  assert.equal(partial.resolution, 'unknown');
  assert.ok(partial.missingFields.includes('demoVersionGuid'));
  const conflict = diagnoseMapIdentity({ ...identity, conflicted: true }, catalog);
  assert.equal(conflict.selected, null);
  assert.equal(conflict.catalog.distinctMatchingApprovals, 0);
  assert.ok(conflict.issues.includes('recorded_fields_conflict'));
});

test('a unique approved tuple reports operator provenance without asserting map bytes or source availability', () => {
  const report = diagnoseMapIdentity(identity, catalog, 'de_mirage');
  assert.equal(report.resolution, 'approved');
  assert.equal(report.catalog.distinctMatchingApprovals, 1);
  assert.equal(report.selected?.source.manifest, '18014398509481985');
  assert.deepEqual(report.missingFields, []);
  assert.deepEqual(report.issues, []);
  assert.equal(report.evidence.selection, 'operator-approval');
  assert.equal(report.evidence.originalMapContent, 'not-verified');
  assert.equal(report.evidence.sourceAvailability, 'not-checked');
});

test('same name and build do not choose the latest source, while exact duplicate approvals deduplicate', () => {
  const duplicate = diagnoseMapIdentity(identity, {
    schemaVersion: 1,
    entries: [approval, structuredClone(approval)],
  });
  assert.equal(duplicate.resolution, 'approved');
  assert.equal(duplicate.candidates.length, 1);
  const later = {
    ...approval,
    source: { ...approval.source, manifest: '18014398509481986', mapSha256: 'b'.repeat(64) },
  };
  const report = diagnoseMapIdentity(identity, { schemaVersion: 1, entries: [approval, later] });
  assert.equal(report.resolution, 'ambiguous');
  assert.equal(report.selected, null);
  assert.equal(report.candidates.length, 2);
  assert.ok(report.issues.includes('multiple_approved_sources'));
  assert.notEqual(report.candidates[0].packId, report.candidates[1].packId);
});

test('recording-map mismatch, addons and incomplete identity cannot expose approval candidates', () => {
  const mismatch = diagnoseMapIdentity(identity, catalog, 'de_dust2');
  assert.equal(mismatch.resolution, 'unknown');
  assert.ok(mismatch.issues.includes('replay_map_mismatch'));
  assert.equal(mismatch.candidates.length, 0);
  const addon = diagnoseMapIdentity({ ...identity, addonPresence: 'present' }, catalog);
  assert.equal(addon.resolution, 'addon');
  assert.ok(addon.issues.includes('addon_content'));
  assert.equal(addon.selected, null);
  assert.equal(addon.candidates.length, 0);
  const incompatible = diagnoseMapIdentity({ ...identity, buildNum: 9843 }, catalog);
  assert.equal(incompatible.resolution, 'unmapped');
  assert.ok(incompatible.issues.includes('no_approved_source'));
  assert.equal(incompatible.selected, null);
});

test('invalid metadata/catalog remain separate from missing approval, and optional catalog is explicitly unevaluated', () => {
  const malformed = diagnoseMapIdentity({ ...identity, buildNum: '9842' }, catalog);
  assert.equal(malformed.recordedIdentity, null);
  assert.ok(malformed.issues.includes('identity_invalid'));
  assert.equal(malformed.selected, null);
  const badCatalog = diagnoseMapIdentity(identity, {
    schemaVersion: 1,
    entries: [{ ...approval, source: { ...approval.source, url: 'https://invalid.test' } }],
  });
  assert.equal(badCatalog.resolution, 'catalog_invalid');
  assert.equal(badCatalog.catalog.status, 'invalid');
  assert.equal(badCatalog.candidates.length, 0);
  const noCatalog = diagnoseMapIdentity(identity);
  assert.equal(noCatalog.resolution, 'not_evaluated');
  assert.equal(noCatalog.catalog.status, 'not_provided');
  assert.equal(noCatalog.selected, null);
});
