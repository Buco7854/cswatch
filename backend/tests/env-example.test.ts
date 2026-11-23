import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { defaultMfaRequiredRoles, flagDefaults, loadConfig, type Flag } from '../src/config.js';

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
  'PORT', // The runtime health check and Compose port mapping use port 8000.
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
  assert.ok(optional.every(({ value }) => value.length > 0));
  assert.equal(new Set(optional.map(({ name }) => name)).size, optional.length);
});

test('documented defaults match the application and Compose defaults', () => {
  const defaults = loadConfig(base);
  for (const { name, value } of optional) {
    if (/^<[^>]+>$/.test(value)) continue; // Operator-supplied example, without a default.
    const flag = name.toLowerCase() as Flag;
    if (Object.hasOwn(flagDefaults, flag)) assert.equal(value, String(flagDefaults[flag]), name);
    else if (name === 'MFA_REQUIRED_ROLES') {
      assert.deepEqual(
        loadConfig({ ...base, [name]: value }).mfaRequiredRoles,
        defaultMfaRequiredRoles,
      );
      assert.equal(defaults.mfaRequiredRoles, undefined);
    } else if (compose.includes('${' + name + ':-'))
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

test('Compose forwards only the configured settings for each service', (t) => {
  const standalone = process.env.CSWATCH_COMPOSE_BIN;
  const command = standalone || 'docker';
  const prefix = standalone ? [] : ['compose'];
  if (spawnSync(command, [...prefix, 'version'], { stdio: 'ignore' }).status !== 0)
    return t.skip('Docker Compose is unavailable.');

  const dir = mkdtempSync(join(tmpdir(), 'cswatch-compose-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const render = (envFile: string) =>
    JSON.parse(
      execFileSync(
        command,
        [...prefix, '--env-file', envFile, '--profile', '*', 'config', '--format', 'json'],
        {
          cwd: root,
          env: { PATH: process.env.PATH, HOME: dir },
          encoding: 'utf8',
        },
      ),
    ).services;
  const defaults = render(join(root, '.env.example'));
  assert.equal(defaults.web.ports[0].host_ip, '0.0.0.0');
  assert.equal(defaults.web.ports[0].published, '8000');
  assert.equal(defaults.web.environment.APP_URL, base.APP_URL);
  assert.equal(defaults.web.environment.MFA_REQUIRED_ROLES ?? undefined, undefined);
  assert.equal(defaults.web.environment.PUBLIC_ACCESS ?? undefined, undefined);

  const examplePath = join(dir, 'deployment.env');
  const privateKeys = [
    'ADMIN_PASSWORD',
    'ADMIN_USERNAME',
    'ADMIN_EMAIL',
    'SMTP_HOST',
    'SMTP_PORT',
    'SMTP_FROM',
    'SMTP_USERNAME',
    'SMTP_PASSWORD',
    'ENCRYPTION_KEY',
    'STEAM_API_KEY',
    'FACEIT_API_KEY',
    'FACEIT_DOWNLOAD_TOKEN',
  ];
  writeFileSync(
    examplePath,
    [
      'APP_URL=https://watch.example.org',
      'USER_STORAGE_MB=4096',
      'HOST_BIND_IP=192.0.2.50',
      'HOST_PORT=8200',
      'TRANSCRIPTION_ENABLED=true',
      'TRANSCRIPTION_MODEL_DIR=/models/test',
      ...privateKeys.map((key) => key + '=scope-fixture'),
    ].join('\n'),
  );
  const configured = render(examplePath);
  assert.equal(configured.web.ports[0].host_ip, '192.0.2.50');
  assert.equal(configured.web.ports[0].target, 8000);
  assert.equal(configured.web.ports[0].published, '8200');
  for (const key of privateKeys) {
    assert.equal(configured.web.environment[key], 'scope-fixture', key);
    for (const name of ['worker', 'transcription', 'assets', 'catalog'])
      assert.ok(!Object.hasOwn(configured[name].environment, key), name + ': ' + key);
  }
  for (const [name, role] of [
    ['worker', 'parse'],
    ['transcription', 'transcription'],
  ]) {
    const service = configured[name];
    assert.equal(service.environment.WORKER_ROLE, role);
    assert.equal(service.environment.USER_STORAGE_MB, '4096');
    assert.equal(service.environment.TRANSCRIPTION_ENABLED, 'true');
    assert.equal(service.environment.TRANSCRIPTION_MODEL_DIR, '/models/test');
    assert.equal(service.network_mode, 'none');
  }
});
