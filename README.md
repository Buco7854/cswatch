# cswatch

A self-hosted Counter-Strike 2 demo review room. TypeScript, React, Three.js, Fastify, a durable SQLite queue, and a separate CPU parser worker. Desktop, touch, and keyboard/remote navigation. No GPU required on the server. No bundled reverse proxy.

**Current release: working review application, with an asset-dependent 3D renderer.** Uploads and parsing are real. The bundled training courtyard is an original scene with synthetic data, clearly marked in the UI. Full Source 2 visual parity is not implemented. See [feature status](docs/STATUS.md) before deploying or describing the renderer.

## Product and navigation

The public landing page is `/`, with dedicated `/features/viewer`, `/features/imports`, and `/self-host` pages. `/explore` lists explicitly shared demos. `/library` is the member's private workspace; `/connections`, `/account`, and `/admin` expose only the appropriate account/role capabilities. Account-required actions preserve a safe local destination through authentication. Private instances replace public/product entry with a branded sign-in gate and also block anonymous content APIs and map assets.

English and French are available throughout the public site, viewer, account flows and administration. The initial language follows the browser; the language control and theme choice persist on the device. User-entered names and protocol/game identifiers are not translated. `npm run check:locales` checks literal message coverage and the tests check catalog/placeholder parity.

Product decisions and follow-up tasks live in [the product brief](docs/product/BRIEF.md), [UX/access contract](docs/product/UX.md), [brand system](docs/product/BRAND.md), and [active work](docs/product/WORK.md). Start with [the handoff](docs/HANDOFF.md) when continuing the project.

## Docker deployment

Requirements: Docker with Compose, a CPU supporting the native parser, storage for demos/assets, and your own HTTPS reverse proxy. Budget approximately 2 CPU cores and 6–8 GB RAM for the two services. Limits are configurable; these are deployment defaults, not benchmark guarantees.

```sh
cp .env.example .env
# Edit APP_URL to your public HTTPS origin.
docker compose up -d --build
docker compose exec web node dist/cli.js create-admin YOUR_USERNAME
```

The command prompts for a password without echoing it. There is no default password, automatic first-user admin, or public bootstrap endpoint. It refuses to promote an existing account. Create the operator account before allowing registrations.

Point your proxy at `127.0.0.1:8000`. Preserve the original `Host` header, terminate HTTPS, allow requests up to `MAX_UPLOAD_MB` plus multipart overhead, and allow long uploads. The application validates `Host` and request `Origin` against `APP_URL`. Set `TRUSTED_PROXY_IPS` to your proxy's exact address/CIDR only if it should supply client IPs. Never trust all proxy sources on a publicly reachable listener. For a proxy in another container, join a shared Docker network and remove the loopback port publishing only if needed.

Both web and worker must run. Data is stored in the named volume `cswatch_cswatch-data`. The worker has no network, and both services run as a non-root user with dropped capabilities, read-only root filesystems, memory/CPU/process limits, and `no-new-privileges`. Uploads and prepared playback stay private until their owner explicitly shares them.

### Instance policy

These variables accept `true`, `false`, or an empty/unset value:

| Variable                | Default when unset | Behavior                                                                                                         |
| ----------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `PUBLIC_ACCESS`         | `true`             | Anonymous browsing of sample and shared demos. `false` gates demo content and assets behind sign-in.             |
| `REGISTRATIONS_ENABLED` | `true`             | Local registrations and creation of new accounts through Steam. Existing users can still sign in.                |
| `STEAM_ENABLED`         | `false`            | Steam OpenID sign-in and account linking.                                                                        |
| `FACEIT_ENABLED`        | `false`            | Steam-verified FACEIT profile linking, match history, and approved imports. This is not a FACEIT login provider. |

Explicit environment values take precedence and lock the corresponding admin controls. Empty variables let the administrator change policy in the UI. API keys are environment-only and are never returned to the browser. To run a closed private instance, disable **both** public access and registrations.

### Identity providers

Steam OpenID verifies a Steam ID without collecting Steam passwords. Enable `STEAM_ENABLED=true`; a Steam Web API key is only needed for next-match share-code discovery. Discovery also requires the member's game authentication code and a prior match sharing code, used only for that request. Steam sign-in does not grant access to demo download URLs. Download a match in CS2 and upload its file.

For FACEIT, set `FACEIT_API_KEY`. Linking looks up the FACEIT CS2 account matching the user's verified Steam ID. History comes from the official Data API. Automatic imports additionally require a separately approved `FACEIT_DOWNLOAD_TOKEN`; ordinary Data API access is insufficient. Only FACEIT match IDs are accepted, never arbitrary remote download URLs. If approval is unavailable, manual uploads work.

Accounts use usernames, not email addresses. There is no email verification or email password reset flow. Operators can reset a password through a terminal:

```sh
docker compose exec web node dist/cli.js reset-password USERNAME
```

