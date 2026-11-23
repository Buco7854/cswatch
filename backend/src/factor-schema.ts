export const factorsSchema = `
  CREATE TABLE auth_passkeys(
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    public_key BLOB NOT NULL,
    counter INTEGER NOT NULL CHECK(counter BETWEEN 0 AND 4294967295),
    device_type TEXT NOT NULL CHECK(device_type IN ('singleDevice','multiDevice')),
    backed_up INTEGER NOT NULL CHECK(backed_up IN (0,1)),
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  ) STRICT;
  CREATE INDEX auth_passkeys_user ON auth_passkeys(user_id);
  CREATE TABLE auth_passkey_enrollments(
    session_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
    attempt_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    retain_until INTEGER NOT NULL,
    nonce TEXT,
    challenge_hash TEXT,
    id TEXT,
    name TEXT,
    public_key BLOB,
    counter INTEGER,
    device_type TEXT,
    PRIMARY KEY(session_hash,attempt_hash),
    CHECK((nonce IS NULL)=(challenge_hash IS NULL)),
    CHECK(id IS NULL OR (nonce IS NOT NULL AND name IS NOT NULL AND public_key IS NOT NULL
      AND counter IS NOT NULL AND device_type IS NOT NULL))
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX auth_passkey_enrollments_retention ON auth_passkey_enrollments(retain_until);
  CREATE TABLE auth_totp(
    user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    encrypted_secret BLOB NOT NULL,
    last_step INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE auth_otp_clock(
    user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    next_at_ms INTEGER NOT NULL,
    last_checked_ms INTEGER NOT NULL DEFAULT 0
  ) STRICT;
  CREATE TABLE auth_otp_pacing(
    session_hash TEXT PRIMARY KEY NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    address_hash TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    expires_at_ms INTEGER NOT NULL,
    UNIQUE(user_id,address_hash)
  ) STRICT;
  CREATE INDEX auth_otp_pacing_address ON auth_otp_pacing(address_hash);
  CREATE INDEX auth_otp_pacing_expiry ON auth_otp_pacing(expires_at_ms);
  CREATE TABLE auth_recovery_codes(
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(user_id,code_hash)
  ) STRICT, WITHOUT ROWID;
  CREATE TABLE auth_passkey_challenges(
    session_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
    purpose TEXT NOT NULL CHECK(purpose IN ('login','challenge','step-up')),
    challenge_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY(session_hash,purpose)
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX auth_passkey_challenges_expiry ON auth_passkey_challenges(expires_at);
  CREATE TABLE auth_totp_enrollments(
    session_hash TEXT PRIMARY KEY NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    enrollment_hash TEXT NOT NULL,
    encrypted_secret BLOB NOT NULL,
    expires_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX auth_totp_enrollments_expiry ON auth_totp_enrollments(expires_at);
`;
