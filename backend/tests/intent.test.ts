import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeReturnPath } from '../src/security.js';
test('auth return paths preserve local intent and reject external/protocol/API redirects', () => {
  for (const value of [
    'https://evil.example',
    '//evil.example',
    '/\\evil.example',
    '/api/auth/logout',
    '/library\r\nLocation: https://evil.example',
    undefined,
  ])
    assert.equal(safeReturnPath(value), '/library');
  assert.equal(safeReturnPath('/watch/sample?tick=128#notes'), '/watch/sample?tick=128#notes');
  assert.equal(safeReturnPath('/connections'), '/connections');
  assert.equal(safeReturnPath('/account/connections'), '/account/connections');
});