Resetting invalidates existing sessions. Signed-in users can change/set their own passwords in Account settings. The identity table supports multiple provider identities per user without merging accounts by display name or email. See [architecture](docs/ARCHITECTURE.md) for adding future providers.

### Limits and retention

`.env.example` lists limits for file size, expanded size, per-user storage/count, global storage, processing time, memory, and sessions. Defaults accept `.dem` and `.dem.zst` up to 512 MB, with a 2 GB expansion cap. Demo originals and compressed playback count toward storage. Concurrent uploads reserve their maximum size atomically. Leave additional disk headroom for one expanded demo per worker, parser output, SQLite, logs, and operator-installed maps. Limits are application quotas, not filesystem quotas.

`RETENTION_DAYS=30` deletes old demos and their notes automatically. `0` disables expiry. The UI states the retention policy. Audit events expire after 90 days. Back up the **whole data volume**, including SQLite and its WAL files, originals, prepared playback, and maps. Stop both services before a filesystem backup/restore; restart both afterward. A database-only backup will not include demo files. Keep backups outside the live data volume.

## Map and agent assets

[S2V / Source 2 Viewer](https://s2v.app/) exports CS2 content to glTF. The optional [asset preparation tools](tools/assets/README.md) run offline on a CPU, pack self-contained GLBs, create desktop/mobile map tiers, and record provenance. Install results into `/data/maps`. No .NET runtime or CS2 installation is needed by the web service itself.

The browser discovers installed map assets by demo map name. Without a matching model it displays an explicitly labeled position view. Optional CT/T agent GLBs support generic time-sampled idle/movement/crouch animation; exact animation graphs, weapon attachments, and first-person weapon rendering are not complete. Source 2 lighting and volumetric effects are not preserved automatically by glTF export. No Valve content is bundled or redistributed by this repository.

## Development

Use Node 24 LTS and npm. Node 22.13+ can run most of the app, but Node 24 is the supported CI/container target. Development is on the **same origin**; serve the built frontend from Fastify to exercise real authentication and security headers.

```sh
npm ci
npm ci --prefix backend
npm ci --prefix frontend
npm ci --prefix tools/assets
npm run build
cd backend
APP_URL=http://localhost:8000 COOKIE_SECURE=false npm start
# In another terminal, from backend/:
APP_URL=http://localhost:8000 COOKIE_SECURE=false npm run worker
```

The local data directory defaults to `../var` relative to `backend/`. Environment files are not loaded implicitly by application code; export variables in your shell, use Node's `--env-file`, or use Docker Compose's `env_file`. For hot UI development, Vite's proxy is available; use `APP_URL=http://localhost:5173` for the backend so origin/host validation matches the browser. Do not weaken production checks for development.

```sh
node scripts/fetch-test-demo.mjs   # checksum-pinned public upstream Mirage fixture
npm test                         # security, replay logic, .dem and .dem.zst parsing
npm run test:e2e                  # public journeys; uses an isolated test server
E2E_PRIVATE=1 E2E_REGISTRATIONS=false npm run test:e2e
E2E_PRIVATE=1 E2E_REGISTRATIONS=true npm run test:e2e
npm run test:visual               # optional rendered EN/FR × light/dark viewport matrix
npm run format:check
```

Playwright needs Chromium: `cd frontend && npx playwright install chromium`. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` for an existing executable. `E2E_EXISTING_SERVER=true E2E_BASE_URL=http://localhost:8000` uses a running instance. By default the browser tests start an isolated server on port 4174 with a fresh temporary database, so rate limits and test accounts cannot affect your preview data. Tests use temporary data and synthetic/explicit upstream fixtures; never point tests at production.

## Updates

The GitHub workflow tests/builds on PRs and main pushes, and runs **every Monday**. After verification it rebuilds the container without cache, pulls the current Node/Debian base, and publishes to `ghcr.io/OWNER/REPOSITORY` on main. The workflow includes a container health smoke test. Publishing requires the repository's Actions token to have package write access. Repository permissions and GHCR visibility are operator-controlled.

Dependabot opens weekly dependency and base/action update PRs; locked npm dependencies change through reviewed PRs. A weekly rebuild alone does not upgrade a lockfile. Versioned image tags contain the commit and workflow run number. Scheduled builds do **not** automatically replace a running self-hosted deployment.

```sh
# Build from source with current base images:
docker compose build --pull --no-cache
docker compose up -d
```

For published images set `CSWATCH_IMAGE=ghcr.io/OWNER/REPOSITORY:TAG`, then use `docker compose pull` and `docker compose up -d --no-build`. Back up data before upgrades. The versioned schema includes an additive v2 migration for safe authentication return paths. Future changes must use explicit migrations.

## Project guide

Start with [AGENTS.md](AGENTS.md), [architecture](docs/ARCHITECTURE.md), [security](SECURITY.md), [feature status](docs/STATUS.md), and [verification record](docs/VERIFICATION.md). The repository's existing license is retained in [LICENSE](LICENSE).
