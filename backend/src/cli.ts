import { stdin, stdout } from 'node:process';
import { loadConfig } from './config.js';
import { Store, now } from './db.js';
import { hashPassword, token } from './security.js';
const [command, username] = process.argv.slice(2);
if (
  !['create-admin', 'reset-password'].includes(command) ||
  !username ||
  !/^[A-Za-z0-9_-]{3,32}$/.test(username)
)
  throw new Error('Usage: npm run cli -- create-admin|reset-password USERNAME');
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
