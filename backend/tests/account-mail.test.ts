import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createServer,
  getCACertificates,
  setDefaultCACertificates,
  type TLSSocket,
} from 'node:tls';
import { setTimeout } from 'node:timers/promises';
import { loadConfig } from '../src/config.js';
import { now, Store } from '../src/db.js';
import { issuePasswordReset } from '../src/recovery.js';
import { digest, verifyPassword } from '../src/security.js';
import { createApp } from '../src/server.js';
import { submitAccountMessage } from '../src/smtp.js';
import { browserBootstrap } from './fixtures/browser-bootstrap.js';
import { fixtureCookie, insertFixtureSession } from './fixtures/member-session.js';

process.env.LOG_LEVEL = 'silent';

const oldPassword = 'Initial-account-fixture-password';
const newPassword = 'Replacement-account-fixture-password';
const appUrl = 'http://localhost:8000';
type Browser = Awaited<ReturnType<typeof browserBootstrap>> & { 'accept-language'?: string };
type Mail = { address: string; body: string };

async function waitFor<T>(read: () => T | undefined) {
  const deadline = Date.now() + 5000;
  do {
    const result = read();
    if (result !== undefined) return result;
    await setTimeout(10);
  } while (Date.now() < deadline);
  assert.fail('Timed out waiting for the local account mail fixture');
}

