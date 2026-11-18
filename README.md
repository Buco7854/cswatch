# cswatch

A self-hosted Counter-Strike 2 demo review room. TypeScript, React, Three.js, Fastify, a durable SQLite queue, and a separate CPU parser worker. Desktop, touch, and keyboard/remote navigation. No GPU required on the server. No bundled reverse proxy.

**Current release: working review application, with an asset-dependent 3D renderer.** Uploads and parsing are real. The bundled training courtyard is an original scene with synthetic data, clearly marked in the UI. Full Source 2 visual parity is not implemented. See [feature status](docs/STATUS.md) before deploying or describing the renderer.

## Product and navigation

Logged-out visitors get one compact upload page at `/`. When guest uploads are enabled, they can upload and watch their own private, temporary demo without an account. Signed-in visits to `/` go straight to `/library`. There are no marketing subpages or community catalogue. Explicit shared demo links remain available. Account and connected services live in the user menu at `/account` and `/account/connections`; `/connections` redirects there. `/admin` is administrator-only. Account-required actions preserve a safe local destination through authentication. Private instances replace public/product entry with a branded sign-in gate and also block anonymous content APIs and map assets.

The viewer takes the whole browser tab. Its in-view controls include cameras, player selection, round/event/timeout navigation, private notes and display options. On phones, secondary actions sit in **More controls**, with primary touch targets at least 44 pixels. Browser fullscreen is an additional option.

English and French are available throughout the public site, viewer, account flows and administration. The initial language follows the browser; the language control and theme choice persist on the device. User-entered names and protocol/game identifiers are not translated. `npm run check:locales` checks literal message coverage and the tests check catalog/placeholder parity.

Product decisions and follow-up tasks live in [the product brief](docs/product/BRIEF.md), [UX/access contract](docs/product/UX.md), [brand system](docs/product/BRAND.md), and [active work](docs/product/WORK.md). Start with [the handoff](docs/HANDOFF.md) when continuing the project.

## Docker deployment

Requirements: Docker with Compose on Linux with Landlock ABI 3 or newer (kernel 6.2+ with Landlock enabled), a CPU supporting the native parser, storage for demos/assets, and your own HTTPS reverse proxy. Budget approximately 2 CPU cores and 6–8 GB RAM for the two services. Limits are configurable; these are deployment defaults, not benchmark guarantees.

Compose uses the published `ghcr.io/buco7854/cswatch:latest` image for web, parsing and optional transcription. Set `CSWATCH_IMAGE` to pin a different tag or digest. A source checkout/build is not required for deployment; use `compose.yaml` and `.env.example` from this repository.

```sh
cp .env.example .env
# Edit APP_URL to your public HTTPS origin.
docker compose pull
docker compose run --rm worker ./dist/parser-sandbox --check
docker compose up -d
```

On a new instance, open the app and follow `/setup`. Retrieve the private one-time code with `docker compose exec web cat /data/setup-token`, then create the administrator. Registrations, sign-in and uploads remain closed until setup completes. Alternatively set both `ADMIN_USERNAME` and `ADMIN_PASSWORD` in `.env` before starting. They create the first administrator only and never reset an existing account. There is no default password or first-visitor takeover. See [first-run and guest access](docs/ACCESS-SETUP.md). The terminal `create-admin` command remains available for operators.

Point your proxy at `127.0.0.1:8000`. Preserve the original `Host` header, terminate HTTPS, allow requests up to `MAX_UPLOAD_MB` plus multipart overhead, and allow long uploads. The application validates `Host` and request `Origin` against `APP_URL`. Set `TRUSTED_PROXY_IPS` to your proxy's exact address/CIDR only if it should supply client IPs. Never trust all proxy sources on a publicly reachable listener. For a proxy in another container, join a shared Docker network and remove the loopback port publishing only if needed.

Both web and worker must run. Data is stored in the named volume `cswatch_cswatch-data`. The worker has no network, and both services run as a non-root user with dropped capabilities, read-only root filesystems, memory/CPU/process limits, and `no-new-privileges`. Uploads and prepared playback stay private until their owner explicitly shares them.

