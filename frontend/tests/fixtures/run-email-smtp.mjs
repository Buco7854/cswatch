import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { appendFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:tls';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const host = '127.0.0.1';
const appPort = 4493;
const smtpPort = 4494;
const origin = `http://${host}:${appPort}`;
const smtpUser = 'synthetic-mailer';
const smtpPassword = 'synthetic-loopback-credential';
const senderAddress = 'no-reply@example.test';

function smtpSink(cert, key, mailbox, sockets) {
  return createServer({ key, cert }, (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    socket.setTimeout(5000, () => socket.destroy());
    socket.setEncoding('ascii');
    let buffer = '';
    let data = null;
    let authenticated = false;
    let sender = false;
    let recipient = null;
    const send = (response) => socket.write(response + '\r\n');
    send('220 loopback synthetic QA only');
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > 16384 || (data?.length ?? 0) > 16384) return socket.destroy();
      for (let newline = buffer.indexOf('\r\n'); newline >= 0; newline = buffer.indexOf('\r\n')) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);
        if (data !== null) {
          if (line !== '.') {
            data += line.replace(/^\.\./, '.') + '\r\n';
            continue;
          }
          const [headers, ...body] = data.trimEnd().split('\r\n\r\n');
          if (!/^Content-Transfer-Encoding: base64$/im.test(headers)) return socket.destroy();
          const message = Buffer.from(body.join('\r\n\r\n'), 'base64').toString('utf8');
          const record = { recipient, message };
          data = null;
          recipient = null;
          sender = false;
          void appendFile(mailbox, JSON.stringify(record) + '\n', { mode: 0o600 }).then(
            () => send('250 stored in disposable mailbox'),
            () => socket.destroy(),
          );
        } else if (/^EHLO /i.test(line)) {
          send('250-loopback QA\r\n250 AUTH PLAIN');
        } else if (/^AUTH PLAIN /i.test(line)) {
          authenticated =
            Buffer.from(line.slice(11), 'base64').toString() === `\0${smtpUser}\0${smtpPassword}`;
          send(authenticated ? '235 authenticated' : '535 authentication failed');
        } else if (line === `MAIL FROM:<${senderAddress}>` && authenticated) {
          sender = true;
          send('250 accepted sender');
        } else if (/^RCPT TO:<[a-z0-9._+-]+@example\.test>$/i.test(line) && sender) {
          recipient = /<([^>]+)>/.exec(line)[1].toLowerCase();
          send('250 accepted test recipient');
        } else if (line === 'DATA' && recipient) {
          data = '';
          send('354 end with a dot');
        } else if (line === 'QUIT') {
          socket.end('221 goodbye\r\n');
        } else {
          send('550 unsupported by synthetic QA');
        }
      }
    });
  });
}

/** Start the production build and a non-forwarding authenticated SMTP sink on loopback. */
export async function withLoopbackEmail(run) {
  const runDir = await mkdtemp(join(tmpdir(), 'cswatch-email-qa-'));
  const dataDir = join(runDir, 'data');
  const assetsDir = join(runDir, 'maps');
  const mailbox = join(runDir, 'mail.jsonl');
  const key = join(runDir, 'loopback-key.pem');
  const cert = join(runDir, 'loopback-cert.pem');
  const sockets = new Set();
  let smtp;
  let app;
  let stopped;
  try {
    await Promise.all([mkdir(dataDir, { mode: 0o700 }), mkdir(assetsDir, { mode: 0o700 })]);
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-sha256',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=cswatch loopback test',
        '-addext',
        `subjectAltName=IP:${host}`,
        '-keyout',
        key,
        '-out',
        cert,
      ],
      { stdio: 'ignore' },
    );
    smtp = smtpSink(await readFile(cert), await readFile(key), mailbox, sockets);
    const listening = once(smtp, 'listening');
    smtp.listen(smtpPort, host);
    await listening;

    app = spawn(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `
      import { loadConfig } from './backend/dist/config.js';
      import { openStoreForStartup } from './backend/dist/db.js';
      import { openEncryptionKeyForStartup } from './backend/dist/encryption-key.js';
      import { createApp } from './backend/dist/server.js';
      const config = loadConfig();
      const db = openStoreForStartup(config.dataDir);
      openEncryptionKeyForStartup(config, db);
      const app = await createApp(config, db);
      await app.listen({ port: config.port, host: '${host}' });
      const shutdown = async () => { await app.close(); process.exit(0); };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
      process.once('disconnect', shutdown);
      process.send('ready');
    `,
      ],
      {
        cwd: repo,
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        env: {
          PATH: process.env.PATH,
          APP_URL: origin,
          PORT: String(appPort),
          COOKIE_SECURE: 'false',
          DATA_DIR: dataDir,
          FRONTEND_DIR: join(repo, 'frontend', 'dist'),
          MAP_ASSETS_DIR: assetsDir,
          ADMIN_USERNAME: 'e2e_instance_admin',
          ADMIN_PASSWORD: 'synthetic-instance-password-2026',
          MFA_REQUIRED_ROLES: 'admin',
          PUBLIC_ACCESS: 'true',
          REGISTRATIONS_ENABLED: 'true',
          STEAM_ENABLED: 'false',
          FACEIT_ENABLED: 'false',
          LOG_LEVEL: 'warn',
          SMTP_HOST: host,
          SMTP_PORT: String(smtpPort),
          SMTP_USERNAME: smtpUser,
          SMTP_PASSWORD: smtpPassword,
          SMTP_FROM: senderAddress,
          NODE_EXTRA_CA_CERTS: cert,
          EMAIL_DELIVERY_ENABLED: 'true',
        },
      },
    );
    stopped = once(app, 'exit');
    const [ready] = await Promise.race([
      once(app, 'message', { signal: AbortSignal.timeout(10_000) }),
      stopped.then(() => []),
    ]);
    assert.equal(ready, 'ready', 'the isolated production server failed to start');
    const config = await fetch(origin + '/api/config', { signal: AbortSignal.timeout(5000) }).then(
      (response) => response.json(),
    );
    assert.equal(config.email_delivery_enabled, true);
    return await run({ origin, mailbox });
  } finally {
    app?.kill();
    for (const socket of sockets) socket.destroy();
    smtp?.close();
    await stopped?.catch(() => {});
    await rm(runDir, { recursive: true, force: true });
  }
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await withLoopbackEmail(async ({ origin, mailbox }) => {
    const test = spawn(
      process.execPath,
      [
        'node_modules/@playwright/test/cli.js',
        'test',
        'email-account.spec.ts',
        '-g',
        'configured SMTP',
      ],
      {
        cwd: join(repo, 'frontend'),
        stdio: 'inherit',
        env: {
          ...process.env,
          E2E_SETUP: '',
          E2E_PRIVATE: '',
          E2E_BASE_URL: origin,
          E2E_EXISTING_SERVER: 'true',
          E2E_SMTP_MAILBOX: mailbox,
        },
      },
    );
    const [code] = await once(test, 'exit');
    return code ?? 1;
  });
}