async function relay(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'cswatch-tls-mail-'));
  const key = join(dir, 'key.pem');
  const cert = join(dir, 'cert.pem');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
      '-keyout',
      key,
      '-out',
      cert,
    ],
    { stdio: 'ignore' },
  );
  const password = randomBytes(24).toString('hex');
  const username = 'fixture-template';
  const from = 'mailer@example.test';
  const auth = 'AUTH PLAIN ' + Buffer.from('\0' + username + '\0' + password).toString('base64');
  const delivered: Mail[] = [];
  const sockets = new Set<TLSSocket>();
  let connections = 0;
  let greet = true;
  let disposition: 'accept' | 'reject' | 'disconnect' = 'accept';
  let completedData = 0;
  const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (socket) => {
    sockets.add(socket);
    connections++;
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    if (!greet) return;
    socket.write('220 Private test relay\r\n');
    socket.setEncoding('ascii');
    let state = 'hello';
    let buffer = '';
    let recipient = '';
    let data: string[] = [];
    socket.on('data', (chunk) => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf('\r\n')) !== -1) {
        const input = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (state === 'hello' && input.startsWith('EHLO ')) {
          state = 'auth';
          socket.write('250-Private test relay\r\n250 AUTH PLAIN\r\n');
        } else if (state === 'auth' && input === auth) {
          state = 'sender';
          socket.write('235 Authenticated\r\n');
        } else if (state === 'sender' && input === 'MAIL FROM:<' + from + '>') {
          state = 'recipient';
          socket.write('250 Sender ok\r\n');
        } else if (state === 'recipient' && /^RCPT TO:<[^<>]+>$/.test(input)) {
          recipient = input.slice('RCPT TO:<'.length, -1);
          state = 'data';
          socket.write('250 Recipient ok\r\n');
        } else if (state === 'data' && input === 'DATA') {
          state = 'message';
          socket.write('354 Awaiting message\r\n');
        } else if (state === 'message' && input === '.') {
          completedData++;
          if (disposition !== 'accept') {
            if (disposition === 'reject')
              socket.end('451-Temporary local failure\r\n451 Please retry later\r\n');
            else socket.destroy();
            return;
          }
          const encoded = data.slice(data.indexOf('') + 1).join('');
          delivered.push({
            address: recipient,
            body: Buffer.from(encoded, 'base64').toString('utf8'),
          });
          data = [];
          state = 'quit';
          socket.write('250 Stored locally\r\n');
        } else if (state === 'message') {
          data.push(input);
        } else if (state === 'quit' && input === 'QUIT') {
          socket.end('221 Closing connection\r\n');
        } else {
          socket.end('503 Unexpected SMTP command\r\n');
        }
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const certificate = readFileSync(cert, 'utf8');
  const originalCAs = getCACertificates('default');
  setDefaultCACertificates([...originalCAs, certificate]);
  t.after(async () => {
    setDefaultCACertificates(originalCAs);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  return {
    delivered,
    connections: () => connections,
    completedData: () => completedData,
    respondToData: (next: typeof disposition) => {
      disposition = next;
    },
    stallGreeting: () => {
      greet = false;
    },
    config: { host: '127.0.0.1', port: address.port, from, username, password },
  };
}

async function fixture(t: TestContext, adminEmail?: string) {
  const smtp = await relay(t);
  const root = mkdtempSync(join(tmpdir(), 'cswatch-account-mail-'));
  const db = new Store(root);
  const c = loadConfig({
    APP_URL: appUrl,
    COOKIE_SECURE: 'false',
    ADMIN_USERNAME: 'local-mail-admin',
    ADMIN_PASSWORD: oldPassword,
    ADMIN_EMAIL: adminEmail,
    MFA_REQUIRED_ROLES: 'none',
    SMTP_HOST: smtp.config.host,
    SMTP_PORT: String(smtp.config.port),
    SMTP_FROM: smtp.config.from,
    SMTP_USERNAME: smtp.config.username,
    SMTP_PASSWORD: smtp.config.password,
    DATA_DIR: root,
  });
  const app = await createApp(c, db);
  t.after(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });
  const headers: Browser = {
    host: c.host,
    origin: c.appUrl,
    cookie: fixtureCookie('mail-admin'),
    'x-csrf-token': 'fixture-admin-csrf',
  };
  const admin = db.one("SELECT id FROM users WHERE username='local-mail-admin'")!.id;
  insertFixtureSession(db, 'mail-admin', admin, headers['x-csrf-token'], now() + 600);
  const configure = (enabled: boolean) =>
    app.inject({
      method: 'PATCH',
      url: '/api/admin',
      headers,
      payload: { email_delivery_enabled: enabled },
    });
  const post = (path: string, headers: Browser, payload: Record<string, string>) =>
    app.inject({ method: 'POST', url: '/api/' + path, headers, payload });
  const applySession = (previous: Browser, response: Awaited<ReturnType<typeof post>>): Browser => {
    const cookies = new Map(
      previous.cookie.split('; ').map((entry) => {
        const index = entry.indexOf('=');
        return [entry.slice(0, index), entry.slice(index + 1)];
      }),
    );
    for (const { name, value } of response.cookies) {
      if (value) cookies.set(name, value);
      else cookies.delete(name);
    }
    return {
      ...previous,
      cookie: [...cookies].map(([name, value]) => name + '=' + value).join('; '),
      'x-csrf-token': response.json().session.csrf,
    };
  };
  const bootstrap = () => browserBootstrap(app, c);
  const register = async (email: string) => {
    const browser = await bootstrap();
    const response = await post(
      'auth/register',
      { ...browser, 'accept-language': 'fr-CA,en' },
      {
        email,
        display_name: 'Same display name',
        password: oldPassword,
      },
    );
    assert.equal(response.statusCode, 201, response.body);
    return applySession(browser, response);
  };
  const codeAt = async (number: number, purpose: string, address: string) => {
    const delivered = await waitFor(() => smtp.delivered[number - 1]);
    assert.equal(delivered.address, address);
    const code = delivered.body.match(
      new RegExp('^' + appUrl + '/' + purpose + '#([0-9a-f]{64})$', 'm'),
    )?.[1];
    assert.ok(code);
    return code;
  };
  return { app, bootstrap, c, db, configure, headers, post, applySession, register, codeAt, smtp };
}

test('the environment-provisioned administrator can recover by email as soon as delivery is enabled', async (t) => {
  const email = 'operator@example.test';
  const f = await fixture(t, email);
  assert.equal((await f.configure(true)).statusCode, 200);
  const browser = await f.bootstrap();
  const requested = await f.post('auth/recover/request', browser, { email });
  assert.equal(requested.statusCode, 200, requested.body);
  const code = await f.codeAt(1, 'recover', email);
  const claimed = await f.post('auth/recover/claim', browser, { code });
  assert.equal(claimed.statusCode, 200, claimed.body);
});

test('registration verification is bound to the current address and signed-in account', async (t) => {
  const f = await fixture(t);
  const firstEmail = 'one@example.test';
  const nextEmail = 'two@example.test';
  assert.equal(
    (await f.app.inject({ url: '/api/config', headers: f.headers })).json().email_delivery_enabled,
    false,
  );
  const settings = (await f.app.inject({ url: '/api/admin', headers: f.headers })).json();
  assert.deepEqual(settings.flags.email_delivery_enabled, { value: false, locked: false });
  assert.equal(settings.email_delivery_configured, true);
  assert.equal((await f.configure(true)).statusCode, 200);

  let owner = await f.register(firstEmail);
  const firstCode = await f.codeAt(1, 'verify-email', firstEmail);
  assert.match(f.smtp.delivered[0].body, /30 minutes/);
  const user = f.db.one('SELECT id FROM users WHERE email=?', firstEmail)!;
  assert.equal(
    f.db.one('SELECT verifier FROM email_verifications WHERE user_id=?', user.id)?.verifier,
    digest(firstCode),
  );
  assert.equal((await f.app.inject({ url: '/api/demos', headers: owner })).statusCode, 403);
  assert.equal(
    (await f.post('auth/email/verify', await f.bootstrap(), { code: firstCode })).statusCode,
    401,
  );
  assert.equal((await f.post('auth/email/verify', f.headers, { code: firstCode })).statusCode, 400);
  assert.equal(
    (
      await f.post(
        'auth/email/verify',
        { ...owner, origin: 'http://other.example.test' },
        { code: firstCode },
      )
    ).statusCode,
    403,
  );

  const changed = await f.post('auth/profile', owner, { email: nextEmail });
  assert.equal(changed.statusCode, 200, changed.body);
  owner = f.applySession(owner, changed);
  const secondCode = await f.codeAt(2, 'verify-email', nextEmail);
  assert.equal((await f.post('auth/email/verify', owner, { code: firstCode })).statusCode, 400);
  // Account credential rotations do not change possession of the same email address.
  f.db.run('UPDATE users SET auth_generation=auth_generation+1 WHERE id=?', user.id);
  const freshBrowser = await f.bootstrap();
  const login = await f.post('auth/login', freshBrowser, {
    username: nextEmail,
    password: oldPassword,
  });
  assert.equal(login.statusCode, 200, login.body);
  owner = f.applySession(freshBrowser, login);
  const differentBrowser = await f.bootstrap();
  const otherLogin = await f.post('auth/login', differentBrowser, {
    username: nextEmail,
    password: oldPassword,
  });
  assert.equal(otherLogin.statusCode, 200, otherLogin.body);
  const otherGrant = f.applySession(differentBrowser, otherLogin);
  f.db.run('UPDATE sessions SET proof_at=? WHERE csrf=?', now() - 360, owner['x-csrf-token']);
  const lifetime = f.db.one(
    'SELECT proof_at,expires_at FROM sessions WHERE csrf=?',
    owner['x-csrf-token'],
  );
  const verify = await f.post('auth/email/verify', owner, { code: secondCode });
  assert.equal(verify.statusCode, 200, verify.body);
  assert.equal((await f.app.inject({ url: '/api/demos', headers: otherGrant })).statusCode, 401);
  assert.equal((await f.app.inject({ url: '/api/demos', headers: owner })).statusCode, 401);
  owner = f.applySession(owner, verify);
  assert.deepEqual(
    f.db.one('SELECT proof_at,expires_at FROM sessions WHERE csrf=?', owner['x-csrf-token']),
    lifetime,
  );
  assert.equal((await f.post('auth/email/verify', owner, { code: secondCode })).statusCode, 400);
  assert.equal(
    f.db.one('SELECT COUNT(*) AS n FROM email_verifications WHERE user_id=?', user.id)?.n,
    0,
  );
  assert.equal((await f.app.inject({ url: '/api/demos', headers: owner })).statusCode, 200);
});

test('email recovery stays generic and preserves current credentials, factors and existing exchanges', async (t) => {
  const f = await fixture(t);
  const email = 'recovery@example.test';
  const other = 'unverified@example.test';
  assert.equal((await f.configure(true)).statusCode, 200);
  let owner = await f.register(email);
  const id = f.db.one('SELECT id FROM users WHERE email=?', email)!.id;
  const confirmation = await f.codeAt(1, 'verify-email', email);
  f.db.run("INSERT INTO users(id,username,created_at,email) VALUES('other','other',0,?)", other);

  const anonymous = await f.bootstrap();
  const request = (email: string) => f.post('auth/recover/request', anonymous, { email });
  const claim = (code: string, browser = anonymous) =>
    f.post('auth/recover/claim', browser, { code });
  for (const address of [other, email, 'unknown@example.test']) {
    const response = await request(address);
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), { ok: true });
  }
  await setTimeout(30);
  assert.equal(f.smtp.delivered.length, 1);
  const confirmed = await f.post('auth/email/verify', owner, { code: confirmation });
  assert.equal(confirmed.statusCode, 200, confirmed.body);
  owner = f.applySession(owner, confirmed);

  const beforeHash = f.db.one('SELECT password_hash FROM users WHERE id=?', id)?.password_hash;
  const known = await request(email.toUpperCase());
  assert.equal(known.statusCode, 200, known.body);
  assert.deepEqual(known.json(), { ok: true });
  const superseded = await f.codeAt(2, 'recover', email);
  assert.equal(
    f.db.one('SELECT verifier FROM email_recovery_codes WHERE user_id=?', id)?.verifier,
    digest(superseded),
  );
  assert.equal(
    f.db.one('SELECT password_hash FROM users WHERE id=?', id)?.password_hash,
    beforeHash,
  );
  assert.equal(f.db.one('SELECT COUNT(*) AS n FROM password_resets')?.n, 0);

  // An operator can supersede a mailed capability. Public requests leave the
  // operator's code and browser claim untouched.
  const operatorCode = f.db.transaction(() => issuePasswordReset(f.db, id));
  assert.equal((await claim(superseded)).statusCode, 400);
  assert.deepEqual((await request(email)).json(), { ok: true });
  const operatorClaim = await claim(operatorCode);
  assert.equal(operatorClaim.statusCode, 200, operatorClaim.body);
  assert.deepEqual((await request(email)).json(), { ok: true });
  assert.equal(
    f.db.one('SELECT verifier FROM password_resets WHERE user_id=?', id)?.verifier,
    digest(operatorCode),
  );
  f.db.run('UPDATE password_resets SET expires_at=? WHERE user_id=?', now(), id);

  assert.deepEqual((await request(email)).json(), { ok: true });
  const oldGenerationCode = await f.codeAt(3, 'recover', email);
  f.db.run('UPDATE users SET auth_generation=auth_generation+1 WHERE id=?', id);
  assert.equal((await claim(oldGenerationCode)).statusCode, 400);

  const currentBrowser = await f.bootstrap();
  const login = await f.post('auth/login', currentBrowser, {
    username: email,
    password: oldPassword,
  });
  assert.equal(login.statusCode, 200, login.body);
  owner = f.applySession(currentBrowser, login);
  assert.deepEqual((await request(email)).json(), { ok: true });
  const oldAddressCode = await f.codeAt(4, 'recover', email);
  const addr = 'replacement@example.test';
  const change = await f.post('auth/profile', owner, { email: addr });
  assert.equal(change.statusCode, 200, change.body);
  owner = f.applySession(owner, change);
  const verifyNew = await f.codeAt(5, 'verify-email', addr);
  assert.equal((await claim(oldAddressCode)).statusCode, 400);
  assert.equal((await f.post('auth/email/verify', owner, { code: verifyNew })).statusCode, 200);
  assert.deepEqual((await request(addr)).json(), { ok: true });
  const reset = await f.codeAt(6, 'recover', addr);
  const browser = await f.bootstrap();
  const accepted = await claim(reset, browser);
  assert.equal(accepted.statusCode, 200, accepted.body);
  const { claim_id } = accepted.json();
  assert.equal((await claim(reset)).statusCode, 400);
  f.db.run(
    "INSERT INTO auth_passkeys(id,user_id,name,public_key,counter,device_type,backed_up,created_at) VALUES('fixture-key',?,'test',?,0,'singleDevice',0,0)",
    id,
    Buffer.from([1]),
  );
  const resetPassword = () =>
    f.post('auth/recover/complete', browser, { claim_id, password: newPassword });
  const completed = await resetPassword();
  assert.equal(completed.statusCode, 200, completed.body);
  assert.equal((await resetPassword()).statusCode, 400);
  const hash = f.db.one('SELECT password_hash FROM users WHERE id=?', id)?.password_hash;
  assert.equal(await verifyPassword(hash, oldPassword), false);
  assert.equal(await verifyPassword(hash, newPassword), true);
  assert.equal(f.db.one('SELECT COUNT(*) AS n FROM auth_passkeys WHERE user_id=?', id)?.n, 1);
  const another = await f.bootstrap();
  const after = await f.post('auth/login', another, { username: addr, password: newPassword });
  assert.equal(after.statusCode, 200, after.body);
  assert.equal(after.json().session.stage, 'challenge');
});

