import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { now, Store } from '../src/db.js';
import { issuePasswordReset } from '../src/recovery.js';
import { createApp } from '../src/server.js';
import {
  browserBindingCookieName,
  browserCookieName,
  digest,
  verifyPassword,
} from '../src/security.js';
import { browserBootstrap } from './fixtures/browser-bootstrap.js';

const attemptReceipt = (code: string) => digest('cswatch/recovery-attempt/v1:' + digest(code));

function assertClaimReceipt(
  response: { claim_id: string | null; recovery_expires_in_ms: number },
  claimId: string,
  maximum = 600_000,
) {
  const { recovery_expires_in_ms: remaining, ...claim } = response;
  assert.deepEqual(claim, { claim_id: claimId });
  assert.ok(Number.isSafeInteger(remaining) && remaining > 0 && remaining <= maximum);
}

function assertCompletionReceipt(response: {
  claim_id: string | null;
  username?: string;
  recovery_expires_in_ms: number;
}) {
  const { recovery_expires_in_ms: remaining, ...identity } = response;
  assert.deepEqual(identity, { claim_id: null, username: 'recovery_test' });
  assert.ok(Number.isSafeInteger(remaining) && remaining > 0 && remaining <= 600_000);
}

test('password recovery is a browser-bound one-time exchange and requires a new sign-in', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cswatch-password-recovery-'));
  const db = new Store(root);
  const config = loadConfig({
    APP_URL: 'http://localhost:8000',
    COOKIE_SECURE: 'false',
    ADMIN_USERNAME: 'recovery_test',
    ADMIN_PASSWORD: 'Initial-recovery-fixture-password',
    DATA_DIR: root,
  });
  const app = await createApp(config, db);
  try {
    const user = db.one('SELECT id FROM users WHERE username=?', 'recovery_test')!;
    const issue = () => db.transaction(() => issuePasswordReset(db, user.id));
    const original = issue();
    const code = issue();
    const issued = db.one('SELECT claim_id FROM password_resets')!.claim_id;
    const caller = await browserBootstrap(app, config);
    const other = await browserBootstrap(app, config);
    const submit = (operation: string, headers: typeof caller, payload: Record<string, string>) =>
      app.inject({ method: 'POST', url: '/api/auth/recover/' + operation, headers, payload });
    assert.equal((await submit('claim', caller, { code: original })).statusCode, 400);
    const redeemed = await submit('claim', caller, { code });
    assert.equal(redeemed.statusCode, 200);
    const { claim_id } = redeemed.json();
    assert.match(claim_id, /^[a-f0-9]{32}$/);
    assert.equal(claim_id, issued);
    const remaining = redeemed.json().recovery_expires_in_ms;
    assertClaimReceipt(redeemed.json(), issued);
    const receipt = async (headers: typeof caller, claim?: string, attempt?: string) =>
      (
        await app.inject({
          url: '/api/auth/recover/status',
          headers: {
            ...headers,
            ...(claim ? { 'x-recovery-claim': claim } : {}),
            ...(attempt ? { 'x-recovery-attempt': attempt } : {}),
          },
        })
      ).json();
    assertClaimReceipt(await receipt(caller, undefined, attemptReceipt(code)), claim_id, remaining);
    assertClaimReceipt(await receipt(caller, claim_id), claim_id, remaining);
    assert.deepEqual(await receipt(caller), { claim_id: null });
    assert.deepEqual(await receipt(other, claim_id), { claim_id: null });
    assert.deepEqual(await receipt(other, undefined, attemptReceipt(code)), { claim_id: null });
    assert.equal((await submit('claim', other, { code })).statusCode, 400);
    const credentials = { claim_id, password: 'Replacement-recovery-fixture-password' };
    // A stale form from another tab must never select the browser's newer account.
    db.run("INSERT INTO users(id,username,created_at) VALUES('second-fixture','second_fixture',0)");
    const next = db.transaction(() => issuePasswordReset(db, 'second-fixture'));
    const nextForm = await submit('claim', caller, { code: next });
    assert.equal(nextForm.statusCode, 200);
    assert.deepEqual(await receipt(caller, undefined, attemptReceipt(code)), { claim_id: null });
    assert.deepEqual(await receipt(caller, claim_id), { claim_id: null });
    assertClaimReceipt(
      await receipt(caller, undefined, attemptReceipt(next)),
      nextForm.json().claim_id,
      nextForm.json().recovery_expires_in_ms,
    );
    assert.equal((await submit('complete', caller, credentials)).statusCode, 400);
    assert.equal(
      db.one("SELECT password_hash FROM users WHERE id='second-fixture'")!.password_hash,
      null,
    );
    // Invalidate the target after this browser claimed it. Completion admission
    // must recheck the current generation before charging or starting a hash.
    db.run("UPDATE users SET auth_generation=auth_generation+1 WHERE id='second-fixture'");
    assert.deepEqual(await receipt(caller, nextForm.json().claim_id), { claim_id: null });
    const previousLimits = db.all('SELECT * FROM rate_limits ORDER BY key');
    assert.equal(
      (await submit('complete', caller, { ...credentials, claim_id: nextForm.json().claim_id }))
        .statusCode,
      400,
    );
    assert.deepEqual(db.all('SELECT * FROM rate_limits ORDER BY key'), previousLimits);
    const reissued = issue();
    const currentForm = await submit('claim', caller, { code: reissued });
    assert.equal(currentForm.statusCode, 200);
    credentials.claim_id = currentForm.json().claim_id;
    const competitors = [
      credentials,
      { ...credentials, password: 'Competing-recovery-fixture-password' },
    ];
    const results = await Promise.all(
      competitors.map((input) => submit('complete', caller, input)),
    );
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 400]);
    assertCompletionReceipt(await receipt(caller, credentials.claim_id));
    assertCompletionReceipt(await receipt(caller, undefined, attemptReceipt(reissued)));
    assert.deepEqual(await receipt(caller), { claim_id: null });
    assert.deepEqual(await receipt(caller, claim_id), { claim_id: null });
    assert.deepEqual(await receipt(other, credentials.claim_id), { claim_id: null });
    assert.deepEqual(await receipt(other, undefined, attemptReceipt(reissued)), { claim_id: null });
    assert.equal(db.one('SELECT count(*) AS n FROM password_resets')!.n, 0);
    const expiringCode = issue();
    assert.deepEqual(await receipt(caller, credentials.claim_id), { claim_id: null });
    const expiringClaim = await submit('claim', caller, { code: expiringCode });
    assert.equal(expiringClaim.statusCode, 200);
    const expiredId = expiringClaim.json().claim_id;
    db.run('UPDATE password_resets SET expires_at=? WHERE claim_id=?', now() + 5, expiredId);
    assertClaimReceipt(await receipt(caller, expiredId), expiredId, 5_000);
    db.run('UPDATE password_resets SET expires_at=? WHERE claim_id=?', now(), expiredId);
    assert.deepEqual(await receipt(caller, expiredId), { claim_id: null });
    assert.deepEqual(await receipt(caller, undefined, attemptReceipt(expiringCode)), {
      claim_id: null,
    });
    assert.equal(db.one('SELECT count(*) AS n FROM sessions WHERE user_id=?', user.id)!.n, 0);
    assert.ok(
      await verifyPassword(
        db.one('SELECT password_hash FROM users WHERE id=?', user.id)!.password_hash,
        competitors[results.findIndex((result) => result.statusCode === 200)].password,
      ),
    );
    assert.equal(
      db.one("SELECT count(*) AS n FROM audit WHERE action='account.password_recovered'")!.n,
      1,
    );
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const operation of ['claim', 'complete'] as const)
  test(`password recovery ${operation} retains its full lifetime through an anonymous rollover`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'cswatch-recovery-rollover-'));
    const db = new Store(root);
    const config = loadConfig({
      APP_URL: 'http://localhost:8000',
      COOKIE_SECURE: 'false',
      ADMIN_USERNAME: 'recovery_test',
      ADMIN_PASSWORD: 'Initial-recovery-fixture-password',
      DATA_DIR: root,
    });
    const app = await createApp(config, db);
    try {
      const browser = await browserBootstrap(app, config);
      const issue = () =>
        db.transaction(() =>
          issuePasswordReset(db, db.one("SELECT id FROM users WHERE username='recovery_test'")!.id),
        );
      const post = (name: string, headers: typeof browser, payload: Record<string, unknown>) =>
        app.inject({ method: 'POST', url: '/api/auth/' + name, headers, payload });
      const read = async (headers: typeof browser, claim: string) =>
        (
          await app.inject({
            url: '/api/auth/recover/status',
            headers: {
              ...headers,
              [operation === 'claim' ? 'x-recovery-attempt' : 'x-recovery-claim']: claim,
            },
          })
        ).json();

      const code = issue();
      const reset = db.one('SELECT claim_id,expires_at FROM password_resets')!;
      const claimed =
        operation === 'complete' ? await post('recover/claim', browser, { code }) : null;
      if (claimed) assert.equal(claimed.statusCode, 200, claimed.body);
      db.run(
        "UPDATE sessions SET created_at=?,expires_at=? WHERE stage='anonymous'",
        now() - 1300,
        now() + 500,
      );
      const startedAt = now();
      const response = claimed
        ? await post('recover/complete', browser, {
            claim_id: claimed.json().claim_id,
            password: 'Replacement-recovery-fixture-password',
          })
        : await post('recover/claim', browser, { code });
      assert.equal(response.statusCode, 200, response.body);
      const claimId = (claimed ?? response).json().claim_id;
      assert.equal(claimId, reset.claim_id);
      const statusReceipt = operation === 'claim' ? attemptReceipt(code) : claimId;
      const replacement = response.cookies.find(({ name }) => name === browserCookieName(config));
      assert.ok(replacement);
      assert.equal((await post('recover/claim', browser, { code })).statusCode, 403);
      assert.equal(
        (await app.inject({ url: '/api/auth/recover/status', headers: browser })).statusCode,
        401,
      );

      async function assertReceipt(headers: typeof browser) {
        const result = await read(headers, statusReceipt);
        if (operation === 'claim')
          assertClaimReceipt(result, claimId, response.json().recovery_expires_in_ms);
        else assertCompletionReceipt(result);
      }
      const binding = browser.cookie
        .split('; ')
        .find((cookie) => cookie.startsWith(browserBindingCookieName(config) + '='))!;
      const bindingOnly = await browserBootstrap(app, config, binding);
      assert.deepEqual(await read(bindingOnly, statusReceipt), { claim_id: null });
      assert.notEqual(bindingOnly['x-csrf-token'], browser['x-csrf-token']);
      const previousOnly = browser.cookie
        .split('; ')
        .find((cookie) => cookie.startsWith(browserCookieName(config) + '='))!;
      const bearerOnly = await browserBootstrap(app, config, previousOnly);
      assert.deepEqual(await read(bearerOnly, statusReceipt), { claim_id: null });
      const delivery = await browserBootstrap(app, config, browser.cookie);
      assert.ok(delivery.cookie.split('; ').includes(replacement.name + '=' + replacement.value));
      await assertReceipt(delivery);
      if (operation === 'claim') {
        const retry = await post('recover/claim', delivery, { code });
        assert.equal(retry.statusCode, 200, retry.body);
        assertClaimReceipt(retry.json(), claimId, response.json().recovery_expires_in_ms);
      }
      const repeated = await browserBootstrap(app, config, browser.cookie);
      assert.deepEqual(repeated, delivery);

      const expiry = db.one(
        operation === 'claim'
          ? 'SELECT expires_at FROM password_resets WHERE claim_id=?'
          : 'SELECT expires_at FROM recovery_receipts WHERE browser_id=(SELECT id FROM sessions WHERE csrf=?)',
        operation === 'claim' ? claimId : delivery['x-csrf-token'],
      )!.expires_at;
      if (operation === 'claim') assert.equal(expiry, reset.expires_at);
      else assert.ok(expiry >= startedAt + 600);
      assert.ok(
        db.one('SELECT expires_at FROM sessions WHERE csrf=?', delivery['x-csrf-token'])!
          .expires_at >= expiry,
      );

      const signOut = await post('logout', delivery, { preserve_anonymous_operations: true });
      assert.equal(signOut.statusCode, 200, signOut.body);
      assert.equal(signOut.headers['set-cookie'], undefined);
      const confirmed = { ...delivery, 'x-csrf-token': signOut.json().session.csrf };
      assert.notEqual(confirmed['x-csrf-token'], delivery['x-csrf-token']);
      await assertReceipt(confirmed);
      assert.equal((await post('recover/claim', delivery, { code })).statusCode, 403);

      const explicit = await post('logout', confirmed, {});
      assert.equal(explicit.statusCode, 200, explicit.body);
      const unrelated = await browserBootstrap(app, config, browser.cookie);
      assert.deepEqual(await read(unrelated, statusReceipt), { claim_id: null });
    } finally {
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

test('a recovery transaction rolls back if its anonymous grant expires before renewal', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cswatch-recovery-expiry-'));
  const db = new Store(root);
  const config = loadConfig({
    APP_URL: 'http://localhost:8000',
    COOKIE_SECURE: 'false',
    ADMIN_USERNAME: 'expiry_test',
    ADMIN_PASSWORD: 'Initial-recovery-fixture-password',
    DATA_DIR: root,
  });
  const app = await createApp(config, db);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  try {
    const user = db.one('SELECT id FROM users WHERE username=?', 'expiry_test')!;
    const browser = await browserBootstrap(app, config);
    const code = db.transaction(() => issuePasswordReset(db, user.id));
    db.run(
      "UPDATE sessions SET created_at=?,expires_at=? WHERE stage='anonymous'",
      now() - 1799,
      now() + 1,
    );
    const run = db.run.bind(db);
    db.run = (sql, ...args) => {
      const result = run(sql, ...args);
      if (sql.startsWith('UPDATE password_resets SET claimed_by=')) t.mock.timers.tick(1000);
      return result;
    };
    const result = await app.inject({
      method: 'POST',
      url: '/api/auth/recover/claim',
      headers: browser,
      payload: { code },
    });
    assert.equal(result.statusCode, 401);
    assert.equal(
      db.one('SELECT claimed_by FROM password_resets WHERE user_id=?', user.id)!.claimed_by,
      null,
    );
    assert.equal(result.headers['set-cookie'], undefined);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
