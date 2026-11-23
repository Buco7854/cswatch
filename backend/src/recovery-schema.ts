export const recoverySchema = `
  CREATE TABLE password_resets (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    verifier TEXT UNIQUE NOT NULL,
    claim_id TEXT UNIQUE NOT NULL DEFAULT (lower(hex(randomblob(16)))),
    generation INTEGER NOT NULL,
    email_revision INTEGER,
    expires_at INTEGER NOT NULL,
    claimed_by TEXT REFERENCES sessions(id) ON DELETE CASCADE
  );
  CREATE UNIQUE INDEX password_resets_claim ON password_resets(claimed_by) WHERE claimed_by IS NOT NULL;
  CREATE INDEX password_resets_expiry ON password_resets(expires_at);
  CREATE TABLE recovery_receipts (
    browser_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    user_id TEXT UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    claim_hash TEXT NOT NULL,
    attempt_hash TEXT NOT NULL,
    generation INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX recovery_receipts_expiry ON recovery_receipts(expires_at);
`;