test('disabling email retires only emailed exchanges and releases pending signup', async (t) => {
  const f = await fixture(t);
  const email = 'pending@example.test';
  const otherEmail = 'another@example.test';
  assert.equal((await f.configure(true)).statusCode, 200);
  let waiting = await f.register(email);
  const old = await f.codeAt(1, 'verify-email', email);
  const recovered = await f.register(otherEmail);
  const confirm = await f.codeAt(2, 'verify-email', otherEmail);
  assert.equal((await f.post('auth/email/verify', recovered, { code: confirm })).statusCode, 200);
  const browser = await f.bootstrap();
  assert.deepEqual((await f.post('auth/recover/request', browser, { email: otherEmail })).json(), {
    ok: true,
  });
  const emailReset = await f.codeAt(3, 'recover', otherEmail);
  const claim = (code: string) => f.post('auth/recover/claim', browser, { code });
  assert.equal((await claim(emailReset)).statusCode, 200);
  const admin = f.db.one("SELECT id FROM users WHERE username='local-mail-admin'")!.id;
  const operatorCode = f.db.transaction(() => issuePasswordReset(f.db, admin));

  assert.equal((await f.configure(false)).statusCode, 200);
  assert.equal((await f.app.inject({ url: '/api/demos', headers: waiting })).statusCode, 401);
  const signedOut = await f.bootstrap();
  const signIn = await f.post('auth/login', signedOut, { username: email, password: oldPassword });
  assert.equal(signIn.statusCode, 200, signIn.body);
  waiting = f.applySession(signedOut, signIn);
  assert.equal((await f.app.inject({ url: '/api/demos', headers: waiting })).statusCode, 200);
  assert.equal((await claim(emailReset)).statusCode, 400);
  assert.equal((await claim(operatorCode)).statusCode, 200);
  assert.equal((await f.configure(true)).statusCode, 200);
  assert.equal((await f.app.inject({ url: '/api/demos', headers: waiting })).statusCode, 200);
  assert.equal((await f.post('auth/email/verify', waiting, { code: old })).statusCode, 400);
});

