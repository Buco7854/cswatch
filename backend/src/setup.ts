import {
  constants,
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { Store, now } from './db.js';
import {
  digest,
  equal,
  hashPassword,
  HttpError,
  newSession,
  rateLimit,
  token,
} from './security.js';

const adminCredentials = z.object({
  username: z.string().regex(/^[A-Za-z0-9_-]{3,32}$/),
  password: z.string().min(12).max(128),
});
export const setupRequired = (db: Store) =>
  !db.one('SELECT id FROM users WHERE is_admin=1 LIMIT 1');

/** Operator provisioning is creation-only. Restarting must never reset credentials. */
export async function provisionAdmin(db: Store, c: Config) {
  if (!c.adminUsername && !c.adminPassword) return;
  const credentials = adminCredentials.parse({
    username: c.adminUsername,
    password: c.adminPassword,
  });
  if (!setupRequired(db)) return;
  const hash = await hashPassword(credentials.password);
  db.transaction(() => {
    if (!setupRequired(db)) return;
    if (db.one('SELECT id FROM users WHERE username=? COLLATE NOCASE', credentials.username))
      throw new Error('The configured administrator username is already in use.');
    const id = token().slice(0, 32);
    db.run('INSERT INTO users VALUES(?,?,?,?,?)', id, credentials.username, hash, 1, now());
    db.audit(id, 'instance.admin_provisioned');
  });
}

export function prepareSetup(db: Store) {
  const path = join(db.root, 'setup-token');
  if (!setupRequired(db)) {
    db.run('DELETE FROM instance_setup');
    try {
      unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return;
  }
  const code = token();
  try {
    writeFileSync(path, code + '\n', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let saved: string;
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0 || info.size > 128)
      throw new Error('The setup token file must be a private regular file.');
    saved = readFileSync(fd, 'utf8').trim();
  } finally {
    closeSync(fd);
  }
  if (!/^[a-f0-9]{64}$/.test(saved)) throw new Error('The setup token file is invalid.');
  db.transaction(() => {
    if (!setupRequired(db)) return;
    const current = db.one('SELECT token_hash FROM instance_setup WHERE id=1');
    if (current && !equal(current.token_hash, digest(saved)))
      throw new Error('The setup token does not match its stored verifier.');
    db.run('INSERT OR IGNORE INTO instance_setup(id,token_hash) VALUES(1,?)', digest(saved));
  });
}

export async function setupRoutes(app: FastifyInstance, db: Store, c: Config) {
  app.post('/api/setup', async (request, reply) => {
    if (!setupRequired(db)) throw new HttpError(409, 'Instance setup is already complete.');
    rateLimit(db, request, 'instance-setup', 5, 900);
    const body = adminCredentials
      .extend({ setupToken: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict()
      .parse(request.body);
    const verifier = db.one('SELECT token_hash FROM instance_setup WHERE id=1');
    if (!verifier || !equal(verifier.token_hash, digest(body.setupToken)))
      throw new HttpError(403, 'Setup code is invalid.');
    const hash = await hashPassword(body.password);
    const id = token().slice(0, 32);
    db.transaction(() => {
      if (!setupRequired(db)) throw new HttpError(409, 'Instance setup is already complete.');
      const current = db.one('SELECT token_hash FROM instance_setup WHERE id=1');
      if (!current || !equal(current.token_hash, digest(body.setupToken)))
        throw new HttpError(403, 'Setup code is invalid.');
      if (db.one('SELECT id FROM users WHERE username=? COLLATE NOCASE', body.username))
        throw new HttpError(409, 'That username is unavailable.');
      db.run('INSERT INTO users VALUES(?,?,?,?,?)', id, body.username, hash, 1, now());
      db.run('DELETE FROM instance_setup');
      db.audit(id, 'instance.configured');
    });
    try {
      unlinkSync(join(db.root, 'setup-token'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        request.log.warn('Completed setup token file could not be removed.');
    }
    const csrf = newSession(db, c, request, reply, id);
    reply.code(201);
    return { user: { id, username: body.username, is_admin: true, csrf } };
  });
}
