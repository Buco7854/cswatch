# Security model

Report a vulnerability privately to the repository maintainer using GitHub private vulnerability reporting when available. Do not include real session cookies, provider tokens, or private demos in public issues.

## Implemented controls

- Argon2id password hashing; 12–128-character passwords; no default/admin bootstrap password.
- Random, server-side sessions with SHA-256 token digests in SQLite. HttpOnly, SameSite=Lax, Secure `__Host-` cookies in production for sessions and Steam state, preventing sibling-subdomain Domain cookie injection. Rotation on login and password changes; revocation on reset/logout. Private database/directory permissions.
- Exact Host/Origin validation. CSRF tokens on authenticated unsafe requests. No permissive CORS. Restrictive CSP, clickjacking protection, MIME sniffing prevention, no-referrer policy, and HSTS on HTTPS.
- Per-user ownership checks; private-by-default demos; user-private notes; explicit public sharing; private-instance middleware covers playback and map assets.
- Atomic quota reservation, random storage paths, format signatures, bounded streaming uploads, capped decompression/output, bounded native parser processes, and retention.
- Persistent rate limits for authentication, registration, uploads, notes, and provider requests. Proxy IPs are trusted only when configured explicitly.
- Fixed-origin Steam assertion verification, state-cookie binding, one-use state, signed identity checks, nonce age check, and no nickname-based ownership/merging.
- Server-only provider credentials. Restricted authenticated upstream download URLs, public DNS checks pinned on the actual TLS request, HTTPS, no redirects, time/size bounds and bounded provider JSON. No general-purpose URL fetch endpoint.
- Required per-job Linux Landlock/seccomp confinement inherited by native code. Read-only runtime libraries and isolated job files; no database, other demo, provider environment, network or subprocess access. Bounded artifact validation and quota checks before publication.
- Non-root Docker runtime, read-only root, capability drop, no-new-privileges, process/CPU/memory limits; no worker network.
- Isolated offline CPU transcription with read-only dedicated models, bounded Opus/utterance/output processing, lease-based publication and private caption access. Optional failure does not change primary demo readiness; retry requires ownership, Origin/CSRF and rate limits.
- Read-only equipment artwork endpoints use a fixed registry, private-instance access checks, descriptor-anchored filesystem reads and bounded PNG structure/CRC validation. The general map route excludes the equipment directory; no public SVG upload or conversion endpoint exists.
- Weekly CI image rebuild, dependency update PRs, production npm audit, and security boundary tests.

## Boundaries and remaining risks

This code has not had an independent security audit or penetration test. Do not describe it as proven secure solely because these controls and tests exist.

The native parser and model runtime remain substantial attack surfaces. Children are confined by Landlock ABI 3+ (Linux 6.2+ with Landlock enabled), plus seccomp restrictions for network, process escape/signals, metadata writes, ioctl, signal/lease-related fcntl operations, alternate syscall ABI and operations outside Landlock's filesystem mediation. The launcher fails closed on unsupported kernels or confinement errors. `PARSER_SANDBOX=off` is only for explicitly trusted local development; it restores shared-filesystem risk and must never process public uploads. Kernel/sandbox bugs remain possible; maintain both and prioritize native/parser/model-runtime updates. Separate per-job containers/cgroups may add defense for larger deployments.

Use a maintained HTTPS reverse proxy, disk monitoring/filesystem quotas, host patches, backups, and edge request limits. Keep the web listener private to the proxy. Multiple users behind a single untrusted proxy address share IP limits until trusted proxies are configured. IP limits alone do not stop distributed abuse; larger public deployments may need registration verification/CAPTCHA and an abuse process.

Application storage quotas and 500 ms bounded scratch polling are not hard filesystem quotas. A compromised child can grow files between polls; enforce host disk quotas. Job input copies, expanded files, originals, prepared output, database/WAL, and map assets need extra headroom. Container memory limits can kill the worker; interrupted jobs become failed and stale scratch is reclaimed. Monitor queue failures/restarts. Use one parser worker initially.

There is no MFA, email verification/reset, arbitrary admin account management, session inventory UI, or automatic moderation. Account recovery is operator-assisted. Shared demos contain player names/Steam IDs, positions and any extracted voice/chat/subtitles; publishing explicitly discloses this. Notes remain user-private. Revoking visibility prevents later downloads but cannot erase downloaded copies. No raw demo downloads are exposed.

Opus packets and speech outputs are untrusted. Parent schema/byte/time/identity validation bounds published artifacts; browser audio scheduling and decoder state are bounded. Bundled WASM requires CSP `wasm-unsafe-eval`; ordinary JavaScript `unsafe-eval` remains disabled. Chat/captions render as plain React text. Subtitles are model estimates, not verified statements. Runtime speech inference has no network and never sends recordings to a service. Install only trusted, dedicated operator-controlled model directories; never grant a general directory containing secrets or application data as a model root.

The worker is intentionally network-isolated; S2V conversion is operator-only. Do not expose conversion tools or install arbitrary user-supplied maps through a public endpoint. Only install assets you trust. External model URLs are excluded by both policy and CSP.

Equipment SVG conversion is also operator-only. Its source checks reject external resources, encoded references, CSS escapes, scripts, conflicting presentation declarations and symlinked files/ancestors before producing bounded PNGs; this is not a sandbox for arbitrary hostile artwork. Install trusted exports in the dedicated equipment directory. Proprietary game artwork is not committed or bundled, and the browser accepts only known same-origin raster paths from the equipment manifest.

GitHub scheduled rebuilds update base image packages but do not change pinned application dependencies without a lockfile update. Review/merge dependency PRs and redeploy. CI runs production npm audits and emits image SBOM/provenance; this is not an independent security audit or a guarantee of vulnerability absence.