test('administrator sign-out retires emailed reset links and preserves operator-issued claims', async (t) => {
  const f = await fixture(t);
  const email = 'signed-out@example.test';
  assert.equal((await f.configure(true)).statusCode, 200);
  const member = await f.register(email);
  const verification = await f.codeAt(1, 'verify-email', email);
  assert.equal((await f.post('auth/email/verify', member, { code: verification })).statusCode, 200);
  const id = f.db.one('SELECT id FROM users WHERE email=?', email)!.id;
  const browser = await f.bootstrap();
  const request = () => f.post('auth/recover/request', browser, { email });
  const claim = (code: string) => f.post('auth/recover/claim', browser, { code });
  const complete = (claim_id: string) =>
    f.post('auth/recover/complete', browser, { claim_id, password: newPassword });
  const adminAction = (action: string) =>
    f.post('admin/users/' + id + '/actions', f.headers, { action });

  assert.deepEqual((await request()).json(), { ok: true });
  const unused = await f.codeAt(2, 'recover', email);
  assert.equal((await adminAction('sign-out')).statusCode, 200);
  assert.equal((await claim(unused)).statusCode, 400);

  assert.deepEqual((await request()).json(), { ok: true });
  const emailed = await f.codeAt(3, 'recover', email);
  const emailClaim = await claim(emailed);
  assert.equal(emailClaim.statusCode, 200, emailClaim.body);
  assert.equal((await adminAction('sign-out')).statusCode, 200);
  assert.equal((await claim(emailed)).statusCode, 400);
  assert.equal((await complete(emailClaim.json().claim_id)).statusCode, 400);
  const hash = f.db.one('SELECT password_hash FROM users WHERE id=?', id)?.password_hash;
  assert.equal(await verifyPassword(hash, oldPassword), true);

  const issued = await adminAction('reset-password');
  assert.equal(issued.statusCode, 200, issued.body);
  const operatorClaim = await claim(issued.json().recovery_code);
  assert.equal(operatorClaim.statusCode, 200, operatorClaim.body);
  assert.equal((await adminAction('sign-out')).statusCode, 200);
  const completed = await complete(operatorClaim.json().claim_id);
  assert.equal(completed.statusCode, 200, completed.body);
});

