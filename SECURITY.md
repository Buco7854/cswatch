# Security model

Report a vulnerability privately to the repository maintainer using GitHub private vulnerability reporting when available. Do not include real session cookies, provider tokens, or private demos in public issues.

## Implemented controls

- Argon2id password hashing; 12–128-character passwords; no default/admin bootstrap password.
- Random, server-side sessions with SHA-256 token digests in SQLite. HttpOnly, SameSite=Lax, Secure cookies in production. Rotation on login and password changes; revocation on reset/logout.
- Exact Host/Origin validation. CSRF tokens on authenticated unsafe requests. No permissive CORS. Restrictive CSP, clickjacking protection, MIME sniffing prevention, no-referrer policy, and HSTS on HTTPS.
- Per-user ownership checks; private-by-default demos; user-private notes; explicit public sharing; private-instance middleware covers playback and map assets.
- Atomic quota reservation, random storage paths, format signatures, bounded streaming uploads, capped decompression/output, bounded native parser processes, and retention.
- Persistent rate limits for authentication, registration, uploads, notes, and provider requests. Proxy IPs are trusted only when configured explicitly.
- Fixed-origin Steam assertion verification, state-cookie binding, one-use state, signed identity checks, nonce age check, and no nickname-based ownership/merging.
- Server-only provider credentials. Restricted authenticated upstream download URLs, public DNS checks, HTTPS, no redirects, time and size bounds. No general-purpose URL fetch endpoint.
- Non-root Docker runtime, read-only root, capability drop, no-new-privileges, process/CPU/memory limits; no worker network.
- Weekly CI image rebuild, dependency update PRs, production npm audit, and security boundary tests.

## Boundaries and remaining risks

This code has not had an independent security audit or penetration test. Do not describe it as proven secure solely because these controls and tests exist.

The native parser is a substantial attack surface. A child process limits crashes and event-loop blocking but **is not a filesystem sandbox**: the worker and its children can access the mounted demo/database volume. For hostile large public deployments, isolate each parser job in a dedicated container/sandbox with only its own job directory mounted, no network/secrets/database, and per-job cgroup limits. The current Docker worker has no network and a memory limit, but shares the application's data volume. A native exploit could therefore affect stored data. Treat parser/library updates as high priority.

Use a maintained HTTPS reverse proxy, disk monitoring/filesystem quotas, host patches, backups, and edge request limits. Keep the web listener private to the proxy. Multiple users behind a single untrusted proxy address share IP limits until trusted proxies are configured. IP limits alone do not stop distributed abuse; larger public deployments may need registration verification/CAPTCHA and an abuse process.

Application storage quotas are not hard filesystem quotas. Expanded scratch files, originals, prepared output, database/WAL, and map assets require extra disk headroom. Container memory limits can kill the worker; interrupted jobs become failed after restart/maintenance. Monitor queue failures and restarts. Use one parser worker initially.

There is no MFA, email verification/reset, arbitrary admin account management, session inventory UI, or automatic moderation. Account recovery is operator-assisted. Shared demos contain player names/Steam IDs and positions; owners must understand what publishing exposes. Revoking visibility prevents subsequent authorized downloads but cannot erase copies already downloaded. No raw demo downloads are exposed by the app.

The worker is intentionally network-isolated; S2V conversion is operator-only. Do not expose conversion tools or install arbitrary user-supplied maps through a public endpoint. Only install assets you trust. External model URLs are excluded by both policy and CSP.

GitHub scheduled rebuilds update base image packages but do not change pinned application dependencies without a lockfile update. Review/merge dependency PRs and redeploy updated images. Image scanning and SBOM/provenance help assessment; they do not prove vulnerability absence.