Each native parser child additionally runs inside a required Landlock/seccomp sandbox. It receives only its job copy and read-only runtime libraries; it cannot read the application database, other demos or provider secrets. Unsupported kernels fail closed. `PARSER_SANDBOX=off` is an explicit escape hatch for **trusted local development**, never public uploads. The small compiled C launcher is a Linux security bridge; application code remains TypeScript. See [the security boundary](SECURITY.md).

### Instance policy

These variables accept `true`, `false`, or an empty/unset value:

| Variable                | Default when unset | Behavior                                                                                                         |
| ----------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `PUBLIC_ACCESS`         | `true`             | Anonymous entry and explicitly shared demo links. `false` gates demo content and assets behind sign-in.          |
| `GUEST_UPLOADS_ENABLED` | `true`             | Private temporary uploads without an account. Effective only on initialized public instances.                    |
| `REGISTRATIONS_ENABLED` | `true`             | Local registrations and creation of new accounts through Steam. Existing users can still sign in.                |
| `STEAM_ENABLED`         | `false`            | Steam OpenID sign-in and account linking.                                                                        |
| `FACEIT_ENABLED`        | `false`            | Steam-verified FACEIT profile linking, match history, and approved imports. This is not a FACEIT login provider. |
| `TRANSCRIPTION_ENABLED` | `false`            | Optional offline CPU speech transcription with a prepared local model and the transcription worker.              |

Explicit environment values take precedence and lock the corresponding admin controls. Empty variables let the administrator change policy in the UI. API keys are environment-only and are never returned to the browser. To run a closed private instance, disable **both** public access and registrations.

### Identity providers

Steam OpenID verifies a Steam ID without collecting Steam passwords. Enable `STEAM_ENABLED=true`; a Steam Web API key is only needed for next-match share-code discovery. Discovery also requires the member's game authentication code and a prior match sharing code, used only for that request. Steam sign-in does not grant access to demo download URLs. Download a match in CS2 and upload its file.

For FACEIT, set `FACEIT_API_KEY`. Linking looks up the FACEIT CS2 account matching the user's verified Steam ID. History comes from the official Data API. Automatic imports additionally require a separately approved `FACEIT_DOWNLOAD_TOKEN`; ordinary Data API access is insufficient. Only FACEIT match IDs are accepted, never arbitrary remote download URLs. If approval is unavailable, manual uploads work.

### Premier, Competitive and externally downloaded demos

The Add demo dialog includes focused Steam, FACEIT and HLTV download/import guides. Premier, Competitive and Wingman replay files use the same CS2 parser. Obtain the replay at its source, extract `.bz2`, `.gz` or archives on your device when necessary, then upload `.dem` or `.dem.zst`. Steam OpenID alone does not download demos. There is no HLTV scraper, match catalog or proxy wrapper.

Accounts use usernames, not email addresses. There is no email verification or email password reset flow. Operators can reset a password through a terminal:

```sh
docker compose exec web node dist/cli.js reset-password USERNAME
```

Resetting invalidates existing sessions. Signed-in users can change/set their own passwords in Account settings. The identity table supports multiple provider identities per user without merging accounts by display name or email. See [architecture](docs/ARCHITECTURE.md) for adding future providers.

### Recorded inputs, economy and communications