test('email reset delivery may retry after a relay refusal and preserves a possibly delivered link', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.configure(true)).statusCode, 200);
  const email = 'retry@example.test';
  const id = 'relay-retry-account';
  f.db.run(
    'INSERT INTO users(id,username,created_at,email,email_verified_at) VALUES(?,?,0,?,?)',
    id,
    id,
    email,
    now(),
  );
  const anonymous = await f.bootstrap();
  const request = () => f.post('auth/recover/request', anonymous, { email });
  const pending = () => f.db.one('SELECT verifier FROM email_recovery_codes WHERE user_id=?', id);
  f.smtp.respondToData('reject');
  assert.deepEqual((await request()).json(), { ok: true });
  await waitFor(() => (f.smtp.completedData() === 1 && !pending() ? true : undefined));
  f.smtp.respondToData('disconnect');
  await request();
  await waitFor(() => (f.smtp.completedData() === 2 ? true : undefined));
  const prior = pending()?.verifier;
  assert.ok(prior);
  f.smtp.respondToData('accept');
  await request();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.smtp.completedData(), 2);
  assert.equal(pending()?.verifier, prior);
});

test('SMTP verifies the relay hostname and account mail shuts down with a stalled relay', async (t) => {
  const f = await fixture(t);
  const to = 'timeout@example.test';
  const controller = new AbortController();
  const message = { to, subject: 'Fixture', body: 'Fixture' };
  let sent = false;
  await assert.rejects(
    submitAccountMessage(
      { ...f.smtp.config, host: 'localhost' },
      message,
      controller.signal,
      () => true,
      () => {
        sent = true;
      },
    ),
  );
  assert.equal(sent, false);

  assert.equal((await f.configure(true)).statusCode, 200);
  f.smtp.stallGreeting();
  const before = f.smtp.connections();
  await f.register(to);
  await waitFor(() => (f.smtp.connections() > before ? true : undefined));
  const anonymous = await f.bootstrap();
  const submissions = Array.from({ length: 10 }, (_, index) => 'queued' + index + '@example.test');
  for (const [index, email] of submissions.entries()) {
    const id = 'queued-' + index;
    f.db.run(
      'INSERT INTO users(id,username,created_at,email,email_verified_at) VALUES(?,?,0,?,?)',
      id,
      id,
      email,
      now(),
    );
  }
  const responses = await Promise.all(
    submissions.map((email) => f.post('auth/recover/request', anonymous, { email })),
  );
  for (const response of responses) {
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), { ok: true });
  }
  await waitFor(() => (f.smtp.connections() === before + 2 ? true : undefined));
  assert.equal(f.db.one('SELECT COUNT(*) AS count FROM email_recovery_codes')?.count, 1);
  const started = Date.now();
  await f.app.close();
  assert.ok(Date.now() - started < 2000);
  assert.equal(f.smtp.delivered.length, 0);
});
