import test from 'node:test';
import assert from 'node:assert/strict';
import { authPath, authReturnPath } from '../../frontend/src/auth-navigation.js';

test('auth route intent retains bounded local application paths and rejects external, recursive and server destinations', () => {
  for (const path of [
    '/',
    '/library?upload=1',
    '/watch/private_demo-1?t=64#round',
    '/account/connections',
    '/admin',
  ])
    assert.equal(authReturnPath(path), path);
  for (const path of [
    undefined,
    '//untrusted.invalid',
    'https://untrusted.invalid',
    '/\\untrusted.invalid',
    '/%2f%2funtrusted.invalid',
    '/api/auth/logout',
    '/setup',
    '/login?returnTo=/account',
    '/register',
    '/watch/a\n',
    '/library?' + 'x'.repeat(1024),
  ])
    assert.equal(authReturnPath(path), '/library');
  assert.equal(
    authPath('register', '/library?upload=1'),
    '/register?returnTo=%2Flibrary%3Fupload%3D1',
  );
  assert.equal(authPath('login', 'https://untrusted.invalid'), '/login?returnTo=%2Flibrary');
});