The default viewer remains focused on the match. Recorded inputs and the mouse diagram are separate options that default off. Switch Match / Round directly in the playback bar. More → Timeline options contains detailed filters. Phone display preferences are separate from desktop preferences. Tap the scene or press H to fade the viewing interface in/out; mouse movement and Tab restore it on desktop. Controls also fade after three seconds of playback unless disabled in Options. The scene fills the tab beneath a single 48 px overlay toolbar, with language/theme/account actions in Viewer menu. Phone playback keeps centered transport controls and direct range selection, while full round actions remain in More. Holding plain Tab opens the scoreboard outside typing, menu and modal contexts. Shift+Tab preserves backwards keyboard navigation. Selecting a player switches to their POV and briefly highlights the camera control. Free camera supports WASD and ZQSD, with E/C for vertical movement. Options alone control compact edge-based inputs and broadcast equipment overlays for recorded movement/actions, WASD or ZQSD key labels, available mouse counts, player money/equipment/inventory and status. ZQSD is the default display layout; saved WASD choices remain supported. Modifiers/actions sit below the movement keys, with the optional mouse alongside. These are sampled recorded actions, not the player's physical key bindings. Missing command data stays unavailable rather than being guessed from movement. The seek bar positions selected-player kills/deaths and bomb outcomes at recorded times, with explicit round zoom and accessible event clusters; utility throws are optional. Detailed review retains whole-match/player filters. Optional moment shortcuts offer a recorded grenade detonation view and rewinding to an observed-player kill. These are ordinary navigation actions: replay jumps back without changing view or speed, and grenade viewing jumps back into a free camera at the recorded detonation. Playback continues normally; 2D stays in 2D. Both shortcuts can be disabled independently in Options. Low rendering quality preserves recorded projectiles and utility effects; hiding flight paths never hides the projectile, and 2D includes utility primitives. On-screen planting/defuse/fuse progress uses recorded C4 server deadlines; missing timing shows elapsed rather than an assumed duration.

Communications has separate controls for recorded Opus voice, selected player/team/all speakers, volume and individual mutes, text chat and local speech subtitles. Voice decoding happens locally in the browser; no microphone access is requested. Some demos omit voice or use unsupported/encrypted communication data. cswatch cannot recover missing recordings or external Discord calls. Automatic subtitles can misrecognize speech. Sharing a demo also shares its recorded communications and captions; personal notes remain private.

Optional automatic subtitles use a small multilingual Whisper model **on the CPU**, in a separate durable sandboxed worker stage. The replay is watchable before transcription finishes; failure or timeout leaves the replay intact. Prepare the model using [the offline tooling](tools/transcription/README.md), then mount it read-only into the optional worker. For example, add `compose.override.yaml`:

```yaml
services:
  transcription:
    volumes:
      - /srv/cswatch-models/whisper-tiny:/models/whisper-tiny:ro
```

Set `TRANSCRIPTION_MODEL_DIR=/models/whisper-tiny` in `.env`, and enable `TRANSCRIPTION_ENABLED=true` (or its unlocked admin setting). Start the optional service with `docker compose --profile transcription up -d`. The main worker handles parsing; the transcription service has its own CPU/memory limits and no network. Allow additional RAM/CPU for simultaneous processing; the default transcription container limit is 4 GB, on top of normal web/parser needs. Runtime inference never downloads a model or sends audio to a service.

`TRANSCRIPTION_LANGUAGE=auto` performs language identification; an explicit ISO language code is also accepted. `TRANSCRIPTION_MAX_AUDIO_SECONDS=600` bounds per-demo audio work, and `TRANSCRIPTION_TIMEOUT_SECONDS=600` bounds each job. Longer recordings can produce explicitly partial captions. Owners can retry failed subtitles from Communications after the operator resolves model/resources. Without Compose, `WORKER_ROLE=parse|transcription|all` selects duties; the local default is `all`.

### Crosshairs and processing failures

Options offers your own device-local custom crosshair or the observed player's recorded share code. Supported static geometry is decoded locally. Missing codes, invalid data and unsupported styles stay unavailable. Dynamic native spread/recoil and scoped rendering are not reproduced. The decoder's MIT license is shipped with the app.

Failed demo details show a safe failure code and demo reference. Worker logs emit a structured `demo_processing_failed` event with processing stage and available child exit/signal or whitelisted sandbox diagnostics. Raw native output and private paths are not logged. A code such as `sandbox_unavailable` requires fixing the host confinement support, never disabling it for public uploads.

### Limits and retention

