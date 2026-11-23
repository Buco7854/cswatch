export const emailMailSchema = `
  CREATE TABLE IF NOT EXISTS email_verifications (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    verifier TEXT PRIMARY KEY NOT NULL,
    email_revision INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS email_verifications_user ON email_verifications(user_id,created_at);
  CREATE INDEX IF NOT EXISTS email_verifications_expiry ON email_verifications(expires_at);
  CREATE TABLE IF NOT EXISTS email_recovery_codes (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    verifier TEXT UNIQUE NOT NULL,
    generation INTEGER NOT NULL,
    email_revision INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS email_recovery_codes_expiry ON email_recovery_codes(expires_at);
`;
