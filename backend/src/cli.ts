import { stdin, stdout } from 'node:process';
import { loadConfig } from './config.js';
import { Store, now } from './db.js';
import { changeEncryptionKey, forgetUnreadableSecrets } from './encryption-key.js';
import { hashPassword, token } from './security.js';

const usage = `Usage:
  node dist/cli.js create-admin|reset-password USERNAME
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
  // Accounts created through Steam carry their Steam name.
  if (!(command === 'create-admin' ? /^[A-Za-z0-9_-]{3,32}$/ : /^.{1,64}$/u).test(username))
    throw new Error(usage);
  const password = await secret('New password (12+ characters): '),
    confirmation = await secret('Confirm password: ');
  if (password.length < 12 || password.length > 128 || password !== confirmation)
    throw new Error('Passwords must match and contain 12–128 characters.');
  const c = loadConfig(),
    db = new Store(c.dataDir),
    hash = await hashPassword(password);
  db.transaction(() => {
    const u = db.one('SELECT id FROM users WHERE username=? COLLATE NOCASE', username);
    if (command === 'create-admin') {
      if (u) throw new Error('User exists; refusing to change privileges.');
      db.run('INSERT INTO users VALUES(?,?,?,?,?)', token().slice(0, 32), username, hash, 1, now());
    } else {
      if (!u) throw new Error('User not found.');
      db.run('UPDATE users SET password_hash=? WHERE id=?', hash, u.id);
      db.run('DELETE FROM sessions WHERE user_id=?', u.id);
    }
  });
  db.audit(null, command);
  db.close();
  console.log('Account updated.');
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
      if (changed) db.audit(null, 'encryption-key.changed');
      console.log(`Re-encrypted ${changed} saved secrets.`);
    } else {
      const count = forgetUnreadableSecrets(c, db, option === '--yes');
      if (option === '--yes' && count) db.audit(null, 'encryption-key.forgot');
      console.log(
        option === '--yes'
          ? `Removed ${count} saved secrets. Their members save their codes again.`
          : `${count} saved secrets cannot be opened with the current key. Add --yes to remove them.`,
      );
    }
  } finally {
    db.close();
  }
}

if (['create-admin', 'reset-password'].includes(command) && argument) await account(argument);
else if (
  command === 'encryption-key' &&
  ((argument === 'change' && option === undefined) ||
    (argument === 'forget' && [undefined, '--yes'].includes(option)))
)
  await encryption();
else throw new Error(usage);