`.env.example` lists limits for file size, expanded size, per-user storage/count, global storage, processing time, memory, and sessions. Defaults accept `.dem` and `.dem.zst` up to 512 MB, with a 2 GB expansion cap. Demo originals and compressed playback count toward storage. Concurrent uploads reserve their maximum size atomically; prepared output must also fit the quotas before publication. Leave additional disk headroom for each job's input copy, expanded demo, parser output, SQLite, logs, and operator-installed maps. Limits and scratch polling are application controls, not hard filesystem quotas.

New replays use versioned time slices with five seconds of trail context. The browser keeps at most three cached chunks and prefetches the next, while the timeline and event/round indexes cover the whole match. Chunk JSON is capped at 4 MiB, metadata at 16 MiB, decoded output at 512 MiB and stored output at 160 MiB. Legacy version 1 replays remain readable but still load as a whole; re-upload to prepare the new format.

Guest uploads expire after `GUEST_RETENTION_HOURS` (default 24), with separate `GUEST_DEMO_LIMIT` (3) and `GUEST_STORAGE_MB` (512) limits. Only the original browser capability cookie grants access, and expired guests are reclaimed by worker maintenance. Account login does not silently transfer guest ownership.

`RETENTION_DAYS=30` deletes old demos and their notes automatically. `0` disables expiry. The UI states the retention policy. Audit events expire after 90 days. Back up the **whole data volume**, including SQLite and its WAL files, originals, prepared playback, and maps. Stop all services, including optional transcription, before a filesystem backup/restore; restart them afterward. A database-only backup will not include demo files. Keep backups outside the live data volume.

## Map and agent assets

Demos contain recorded match state, not level geometry. Installing cswatch alone provides a position-only fallback. Actual 3D maps require an operator-prepared map pack; a proper 2D map and radar require a calibrated overview image. Game assets are not included in Git or the container image.

Map names are discovered from the recording rather than a fixed list in the viewer. This does not establish universal map compatibility. The selective installer supports maps present in its pinned official depot. Custom or Workshop content needs a local S2V export and manual preparation with its dependencies. Multi-floor radar layers are not supported yet. Verify each prepared map's alignment and rendering before enabling it for viewers.

