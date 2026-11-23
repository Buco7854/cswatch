import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { Store, now } from '../src/db.js';
import { openEncryptionKey, seal, totpBinding } from '../src/encryption-key.js';
import { createApp } from '../src/server.js';
import { digest, sessionCookieName } from '../src/security.js';
import { browserBootstrap } from './fixtures/browser-bootstrap.js';
import { codeFor } from './fixtures/totp-code.js';
import { virtualPasskey } from './fixtures/virtual-passkey.js';

const passkeyEnrollment = '/api/auth/factors/passkeys/';
const newAttempt = () => ({ attempt: randomBytes(16).toString('hex') });

async function fixture(settings: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cswatch-authenticator-'));
  const config = loadConfig({
    APP_URL: 'http://localhost:8000',
    COOKIE_SECURE: 'false',
    ADMIN_USERNAME: 'otp_fixture',
    ADMIN_PASSWORD: 'Original-fixture-password',
    DATA_DIR: root,
    ...settings,
  });
  const db = new Store(root),
    app = await createApp(config, db);
  const post = (
    url: string,
    headers: Record<string, string>,
    payload: Record<string, unknown> = {},
    remoteAddress?: string,
  ) => app.inject({ method: 'POST', url, headers, payload, remoteAddress });
  const bootstrap = () => browserBootstrap(app, config);
  const login = async () =>
    post('/api/auth/login', await bootstrap(), {
      username: config.adminUsername,
      password: config.adminPassword,
    });
  const headers = (r: Awaited<ReturnType<typeof login>>) => {
    assert.equal(r.statusCode, 200, r.body);
    const cookie = r.cookies.find((c) => c.name === sessionCookieName(config))!;
    return {
      origin: config.appUrl,
      host: config.host,
      cookie: cookie.name + '=' + cookie.value,
      'x-csrf-token': r.json().session.csrf as string,
    };
  };
  return {
    app,
    post,
    bootstrap,
    login,
    headers,
    db,
    config,
    close: async () => {
      await app.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('an administrator enrolls an authenticator and spends TOTP and recovery codes only once across browsers', async (t) => {
  const fixtureTime = Date.UTC(2026, 0, 1, 12);
  const elapsedSince = performance.now();
  let offset = 0;
  t.mock.method(
    Date,
    'now',
    () => fixtureTime + offset + Math.floor(performance.now() - elapsedSince),
  );
  const { post, login, headers, db, close } = await fixture();
  try {
    const enrolled = await login();
    assert.equal(enrolled.json().session.stage, 'enroll');
    const source = headers(enrolled);
    const [start, otherTab] = await Promise.all([
      post('/api/auth/factors/totp/options', source),
      post('/api/auth/factors/totp/options', source),
    ]);
    assert.equal(start.statusCode, 200, start.body);
    assert.equal(otherTab.statusCode, 200, otherTab.body);
    const { secret, uri, enrollment, expires_in_ms } = start.json();
    assert.equal(otherTab.json().secret, secret);
    assert.equal(otherTab.json().uri, uri);
    assert.equal(otherTab.json().enrollment, enrollment);
    assert.equal(db.one('SELECT count(*) AS n FROM auth_totp_enrollments')!.n, 1);
    assert.ok(expires_in_ms > 0 && expires_in_ms <= 600_000);
    const step = Math.floor(now() / 30);
    const write = db.run.bind(db);
    db.run = (sql, ...args) => {
      if (sql.startsWith('DELETE FROM auth_otp_pacing WHERE session_hash='))
        assert.ok(
          db.db.isTransaction,
          'successful verification releases its pacing row in the proof transaction',
        );
      return write(sql, ...args);
    };
    const finished = await post('/api/auth/factors/totp/verify', source, {
      code: codeFor(secret, step),
      enrollment,
    });
    assert.equal(finished.statusCode, 200, finished.body);
    assert.equal(finished.json().session.stage, 'full');
    assert.equal(finished.json().recovery_codes.length, 10);
    const recovered = finished.json().recovery_codes[0];
    const compete = async (method: 'totp' | 'recovery', code: string) => {
      const challenges = await Promise.all([login(), login()]);
      for (const challenge of challenges) assert.equal(challenge.json().session.stage, 'challenge');
      const completions = await Promise.all(
        challenges.map((challenge, i) =>
          post(`/api/auth/mfa/${method}`, headers(challenge), { code }, `192.0.2.${i + 1}`),
        ),
      );
      assert.deepEqual(completions.map((r) => r.statusCode).sort(), [200, 401]);
      return completions.find((r) => r.statusCode === 200)!;
    };
    offset = 30_000;
    const unusedStep = Math.max(step + 1, db.one('SELECT last_step FROM auth_totp')!.last_step + 1);
    const complete = await compete('totp', codeFor(secret, unusedStep));
    assert.equal(complete.json().session.proof_kind, 'totp');
    const accountLimit = digest(
      'factor-code-account:' + db.one('SELECT user_id FROM auth_totp')!.user_id,
    );
    db.run(
      'INSERT INTO rate_limits VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET count=excluded.count,expires_at=excluded.expires_at',
      accountLimit,
      12,
      now() + 10,
    );
    const limited = await post(
      '/api/auth/mfa/totp',
      headers(await login()),
      { code: codeFor(secret, unusedStep) },
      '198.51.100.10',
    );
    assert.equal(limited.statusCode, 429);
    assert.equal(db.one('SELECT count FROM rate_limits WHERE key=?', accountLimit)!.count, 12);
    const once = await compete('recovery', recovered);
    assert.equal(once.json().session.stage, 'full');
    assert.equal(once.json().session.proof_at, null);
    assert.equal(
      (await post('/api/auth/factors/recovery/regenerate', headers(once))).statusCode,
      403,
    );
    assert.equal(db.one('SELECT count(*) AS n FROM auth_recovery_codes')!.n, 9);
    db.run(
      'INSERT OR REPLACE INTO rate_limits VALUES(?,?,?)',
      digest('backup-code-account:' + db.one('SELECT user_id FROM auth_totp')!.user_id),
      12,
      now() + 60,
    );
    const unaffected = await post(
      '/api/auth/mfa/recovery',
      headers(await login()),
      { code: finished.json().recovery_codes[1] },
      '198.51.100.11',
    );
    assert.equal(unaffected.statusCode, 200, unaffected.body);
  } finally {
    await close();
  }
});

test('missing factor ceremonies leave admission budgets unchanged and eligible failures are charged', async (t) => {
  const start = Date.UTC(2026, 0, 1, 12);
  const elapsedSince = performance.now();
  t.mock.method(Date, 'now', () => start + Math.floor(performance.now() - elapsedSince));
  const { db, post, bootstrap, headers, login, close } = await fixture();
  try {
    const browser = await bootstrap();
    const account = headers(await login());
    const limits = () => db.all('SELECT key,count,expires_at FROM rate_limits ORDER BY key');
    const count = (scope: string) =>
      db.one('SELECT count FROM rate_limits WHERE key=?', digest(`${scope}:instance`))?.count;
    const credential = {
      id: 'AQ',
      rawId: 'AQ',
      type: 'public-key',
      clientExtensionResults: {},
    };
    const data = { clientDataJSON: Buffer.from('{}').toString('base64url') };
    const assertion = {
      response: {
        ...credential,
        response: { ...data, authenticatorData: 'AQ', signature: 'AQ' },
      },
    };
    const attempt = newAttempt();
    const registration = {
      ...attempt,
      name: 'Fixture passkey',
      response: { ...credential, response: { ...data, attestationObject: 'oA' } },
    };
    const initial = limits();
    for (const response of [
      await post('/api/auth/passkeys/login/verify', browser, assertion),
      await post(passkeyEnrollment + 'verify', account, registration),
      await post(passkeyEnrollment + 'confirm', account, { ...attempt, ...assertion }),
      await post('/api/auth/factors/totp/verify', account, {
        code: '000000',
        enrollment: '0'.repeat(64),
      }),
    ]) {
      assert.equal(response.statusCode, 400, response.body);
      assert.equal(response.json().detail, 'Security verification expired. Start again.');
    }
    assert.deepEqual(limits(), initial);

    const assertionOptions = await post('/api/auth/passkeys/login/options', browser);
    assert.equal(assertionOptions.statusCode, 200, assertionOptions.body);
    const failedAssertion = await post('/api/auth/passkeys/login/verify', browser, assertion);
    assert.equal(failedAssertion.statusCode, 401, failedAssertion.body);
    assert.equal(count('passkey-login-verify-instance'), 1);

    const registrationOptions = await post(passkeyEnrollment + 'options', account, attempt);
    assert.equal(registrationOptions.statusCode, 200, registrationOptions.body);
    const failedRegistration = await post(passkeyEnrollment + 'verify', account, registration);
    assert.equal(failedRegistration.statusCode, 401, failedRegistration.body);
    assert.equal(count('passkey-enrollment-verify-instance'), 1);

    const totpOptions = await post('/api/auth/factors/totp/options', account);
    assert.equal(totpOptions.statusCode, 200, totpOptions.body);
    const { secret, enrollment } = totpOptions.json();
    const step = Math.floor(now() / 30);
    const currentCodes = [-1, 0, 1].map((offset) => codeFor(secret, step + offset));
    const wrong = ['000000', '100000', '200000', '300000'].find(
      (code) => !currentCodes.includes(code),
    )!;
    const failedEnrollment = await post('/api/auth/factors/totp/verify', account, {
      code: wrong,
      enrollment,
    });
    assert.equal(failedEnrollment.statusCode, 401, failedEnrollment.body);
    assert.equal(count('factor-code-instance-enroll'), 1);
  } finally {
    await close();
  }
});

test('authenticator setup in a full session expires with its original recent proof', async (t) => {
  const fixtureTime = Date.UTC(2026, 0, 1, 12);
  const elapsedSince = performance.now();
  let offset = 0;
  t.mock.method(
    Date,
    'now',
    () => fixtureTime + offset + Math.floor(performance.now() - elapsedSince),
  );
  const { post, login, headers, db, close } = await fixture({ MFA_REQUIRED_ROLES: 'none' });
  try {
    const signedIn = await login();
    const { stage, proof_at, expires_at } = signedIn.json().session;
    assert.equal(stage, 'full');
    const proofDeadline = proof_at + 300;
    assert.ok(expires_at > proofDeadline);
    const source = headers(signedIn);
    offset += proofDeadline * 1000 - Date.now() - 20_000;
    const start = await post('/api/auth/factors/totp/options', source);
    assert.equal(start.statusCode, 200, start.body);
    const pending = start.json();
    assert.ok(pending.expires_in_ms > 0 && pending.expires_in_ms <= 20_000);
    assert.equal(db.one('SELECT expires_at FROM auth_totp_enrollments')!.expires_at, proofDeadline);

    offset += 5_000;
    const repeated = await post('/api/auth/factors/totp/options', source);
    assert.equal(repeated.statusCode, 200, repeated.body);
    assert.equal(repeated.json().enrollment, pending.enrollment);
    assert.ok(repeated.json().expires_in_ms > 0 && repeated.json().expires_in_ms <= 15_000);
    assert.equal(db.one('SELECT expires_at FROM auth_totp_enrollments')!.expires_at, proofDeadline);

    offset += proofDeadline * 1000 - Date.now() + 1;
    const expired = await post('/api/auth/factors/totp/verify', source, {
      code: codeFor(pending.secret, Math.floor(now() / 30)),
      enrollment: pending.enrollment,
    });
    assert.equal(expired.statusCode, 403, expired.body);
    assert.equal((await post('/api/auth/factors/totp/options', source)).statusCode, 403);
    assert.equal(
      db.one('SELECT count(*) AS n FROM auth_totp_enrollments WHERE expires_at>?', now())!.n,
      0,
    );
    assert.equal(db.one('SELECT count(*) AS n FROM auth_totp')!.n, 0);
  } finally {
    await close();
  }
});

test('parallel passkey setup preserves one ceremony per grant and only one activation rotates the account', async (t) => {
  let clock = Date.UTC(2026, 0, 1, 12);
  t.mock.method(Date, 'now', () => clock);
  const { post, login, headers, db, config, close } = await fixture();
  try {
    const source = headers(await login());
    const otherGrant = headers(await login());
    const tabs = [newAttempt(), newAttempt()];
    const starts = await Promise.all(
      tabs.map((attempt) => post(passkeyEnrollment + 'options', source, attempt)),
    );
    assert.deepEqual(starts.map((r) => r.statusCode).sort(), [200, 409]);
    const winner = starts.findIndex((r) => r.statusCode === 200);
    const attempt = tabs[winner];
    const competingTab = tabs[1 - winner];
    const { phase, options: creation, expires_in_ms } = starts[winner].json();
    assert.equal(phase, 'create');
    assert.equal(creation.timeout, 90_000);
    assert.equal(expires_in_ms, 120_000);
    const stored = db.one('SELECT * FROM auth_passkey_enrollments')!;
    assert.notEqual(stored.attempt_hash, attempt.attempt);
    assert.notEqual(stored.nonce, creation.challenge);
    assert.equal(stored.challenge_hash, digest(creation.challenge));
    assert.equal(stored.expires_at, now() + 120);

    clock += 85_000;
    const redelivery = await post(passkeyEnrollment + 'options', source, attempt);
    assert.equal(redelivery.statusCode, 200, redelivery.body);
    assert.equal(redelivery.json().phase, 'create');
    assert.equal(redelivery.json().options.challenge, creation.challenge);
    assert.equal(redelivery.json().options.timeout, 35_000);
    assert.equal(redelivery.json().expires_in_ms, 35_000);
    assert.deepEqual(db.one('SELECT * FROM auth_passkey_enrollments'), stored);
    const key = virtualPasskey(config.appUrl, creation.user.id);
    const registration = { ...attempt, ...key.registration(creation.challenge) };
    const proofs = await Promise.all([
      post(passkeyEnrollment + 'verify', source, registration),
      post(passkeyEnrollment + 'verify', source, registration),
    ]);
    assert.deepEqual(proofs.map((r) => r.statusCode).sort(), [200, 400]);
    const { options: possession } = proofs.find((r) => r.statusCode === 200)!.json();
    assert.equal(possession.timeout, 35_000);
    assert.equal(possession.allowCredentials, undefined);
    assert.notEqual(possession.challenge, creation.challenge);
    const staged = db.one('SELECT * FROM auth_passkey_enrollments')!;
    assert.equal(staged.expires_at, stored.expires_at);
    assert.equal(staged.challenge_hash, digest(possession.challenge));

    assert.equal((await post(passkeyEnrollment + 'options', source, competingTab)).statusCode, 409);
    const resumed = await post(passkeyEnrollment + 'options', source, attempt);
    assert.equal(resumed.statusCode, 200, resumed.body);
    assert.equal(resumed.json().phase, 'possession');
    assert.deepEqual(resumed.json().options, possession);
    assert.equal((await post(passkeyEnrollment + 'cancel', otherGrant, attempt)).statusCode, 200);
    assert.deepEqual(
      db.one('SELECT * FROM auth_passkey_enrollments WHERE nonce IS NOT NULL'),
      staged,
    );
    const otherAttempt = newAttempt();
    const other = await post(passkeyEnrollment + 'options', otherGrant, otherAttempt);
    assert.equal(other.statusCode, 200, other.body);
    const { options: otherCreation } = other.json();
    const secondKey = virtualPasskey(config.appUrl, otherCreation.user.id);
    const otherProof = await post(passkeyEnrollment + 'verify', otherGrant, {
      ...otherAttempt,
      ...secondKey.registration(otherCreation.challenge),
    });
    assert.equal(otherProof.statusCode, 200, otherProof.body);

    const confirmation = { ...attempt, ...key.assertion(possession.challenge) };
    const finishes = await Promise.all([
      post(passkeyEnrollment + 'confirm', source, confirmation),
      post(passkeyEnrollment + 'confirm', source, confirmation),
      post(passkeyEnrollment + 'confirm', otherGrant, {
        ...otherAttempt,
        ...secondKey.assertion(otherProof.json().options.challenge),
      }),
    ]);
    assert.deepEqual(finishes.map((r) => r.statusCode).sort(), [200, 401, 401]);
    const added = finishes.findIndex((r) => r.statusCode === 200);
    assert.equal(finishes[added].json().session.stage, 'full');
    assert.equal(finishes[added].json().recovery_codes.length, 10);
    assert.equal(db.all('SELECT id FROM auth_passkeys').length, 1);
    assert.equal(db.one('SELECT id FROM auth_passkeys')!.id, added === 2 ? secondKey.id : key.id);
    assert.equal(db.all('SELECT 1 FROM sessions WHERE user_id IS NOT NULL').length, 1);
    assert.equal(db.all('SELECT 1 FROM auth_passkey_enrollments').length, 0);
  } finally {
    await close();
  }
});

test('selecting an existing passkey leaves the new passkey ready to confirm within its original deadline', async (t) => {
  let clock = Date.UTC(2026, 0, 1, 12);
  t.mock.method(Date, 'now', () => clock);
  const { post, login, headers, db, config, close } = await fixture();
  try {
    async function stage(source: Record<string, string>, name: string) {
      const attempt = newAttempt();
      const started = await post(passkeyEnrollment + 'options', source, attempt);
      assert.equal(started.statusCode, 200, started.body);
      assert.equal(started.json().phase, 'create');
      const { challenge, user } = started.json().options;
      const key = virtualPasskey(config.appUrl, user.id);
      const staged = await post(passkeyEnrollment + 'verify', source, {
        ...attempt,
        ...key.registration(challenge),
        name,
      });
      assert.equal(staged.statusCode, 200, staged.body);
      return { attempt, key, options: staged.json().options };
    }

    const source = headers(await login());
    const existing = await stage(source, 'Existing passkey');
    const enrolled = await post(passkeyEnrollment + 'confirm', source, {
      ...existing.attempt,
      ...existing.key.assertion(existing.options.challenge),
    });
    const active = headers(enrolled);
    const candidate = await stage(active, 'New passkey');
    assert.equal(candidate.options.allowCredentials, undefined);
    const staged = db.one('SELECT * FROM auth_passkey_enrollments')!;
    assert.equal(staged.id, candidate.key.id);
    assert.equal(staged.expires_at, now() + 120);

    clock += 30_000;
    const wrong = await post(passkeyEnrollment + 'confirm', active, {
      ...candidate.attempt,
      ...existing.key.assertion(candidate.options.challenge),
    });
    assert.equal(wrong.statusCode, 400, wrong.body);
    assert.equal(wrong.json().code, 'passkey_setup_wrong_credential');
    assert.match(wrong.json().detail, /select the passkey you just created/);
    assert.equal(wrong.cookies.length, 0);
    assert.deepEqual(db.one('SELECT * FROM auth_passkey_enrollments'), staged);
    assert.deepEqual(
      db.all('SELECT id FROM auth_passkeys').map(({ id }) => id),
      [existing.key.id],
    );

    clock += 89_000;
    const resumed = await post(passkeyEnrollment + 'options', active, candidate.attempt);
    assert.equal(resumed.statusCode, 200, resumed.body);
    assert.equal(resumed.json().phase, 'possession');
    assert.equal(resumed.json().options.challenge, candidate.options.challenge);
    assert.equal(resumed.json().expires_in_ms, 1000);
    const confirmed = await post(passkeyEnrollment + 'confirm', active, {
      ...candidate.attempt,
      ...candidate.key.assertion(resumed.json().options.challenge),
    });
    assert.equal(confirmed.statusCode, 200, confirmed.body);
    assert.equal(confirmed.json().session.stage, 'full');
    const keys = db
      .all('SELECT id,name FROM auth_passkeys ORDER BY name')
      .map(({ id, name }) => [id, name]);
    assert.deepEqual(keys, [
      [existing.key.id, 'Existing passkey'],
      [candidate.key.id, 'New passkey'],
    ]);
  } finally {
    await close();
  }
});

test('passkey cancellation and expiry allow a retry while a stale cancel leaves the new attempt intact', async (t) => {
  let clock = Date.UTC(2026, 0, 1, 12);
  t.mock.method(Date, 'now', () => clock);
  const { post, login, headers, db, config, close } = await fixture();
  try {
    const source = headers(await login());
    const start = async (attempt: ReturnType<typeof newAttempt>) => {
      const result = await post(passkeyEnrollment + 'options', source, attempt);
      assert.equal(result.statusCode, 200, result.body);
      return result.json().options;
    };
    const cancelled = newAttempt();
    const secondAttempt = newAttempt();
    const first = await start(cancelled);
    assert.equal(
      (await post(passkeyEnrollment + 'cancel', { ...source, 'x-csrf-token': 'wrong' }, cancelled))
        .statusCode,
      403,
    );
    assert.equal(
      (
        await post(
          passkeyEnrollment + 'cancel',
          { ...source, origin: 'http://foreign.test' },
          cancelled,
        )
      ).statusCode,
      403,
    );
    assert.equal(
      (await post(passkeyEnrollment + 'options', source, secondAttempt)).statusCode,
      409,
    );
    assert.equal((await post(passkeyEnrollment + 'cancel', source, cancelled)).statusCode, 200);
    const delayed = await post(passkeyEnrollment + 'options', source, cancelled);
    assert.equal(delayed.statusCode, 400, delayed.body);
    assert.equal(delayed.json().code, 'passkey_setup_expired');
    const second = await start(secondAttempt);
    assert.notEqual(second.challenge, first.challenge);
    const key = virtualPasskey(config.appUrl, second.user.id);
    const candidate = await post(passkeyEnrollment + 'verify', source, {
      ...secondAttempt,
      ...key.registration(second.challenge),
    });
    assert.equal(candidate.statusCode, 200, candidate.body);
    assert.equal((await post(passkeyEnrollment + 'cancel', source, cancelled)).statusCode, 200);
    const outOfOrder = newAttempt();
    assert.equal((await post(passkeyEnrollment + 'options', source, outOfOrder)).statusCode, 409);
    assert.equal((await post(passkeyEnrollment + 'cancel', source, outOfOrder)).statusCode, 200);
    assert.equal(
      (await post(passkeyEnrollment + 'options', source, secondAttempt)).json().phase,
      'possession',
    );
    assert.equal((await post(passkeyEnrollment + 'cancel', source, secondAttempt)).statusCode, 200);
    const stale = await post(passkeyEnrollment + 'confirm', source, {
      ...secondAttempt,
      ...key.assertion(candidate.json().options.challenge),
    });
    assert.equal(stale.statusCode, 400, stale.body);

    // A cancellation received before its options POST must suppress that POST.
    const lateOptions = await post(passkeyEnrollment + 'options', source, outOfOrder);
    assert.equal(lateOptions.statusCode, 400, lateOptions.body);
    assert.equal(lateOptions.json().code, 'passkey_setup_expired');
    const expiredAttempt = newAttempt();
    const expired = await start(expiredAttempt);
    clock += 120_000;
    assert.equal(
      (await post(passkeyEnrollment + 'options', source, expiredAttempt)).statusCode,
      400,
    );
    const retry = await start(newAttempt());
    assert.notEqual(retry.challenge, expired.challenge);
    assert.equal(
      db.one('SELECT count(*) AS n FROM auth_passkey_enrollments WHERE id IS NOT NULL')!.n,
      0,
    );
    assert.equal(db.one('SELECT count(*) AS n FROM auth_passkeys')!.n, 0);
  } finally {
    await close();
  }
});

test('both enrollment hints and server state expire with the original proof during verification', async (t) => {
  let clock = Date.UTC(2026, 0, 1, 12);
  t.mock.method(Date, 'now', () => clock);
  const { post, login, headers, db, config, close } = await fixture({ MFA_REQUIRED_ROLES: 'none' });
  try {
    const signedIn = await login();
    const deadline = signedIn.json().session.proof_at + 300;
    const source = headers(signedIn);
    const attempt = newAttempt();
    clock = deadline * 1000 - 17_500;
    const started = await post(passkeyEnrollment + 'options', source, attempt);
    assert.equal(started.statusCode, 200, started.body);
    const { options: creation } = started.json();
    db.run("UPDATE sessions SET proof_kind='steam' WHERE user_id IS NOT NULL");
    db.run("INSERT OR REPLACE INTO settings(key,value) VALUES('steam_enabled',0)");
    const paused = await post(passkeyEnrollment + 'cancel', source, attempt);
    assert.equal(paused.statusCode, 403, paused.body);
    db.run("UPDATE settings SET value=1 WHERE key='steam_enabled'");
    const resumed = await post(passkeyEnrollment + 'options', source, attempt);
    assert.equal(resumed.statusCode, 200, resumed.body);
    assert.equal(resumed.json().options.challenge, creation.challenge);
    assert.equal(creation.timeout, 17_500);
    assert.equal(db.one('SELECT expires_at FROM auth_passkey_enrollments')!.expires_at, deadline);
    const key = virtualPasskey(config.appUrl, creation.user.id);
    clock += 6_000;
    const candidate = await post(passkeyEnrollment + 'verify', source, {
      ...attempt,
      ...key.registration(creation.challenge),
    });
    assert.equal(candidate.statusCode, 200, candidate.body);
    const { options: possession } = candidate.json();
    assert.equal(possession.timeout, 11_500);
    assert.equal(db.one('SELECT expires_at FROM auth_passkey_enrollments')!.expires_at, deadline);

    const cryptoVerify = crypto.subtle.verify.bind(crypto.subtle);
    const verify = t.mock.method(
      crypto.subtle,
      'verify',
      async (...args: Parameters<typeof cryptoVerify>) => {
        const verified = await cryptoVerify(...args);
        assert.equal(verified, true);
        clock = deadline * 1000;
        return verified;
      },
    );
    const late = await post(passkeyEnrollment + 'confirm', source, {
      ...attempt,
      ...key.assertion(possession.challenge),
    });
    assert.equal(verify.mock.callCount(), 1);
    assert.equal(late.statusCode, 403, late.body);
    assert.equal(db.one('SELECT count(*) AS n FROM auth_passkeys')!.n, 0);
    assert.equal((await post(passkeyEnrollment + 'options', source, newAttempt())).statusCode, 403);
    const expiredRow = db.one('SELECT * FROM auth_passkey_enrollments');
    for (const selector of [attempt, newAttempt()]) {
      const dismissed = await post(passkeyEnrollment + 'cancel', source, selector);
      assert.deepEqual(dismissed.json(), { ok: true });
      assert.equal(dismissed.statusCode, 200);
    }
    assert.deepEqual(db.all('SELECT * FROM auth_passkey_enrollments'), [expiredRow]);
  } finally {
    await close();
  }
});

test('parallel OTP guesses are paced per browser and account address, while a clean browser can finish', async (t) => {
  const elapsedSince = performance.now();
  t.mock.method(
    Date,
    'now',
    () => Date.UTC(2026, 0, 1, 12) + Math.floor(performance.now() - elapsedSince),
  );
  const { post, login, headers, db, config, close } = await fixture();
  const original = db.run.bind(db);
  try {
    const userId = db.one('SELECT id FROM users WHERE username=?', config.adminUsername)!.id;
    const seed = '12345678901234567890';
    db.run(
      'INSERT INTO auth_totp VALUES(?,?,?,?)',
      userId,
      seal(openEncryptionKey(config, db), totpBinding(userId), Buffer.from(seed).toString('hex')),
      -1,
      now(),
    );
    db.run(
      'INSERT INTO rate_limits VALUES(?,?,?)',
      digest(`factor-delay:account:${userId}`),
      4,
      now() + 120,
    );
    const [browser, nearbyBrowser, cleanBrowser] = (
      await Promise.all([login(), login(), login()])
    ).map(headers);
    const good = codeFor('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', Math.floor(now() / 30));
    const validWindow = [-1, 0, 1].map((drift) =>
      codeFor('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', Math.floor(now() / 30) + drift),
    );
    const wrong = ['100000', '200000', '300000', '400000'].find(
      (code) => !validWindow.includes(code),
    )!;
    const submit = (source: typeof browser, remote: string, code = wrong) =>
      post('/api/auth/mfa/totp', source, { code }, remote);
    db.run(
      'INSERT INTO auth_otp_clock(user_id,next_at_ms) VALUES(?,?)',
      userId,
      Date.now() + 30_000,
    );
    assert.equal((await submit(cleanBrowser, '198.51.100.2', good)).statusCode, 429);
    assert.equal(db.one('SELECT last_step FROM auth_totp WHERE user_id=?', userId)!.last_step, -1);
    db.run('DELETE FROM auth_otp_clock WHERE user_id=?', userId);
    const slots = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const scheduled: number[] = [];
    const checked: number[] = [];
    let reserved = 0;
    db.run = (sql, ...args) => {
      const result = original(sql, ...args);
      if (sql.startsWith('UPDATE auth_otp_clock SET last_checked_ms='))
        checked.push(Number(args[0]));
      if (sql.startsWith('INSERT INTO auth_otp_pacing') && result.changes) {
        scheduled.push(Number(args.at(-1)));
        slots[reserved++]?.resolve();
      }
      return result;
    };
    const pending = submit(browser, '192.0.2.1');
    await Promise.race([slots[0].promise, pending]);
    assert.equal(reserved, 1);
    const sameBrowser = submit(browser, '192.0.2.2');
    await Promise.race([slots[1].promise, sameBrowser]);
    const [first, duplicate, fromSameAddress, clean] = await Promise.all([
      pending,
      sameBrowser,
      submit(nearbyBrowser, '192.0.2.1'),
      submit(cleanBrowser, '198.51.100.2', good),
    ]);
    assert.equal(first.statusCode, 401, first.body);
    assert.equal(duplicate.statusCode, 429, duplicate.body);
    assert.equal(fromSameAddress.statusCode, 429, fromSameAddress.body);
    assert.equal(clean.statusCode, 200, clean.body);
    assert.equal(clean.json().session.proof_kind, 'totp');
    assert.equal(reserved, 2);
    assert.ok(checked[1] - checked[0] >= 2000, 'mature timers preserve actual per-account spacing');
    assert.ok(
      scheduled[1] - scheduled[0] >= 2000,
      'independent browsers occupy different aggregate account slots',
    );
    assert.equal(
      db.one(
        'SELECT count FROM rate_limits WHERE key=?',
        digest('factor-code-instance-challenge:instance'),
      )!.count,
      2,
    );
    assert.equal(db.one('SELECT count(*) AS n FROM auth_otp_pacing')!.n, 0);
  } finally {
    db.run = original;
    await close();
  }
});

test('a timely TOTP stays valid when an admitted verification crosses two clock steps', async (t) => {
  const start = Date.UTC(2026, 0, 1, 12);
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const { db, post, headers, login, close } = await fixture();
  try {
    const source = headers(await login());
    const { enrollment, secret } = (await post('/api/auth/factors/totp/options', source)).json();
    const step = Math.floor(now() / 30);
    const lookup = db.one.bind(db);
    let reads = 0;
    // Advance during commit-time revalidation, after the request was admitted.
    db.one = (sql, ...args) => {
      const row = lookup(sql, ...args);
      if (sql.startsWith('SELECT enrollment_hash,encrypted_secret') && ++reads === 2)
        t.mock.timers.setTime(start + 60_000);
      return row;
    };
    const finished = await post('/api/auth/factors/totp/verify', source, {
      enrollment,
      code: codeFor(secret, step),
    });
    assert.equal(finished.statusCode, 200, finished.body);
    assert.equal(db.one('SELECT last_step FROM auth_totp')!.last_step, step);
  } finally {
    await close();
  }
});

test('a fresh administrator session cannot rename or remove a foreign passkey', async () => {
  const { app, db, login, headers, close } = await fixture({ MFA_REQUIRED_ROLES: 'none' });
  try {
    const browser = headers(await login());
    const foreign = 'foreign-passkey-owner';
    const credentialId = Buffer.from('foreign-credential').toString('base64url');
    const missingId = Buffer.from('missing-credential').toString('base64url');
    db.run(
      'INSERT INTO users(id,username,role,created_at) VALUES(?,?,?,?)',
      foreign,
      'foreign_owner',
      'member',
      now(),
    );
    db.run(
      'INSERT INTO auth_passkeys(id,user_id,name,public_key,counter,device_type,backed_up,created_at) VALUES(?,?,?,?,?,?,?,?)',
      credentialId,
      foreign,
      'Original key name',
      Buffer.from([1]),
      0,
      'singleDevice',
      0,
      now(),
    );
    for (const method of ['PATCH', 'DELETE'] as const) {
      const change = (id: string) =>
        app.inject({
          method,
          url: '/api/auth/factors/passkeys/' + id,
          headers: browser,
          ...(method === 'PATCH' ? { payload: { name: 'Unexpected rename' } } : {}),
        });
      const denied = await change(credentialId);
      const missing = await change(missingId);
      assert.equal(denied.statusCode, 404, denied.body);
      assert.equal(missing.statusCode, 404, missing.body);
      assert.deepEqual(denied.json(), missing.json());
    }
    const key = db.one('SELECT user_id,name FROM auth_passkeys WHERE id=?', credentialId);
    assert.ok(key);
    assert.equal(key.user_id, foreign);
    assert.equal(key.name, 'Original key name');
  } finally {
    await close();
  }
});
