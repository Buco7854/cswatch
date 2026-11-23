import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { flagDefaults, loadConfig, type Flag } from '../src/config.js';

const root = join(import.meta.dirname, '../..');
const example = readFileSync(join(root, '.env.example'), 'utf8');
const compose = readFileSync(join(root, 'compose.yaml'), 'utf8');
const optional = [...example.matchAll(/^# ([A-Z][A-Z0-9_]+)=(.*)$/gm)].map(([, name, value]) => ({
  name,
  value,
}));
const base = { APP_URL: 'https://demo.example.com' };
/** Fixed by the image, Compose or a confined child process. */
const internal = new Set([
  'DATA_DIR',
  'FRONTEND_DIR',
  'MAP_ASSETS_DIR',
  'MAP_CATALOG_FILE',
  'MAP_JOBS_DIR',
  'WORKER_ROLE',
]);

test('.env.example sets only what is required and comments every default', () => {
  assert.deepEqual(
    [...example.matchAll(/^([A-Z][A-Z0-9_]+)=/gm)].map(([, name]) => name),
    ['APP_URL'],
  );
  assert.equal(new Set(optional.map(({ name }) => name)).size, optional.length);
});

test('every commented value in .env.example is the real default', () => {
  const defaults = loadConfig(base);
  for (const { name, value } of optional) {
    const flag = name.toLowerCase() as Flag;
    if (Object.hasOwn(flagDefaults, flag)) assert.equal(value, String(flagDefaults[flag]), name);
    else if (compose.includes('${' + name + ':-'))
      assert.ok(compose.includes('${' + name + ':-' + value + '}'), name);
    else assert.deepEqual(loadConfig({ ...base, [name]: value }), defaults, name);
  }
  assert.ok(
    Object.keys(flagDefaults).every((flag) =>
      optional.some(({ name }) => name === flag.toUpperCase()),
    ),
  );
});

test('every setting the application reads is documented in .env.example', () => {
  const source = readFileSync(join(root, 'backend/src/config.ts'), 'utf8');
  const read = new Set([...source.matchAll(/\benv\.([A-Z][A-Z0-9_]+)/g)].map(([, name]) => name));
  for (const file of readdirSync(join(root, 'backend/src')))
    for (const [, name] of readFileSync(join(root, 'backend/src', file), 'utf8').matchAll(
      /process\.env\.([A-Z][A-Z0-9_]+)/g,
    ))
      read.add(name);
  const listed = new Set(['APP_URL', ...optional.map(({ name }) => name)]);
  assert.deepEqual(
    [...read].filter(
      (name) => !listed.has(name) && !internal.has(name) && !name.startsWith('CSWATCH_'),
    ),
    [],
  );
  assert.deepEqual(
    [...listed].filter((name) => !read.has(name) && !compose.includes('${' + name + ':-')),
    [],
  );
});