[S2V / Source 2 Viewer](https://s2v.app/) exports a local CS2 installation's content to glTF. The [asset preparation tools](tools/assets/README.md) run offline on a CPU, pack self-contained GLBs, create desktop/mobile map tiers, and record provenance. Install results into `/data/maps`. S2V is a converter, not a map-download service. No .NET runtime, CS2 installation or server GPU is needed by the web service itself. The browser renders installed geometry.

The optional Linux x64 operator installer downloads explicit maps and their dependency chunks from Steam, prepares the verified tools, then exports both model tiers, a calibrated radar and the authored sky/distant landscape. It does not install the whole game or require a Steam user login. Run it separately from the web/worker services:

```sh
npm ci --prefix tools/assets
npm --prefix tools/assets run install-steam -- \
  --maps de_mirage,de_dust2,de_ancient,de_cache \
  --output /srv/cswatch/maps --cache /srv/cswatch-asset-cache
```

See the [operator guide](tools/assets/README.md) for tool pins, storage requirements and installation paths. Maps can still require several gigabytes of temporary space. The installer refuses to overwrite installed maps, processes them serially and stops if its free-space reserve is crossed. Keep the private source/tool cache outside the served map directory. Mount only the prepared output at `/data/maps`, or copy it into the persistent data volume.

The browser discovers installed map assets by demo map name. Automatic acquisition for an unknown uploaded map is a [proposed separate service](docs/product/MAP-ACQUISITION.md), not an enabled upload feature. The same operator workflow can prepare the actual CS2 weapon, utility, knife and kit icons: see [equipment artwork preparation](tools/assets/README.md#exact-equipment-silhouettes). Install that PNG pack under `/data/maps/equipment`; the HUD loads it locally and uses a labeled equipment fallback when absent. Game artwork is not bundled in Git or Docker. Without a matching model it displays an explicitly labeled position view. Prepared native weapon, grenade and C4 GLBs support static held/POV models and recorded world placements. The optional [model installer](tools/assets/README.md#static-weapon-grenade-and-c4-models) prepares fixed equipment selections and bounded CT/T agents from one native idle pose. Options → Performance reports ready, loading, unavailable and failed models. Hold/POV attachment presets remain approximate, without native arms, recoil or first-person animation. Other operator agent exports can use deterministic generic idle/movement/crouch clips. Source 2 lighting and volumetric effects are not preserved automatically by glTF export. No Valve content is bundled or redistributed by this repository.

## Development

Use Node 24 LTS and npm. Node 22.13+ can run most of the app, but Node 24 is the supported CI/container target. Building on Linux also requires a C compiler and libc headers for the sandbox (`build-essential` on Debian/Ubuntu); the Docker build provides these only in its build stage. Use Docker on other operating systems for untrusted parsing. Development is on the **same origin**; serve the built frontend from Fastify to exercise real authentication and security headers.

```sh
npm ci
npm ci --prefix backend
npm ci --prefix frontend
npm ci --prefix tools/assets
npm ci --prefix tools/transcription # optional speech verification tools
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
npm run test:assets               # operator asset acquisition, preparation and output contracts
node scripts/runtime-smoke.mjs    # upload → required sandbox → private chunks → notes/sharing
npm run test:e2e                  # public journeys; uses an isolated test server
E2E_PRIVATE=1 E2E_REGISTRATIONS=false npm run test:e2e
E2E_PRIVATE=1 E2E_REGISTRATIONS=true npm run test:e2e
npm run test:visual               # optional rendered EN/FR × light/dark viewport matrix
npm run format:check
```

Playwright needs Chromium: `cd frontend && npx playwright install chromium`. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` for an existing executable. `E2E_EXISTING_SERVER=true E2E_BASE_URL=http://localhost:8000` uses a running instance. By default the browser tests start an isolated server on port 4174 with a fresh temporary database, so rate limits and test accounts cannot affect your preview data. Tests use temporary data and synthetic/explicit upstream fixtures; never point tests at production.

## Updates

The GitHub workflow tests/builds on PRs and main pushes, and runs **every Monday**. After verification it rebuilds without cache, pulls the current Node/Debian base, and publishes to `ghcr.io/buco7854/cswatch` on main. It prepares checksum-pinned parser/speech fixtures, exercises actual offline English/French inference, and runs upload/ownership/parsing/transcription checks inside the hardened networkless image. Publishing requires the Actions token's package write access. Repository permissions and GHCR visibility are operator-controlled.

Dependabot opens weekly dependency and base/action update PRs; locked npm dependencies change through reviewed PRs. A weekly rebuild alone does not upgrade a lockfile. Versioned image tags contain the commit and workflow run number. Scheduled builds do **not** automatically replace a running self-hosted deployment.

```sh
docker compose pull
docker compose up -d
```

Include `--profile transcription` when enabled. Pin a published tag/digest through `CSWATCH_IMAGE` when needed. To build a local image explicitly from a source checkout:

```sh
docker build --pull --no-cache -t cswatch:local .
CSWATCH_IMAGE=cswatch:local docker compose up -d --pull never
```

Back up data before upgrades. Schema migrations are additive: safe auth return paths (v2), nullable import provenance (v3), separate transcription state/leases/artifact pointers (v4), and operator enrollment/temporary guest capabilities (v5). Production host-prefixed cookies require a fresh sign-in when upgrading from the initial proof of concept. Future changes must use explicit migrations.

## Project guide

Start with [AGENTS.md](AGENTS.md), [architecture](docs/ARCHITECTURE.md), [security](SECURITY.md), [feature status](docs/STATUS.md), and [verification record](docs/VERIFICATION.md). The repository's existing license is retained in [LICENSE](LICENSE).

The browser distribution includes the [csgo-sharecode MIT license](frontend/public/licenses/csgo-sharecode.txt) and the [Barlow Condensed](frontend/public/licenses/barlow-condensed.txt) and [IBM Plex Sans](frontend/public/licenses/ibm-plex-sans.txt) font licenses. Game artwork and demo recordings are excluded from Git and Docker build contexts.
