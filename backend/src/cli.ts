import { accountEmail, accountName, accountPassword } from './credentials.js';
import { stdin, stdout } from 'node:process';
import { loadConfig } from './config.js';
import { Store, now } from './db.js';
import { changeEncryptionKey, forgetUnreadableSecrets } from './encryption-key.js';
import { requireAvailableEmail } from './email-identity.js';
import {
  canSignIn,
  signableAdminExists,
  hashPassword,
  revokeUserSessions,
  token,
} from './security.js';

import { issuePasswordReset } from './recovery.js';

const usage = `Usage:
  node dist/cli.js create-admin|reset-password|reset-factors USERNAME
  node dist/cli.js list-admins
  node dist/cli.js encryption-key change          re-encrypt saved data with the current key
  node dist/cli.js encryption-key forget [--yes]  remove saved data the current key cannot open`;
const [command, argument, option] = process.argv.slice(2);

async function secret(prompt: string): Promise<string> {
  if (!stdin.isTTY)
    throw new Error('A terminal is required. Passwords must not be passed as command arguments.');
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  let value = '';
  return new Promise((resolve, reject) => {
    function data(chunk: Buffer) {
      for (const char of chunk.toString()) {
        if (char === '\u0003') {
          cleanup();
          reject(new Error('Cancelled'));
          return;
        }
        if (char === '\r' || char === '\n') {
          cleanup();
          resolve(value);
          return;
        }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ') value += char;
      }
    }
    function cleanup() {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', data);
      stdout.write('\n');
    }
    stdin.on('data', data);
  });
}

async function account(username: string) {
  // Assigned sign-in names can exceed the input length for a new account.
  if (
    !(command === 'create-admin'
      ? accountName.safeParse(username).success
      : /^.{1,64}$/u.test(username))
  )
    throw new Error(usage);
  const c = loadConfig();
  const db = new Store(c.dataDir);
  try {
    let hash: string | null = null;
    let email: string | null = null;
    if (command === 'create-admin') {
      const password = await secret('New password (12+ characters): ');
      const confirmation = await secret('Confirm password: ');
      if (!accountPassword.safeParse(password).success || password !== confirmation)
        throw new Error('Passwords must match and contain 12–128 characters.');
      const address = (await secret('Email address (optional): ')).trim();
      if (address) {
        const result = accountEmail.safeParse(address);
        if (!result.success) throw new Error('Enter a valid email address.');
        email = result.data;
      }
      hash = await hashPassword(password);
    } else if (!stdout.isTTY) {
      throw new Error('Use an interactive terminal for account recovery.');
    }
    const recovery = db.transaction(() => {
      let code: string | undefined;
      let id: string;
      if (command === 'create-admin') {
        if (db.one('SELECT id FROM users WHERE username=?', username))
          throw new Error('This username is already in use.');
        if (email) requireAvailableEmail(db, email);
        id = token().slice(0, 32);
        db.run(
          "INSERT INTO users(id,username,password_hash,role,created_at,email) VALUES(?,?,?,'admin',?,?)",
          id,
          username,
          hash,
          now(),
          email,
        );
      } else {
        const user = db.one(
          'SELECT id FROM users u WHERE username=? AND NOT EXISTS(SELECT 1 FROM guest_sessions g WHERE g.owner_id=u.id)',
          username,
        );
        if (!user) throw new Error('User not found.');
        id = user.id;
        revokeUserSessions(db, id);
        if (command === 'reset-password')
          db.run('UPDATE users SET password_hash=NULL WHERE id=?', id);
        if (command === 'reset-factors') {
          db.run('DELETE FROM auth_passkeys WHERE user_id=?', id);
          db.run('DELETE FROM auth_totp WHERE user_id=?', id);
          db.run('DELETE FROM auth_recovery_codes WHERE user_id=?', id);
        }
        if (!signableAdminExists(db, c))
          throw new Error('Create another admin with a working sign-in before this reset.');
        if (command === 'reset-password' || !canSignIn(db, c, id))
          code = issuePasswordReset(db, id);
      }
      db.audit(null, 'cli.' + command, { target: id });
      return code;
    });
    if (recovery)
      console.log('Single-use password recovery code (expires in 10 minutes):', recovery);
    else console.log('Account updated.');
  } finally {
    db.close();
  }
}

async function encryption() {
  const c = loadConfig();
  const db = new Store(c.dataDir);
  try {
    if (argument === 'change') {
      const entered = stdin.isTTY
        ? await secret('Previous key (leave empty to use encryption.key): ')
        : '';
      if (entered && !/^[a-fA-F0-9]{64}$/.test(entered))
        throw new Error('A key has 64 hexadecimal characters.');
      const changed = changeEncryptionKey(c, db, entered ? Buffer.from(entered, 'hex') : undefined);
      console.log(`Re-encrypted ${changed} saved secrets.`);
    } else {
      const count = forgetUnreadableSecrets(c, db, option === '--yes');
      console.log(
        option === '--yes'
          ? `Removed ${count} unreadable secrets. Affected members can reconnect Steam or enrol an authenticator app again.`
          : `${count} saved secrets cannot be opened with the current key. Add --yes to remove them.`,
      );
    }
  } finally {
    db.close();
  }
}

if (command === 'list-admins' && !argument) {
  const db = new Store(loadConfig().dataDir);
  try {
    for (const user of db.all("SELECT username FROM users WHERE role='admin' ORDER BY username"))
      console.log(JSON.stringify(user.username));
  } finally {
    db.close();
  }
} else if (
  ['create-admin', 'reset-password', 'reset-factors'].includes(command) &&
  argument &&
  !option
)
  await account(argument);
else if (
  command === 'encryption-key' &&
  ((argument === 'change' && option === undefined) ||
    (argument === 'forget' && [undefined, '--yes'].includes(option)))
)
  await encryption();
else throw new Error(usage);
