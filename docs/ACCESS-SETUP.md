# Instance enrollment and temporary guest uploads

An instance with no administrator exposes only health, non-secret configuration, authentication status and setup APIs until enrollment completes. The frontend routes to setup. Registration, normal sign-in, uploads, replay APIs and provider APIs cannot bypass first-run enrollment.

At web startup, `ADMIN_USERNAME` and `ADMIN_PASSWORD` can create the first administrator. Both must be set together. Username and password validation match local account rules, including the 12-character password minimum. An existing administrator is never renamed or reset from environment values. If the requested name already belongs to a non-admin account, startup fails rather than taking that account over.

Without those environment values, the web service creates a random 256-bit one-time code at `DATA_DIR/setup-token`, normally `/data/setup-token` in Compose. The file is created exclusively with mode 0600 under the private data directory. Opening rejects symlinks, nonregular files, multiple hardlinks, excessive size and public permissions, using nonblocking/no-follow reads. SQLite retains only the code's SHA-256 verifier.

The operator can read the code with:

```sh
docker compose exec web cat /data/setup-token
```

Submit username, password and that code through the setup page. The server requires exact Origin, rate limits failed attempts, validates the code before expensive hashing, then atomically rechecks that no administrator exists and consumes the verifier while creating the account. Competing enrollment requests cannot create two first administrators. Successful enrollment issues a normal authenticated session and removes the code file. The code is never returned by an API or logged.

## Guest upload policy

`GUEST_UPLOADS_ENABLED` overrides the matching admin policy when set. Its default is true, but anonymous uploading is effective only on an initialized public instance. Disabling public access or guest uploads revokes guest replay reads as well as new uploads. Explicit shared-ID member demos remain independent of this guest feature. No public demo catalog exists.

`POST /api/guest/session` creates an opaque capability cookie and returns its CSRF token and expiry. It does not create a login, password, provider identity or authenticated account session. Internally a temporary owner principal reuses the same private demo foreign keys and quota pipeline. These principals cannot authenticate and are excluded from the administrator's account list. The capability cookie is HttpOnly, SameSite Lax, host-only and Secure with the `__Host-` prefix on HTTPS deployments. Only its SHA-256 digest is stored.

Guest uploads use the ordinary streamed `.dem` / `.dem.zst` route with exact Origin and guest CSRF. Missing or mismatched capability cookies cannot access their metadata, manifests, chunks or captions. Guest files stay private and cannot be published, renamed or used for personal account notes. Demo URLs alone are insufficient authorization. A visitor can delete their own completed guest demo with the same capability and CSRF checks.

Limits are independent of member uploads:

- `GUEST_RETENTION_HOURS` defaults to 24 and accepts 1 to 168 hours. Reusing a session does not extend its expiry.
- `GUEST_DEMO_LIMIT` defaults to 3. The visitor quota and a separate per-IP upload rate limit apply before accepting upload bytes.
- `GUEST_STORAGE_MB` defaults to 512. The advertised upload limit, stream limit and reservation use the smaller of this value and `MAX_UPLOAD_MB`. Prepared replay and subtitle publication also enforce the guest storage quota.
- At most 4096 guest sessions may exist at a time. Session creation is IP-rate-limited, and all uploads still consume global storage and CPU/parser bounds.

Each read checks capability expiry immediately. Worker maintenance deletes expired temporary owners, demo rows and files. A worker must be running for ingestion and storage reclamation. Expired browser cookies are not renewed implicitly, and missing capability data is never reconstructed from a filename, demo URL, nickname or account display name.

`/api/auth/me` exposes `guest_session: {csrf, expires_at} | null` separately from `user`. `/api/config` includes `setup_required`, effective `guest_uploads_enabled` and `guest_retention_hours`, without enrollment codes or administrator credentials.
