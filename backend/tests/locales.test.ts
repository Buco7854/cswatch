import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const en = JSON.parse(
    readFileSync(new URL('../../frontend/src/locales/en.json', import.meta.url), 'utf8'),
  ),
  fr = JSON.parse(
    readFileSync(new URL('../../frontend/src/locales/fr.json', import.meta.url), 'utf8'),
  );
test('English and French catalogs have parity and preserve interpolation placeholders', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(fr).sort());
  for (const key of Object.keys(en)) {
    assert.equal(typeof fr[key], 'string', key);
    assert.ok(fr[key].trim().length, key);
    const vars = (s: string) => [...s.matchAll(/{{\s*(\w+)\s*}}/g)].map((m) => m[1]).sort();
    assert.deepEqual(vars(en[key]), vars(fr[key]), key);
  }
});
