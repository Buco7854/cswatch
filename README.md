# cswatch

A self-hosted Counter-Strike 2 demo review room. TypeScript, React, Three.js, Fastify, a durable SQLite queue, and a separate CPU parser worker. Desktop, touch, and keyboard/remote navigation. No GPU required on the server. No bundled reverse proxy.

**Current release: working review application, with an asset-dependent 3D renderer.** Uploads and parsing are real. The bundled training courtyard is an original scene with synthetic data, clearly marked in the UI. Full Source 2 visual parity is not implemented. See [feature status](docs/STATUS.md) before deploying or describing the renderer.

## Product and navigation

Logged-out visitors get one compact upload page at `/`. When guest uploads are enabled, they can upload and watch their own private, temporary demo without an account. Signed-in visits to `/` go straight to `/library`. There are no marketing subpages or community catalogue. Sign-in and registration have dedicated `/login` and `/register` pages, with policy-aware links and a validated local return destination. Explicit shared demo links remain available. Account and connected services live in the user menu at `/account` and `/account/connections`; `/connections` redirects there. `/admin` is administrator-only. Private instances send anonymous visitors to sign-in and independently block anonymous content APIs and map assets.

The viewer takes the whole browser tab. Its in-view controls include cameras, player selection, round/event/timeout navigation, private notes and display options. On phones, secondary actions sit in **More controls**, with primary touch targets at least 44 pixels. Browser fullscreen is an additional option.

English and French are available throughout the public site, viewer, account flows and administration. The initial language follows the browser; the language control and theme choice persist on the device. User-entered names and protocol/game identifiers are not translated. `npm run check:locales` checks literal UI messages and stored worker errors and the tests check catalog/placeholder parity.

Product decisions and follow-up tasks live in [the product brief](docs/product/BRIEF.md), [UX/access contract](docs/product/UX.md), [brand system](docs/product/BRAND.md), and [active work](docs/product/WORK.md). Start with [the handoff](docs/HANDOFF.md) when continuing the project.

## Docker deployment

Requirements: Docker with Compose on Linux with Landlock ABI 3 or newer (kernel 6.2+ with Landlock enabled), a CPU supporting the native parser, storage for demos/assets, and your own HTTPS reverse proxy. Web and parsing need approximately 6–8 GB RAM together; native asset conversion has a separate 8 GiB container limit and can run concurrently. Allow host capacity for the work you enable. Limits are configurable deployment defaults, not benchmark guarantees.

Compose uses the published `ghcr.io/buco7854/cswatch:latest` image for web, parsing and optional transcription. Set `CSWATCH_IMAGE` to pin a different tag or digest. The map worker uses `ghcr.io/buco7854/cswatch:assets-latest`, independently pinned with `CSWATCH_ASSETS_IMAGE`. A source checkout/build is not required for deployment; use `compose.yaml` and `.env.example` from this repository.

```sh
cp .env.example .env
# Edit APP_URL to your public HTTPS origin.
docker compose pull web worker assets
docker compose run --rm worker ./dist/parser-sandbox --check
docker compose up -d web worker assets
```

On a new instance, open the app and follow `/setup`. Retrieve the private one-time code with `docker compose exec web cat /data/setup-token`, then create the administrator. Registrations, sign-in and uploads remain closed until setup completes. Alternatively set both `ADMIN_USERNAME` and `ADMIN_PASSWORD` in `.env` before starting. They create the first administrator only and never reset an existing account. There is no default password or first-visitor takeover. See [first-run and guest access](docs/ACCESS-SETUP.md). The terminal `create-admin` command remains available for operators.

Point your proxy at `127.0.0.1:8000`. Preserve the original `Host` header, terminate HTTPS, allow requests up to `MAX_UPLOAD_MB` plus multipart overhead, and allow long uploads. The application validates `Host` and request `Origin` against `APP_URL`. Set `TRUSTED_PROXY_IPS` to your proxy's exact address/CIDR only if it should supply client IPs. Never trust all proxy sources on a publicly reachable listener. For a proxy in another container, join a shared Docker network and remove the loopback port publishing only if needed.

Web, parser `worker` and the separate long-running `assets` service start in the normal stack. Automatic map acquisition remains an independent policy that defaults off. The assets service refreshes official metadata and prepares optional native artwork/sounds; it does not receive application data or credentials. Data is stored in the named volume `cswatch_cswatch-data`. The parser has no network. Services run as a non-root user with dropped capabilities, read-only root filesystems, memory/CPU/process limits and `no-new-privileges`. Uploads and prepared playback stay private until their owner explicitly shares them.

Each native parser child additionally runs inside a required Landlock/seccomp sandbox. It receives only its job copy and read-only runtime libraries; it cannot read the application database, other demos or provider secrets. Unsupported kernels fail closed. `PARSER_SANDBOX=off` is an explicit escape hatch for **trusted local development**, never public uploads. The small compiled C launcher is a Linux security bridge; application code remains TypeScript. See [the security boundary](SECURITY.md).

### Instance policy

These variables accept `true`, `false`, or an empty/unset value:

| Variable                     | Default when unset | Behavior                                                                                                                  |
| ---------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `PUBLIC_ACCESS`              | `true`             | Anonymous entry and explicitly shared demo links. `false` gates demo content and assets behind sign-in.                   |
| `GUEST_UPLOADS_ENABLED`      | `true`             | Private temporary uploads without an account. Effective only on initialized public instances.                             |
| `REGISTRATIONS_ENABLED`      | `true`             | Local registrations and creation of new accounts through Steam. Existing users can still sign in.                         |
| `STEAM_ENABLED`              | `false`            | Steam OpenID sign-in and account linking.                                                                                 |
| `FACEIT_ENABLED`             | `false`            | Steam-verified FACEIT profile linking, match history, and approved imports.                                               |
| `TRANSCRIPTION_ENABLED`      | `false`            | Optional offline CPU speech transcription with a prepared local model and the transcription worker.                       |
| `AUTO_OFFICIAL_MAPS_ENABLED` | `false`            | Prefer approved map sources, otherwise prepare a disclosed latest official snapshot. Requires the separate asset service. |

Explicit environment values take precedence and lock the corresponding admin controls. Empty variables let the administrator change policy in the UI. API keys are environment-only and are never returned to the browser. To run a closed private instance, disable **both** public access and registrations.

### Steam and FACEIT

Steam OpenID verifies a Steam ID. Enable `STEAM_ENABLED=true`. Match sync uses the operator’s application key, the member’s game authentication code and a recent match sharing code. Open the discovered match in CS2, download it and upload its file. [Provider setup](docs/ACCESS-SETUP.md#steam-and-faceit)

For FACEIT, enable `FACEIT_ENABLED` and configure a server-side `FACEIT_API_KEY`. Members can browse pages of their CS2 history after verifying their Steam association. Importing each recording requires their participation in the match and a separately approved `FACEIT_DOWNLOAD_TOKEN`. [Provider setup](docs/ACCESS-SETUP.md#steam-and-faceit)

### Premier, Competitive and externally downloaded demos

Obtain Premier, Competitive and Wingman replays in CS2, or download other replays from their FACEIT or HLTV match pages. Extract `.bz2`, `.gz` or archives on your device when necessary, then use Add a demo to upload `.dem` or `.dem.zst`. Use Connected accounts for Steam match history and configured FACEIT imports. Steam OpenID alone does not download demos. There is no HLTV scraper, match catalog or proxy wrapper.

Accounts use usernames, not email addresses. There is no email verification or email password reset flow. Operators can reset a password through a terminal:

```sh
docker compose exec web node dist/cli.js reset-password USERNAME
```

Resetting invalidates existing sessions. Signed-in users can change/set their own passwords in Account settings. Login rechecks credentials after password verification, and password changes recheck the initiating session and credentials after hashing, so a concurrent reset or logout cannot revive stale authority. The identity table supports multiple provider identities per user without merging accounts by display name or email. See [architecture](docs/ARCHITECTURE.md#accounts-and-providers) for provider identity rules.

### Recorded inputs, economy and communications

A finished demo opens on the first recorded live round in a living player’s POV. Deep links and a position saved in the current tab take precedence. The default vertical FOV is 73.74°. Wide views show both teams’ loadouts, an enlarged radar, the score and the current round’s kill and utility tabs. Phones use separate preferences and keep Players one tap away. Recorded inputs and the mouse diagram are separate options that default off. Switch Match / Round directly in the playback bar. Replay tools → Timeline options contains event filters and the round-strip switch. Tap the scene or press H to fade the interface in or out. Mouse movement and Tab restore it on desktop. Enable the idle fade in Options to hide controls after three seconds of playback. The scene fills the tab beneath a single 48 px overlay toolbar, with language/theme/account actions in Viewer menu. Phone playback keeps centered transport controls and direct range selection, while full round actions remain in More. Holding plain Tab opens the scoreboard outside typing, menu and modal contexts. Shift+Tab preserves backwards keyboard navigation. Selecting a player switches to their POV and briefly highlights the camera control. Free camera supports WASD and ZQSD, with E/C for vertical movement. Options alone control compact edge-based inputs and broadcast equipment overlays for recorded movement/actions, WASD or ZQSD key labels, available mouse counts, player money/equipment/inventory and status. ZQSD is the default display layout, with WASD available in Options. Modifiers/actions sit below the movement keys, with the optional mouse alongside. These are sampled recorded actions, not the player's physical key bindings. Missing command data stays unavailable rather than being guessed from movement. The seek bar positions selected-player kills/deaths and bomb outcomes at recorded times, with explicit round zoom and accessible event clusters; utility throws are optional. Detailed review retains whole-match/player filters. Optional moment shortcuts offer a recorded grenade detonation view and rewinding to an observed-player kill. These are ordinary navigation actions: replay jumps back without changing view or speed, and grenade viewing jumps back into a free camera at the recorded detonation. Playback continues normally; 2D stays in 2D. Both shortcuts can be disabled independently in Options. Low rendering quality preserves recorded projectiles and utility effects; hiding flight paths never hides the projectile, and 2D includes utility primitives. On-screen planting/defuse/fuse progress uses recorded C4 server deadlines; missing timing shows elapsed rather than an assumed duration.

Communications has separate controls for recorded Opus voice, selected player/team/all speakers, volume and individual mutes, text chat and local speech subtitles. Voice decoding happens locally in the browser; no microphone access is requested. Some demos omit voice or use unsupported/encrypted communication data. cswatch cannot recover missing recordings or external Discord calls. Automatic subtitles can misrecognize speech. Sharing a demo also shares its recorded communications and captions; personal notes remain private.

Gameplay sound is separate from recorded voice. Options → Sound controls shots, exact recorded surface-footstep cues, reload actions, grenades, bomb actions and round cues, with master/game volume, mute and approximate positional audio. A user gesture enables the browser's shared audio context. Voice and gameplay have separate channels, and seeking, pausing or changing demos cancels old scheduled sounds. Missing events or local samples stay unavailable. Footsteps are not generated from movement, and reload audio is not inferred from ammunition changes.

The long-running `assets` service prepares a fixed bank of 116 native samples from a pinned official Steam source when its map queue is idle, after its smaller landing-artwork task. This does not require recordings or account credentials in that service. Pull and start its separate image with `docker compose pull web worker assets` followed by `docker compose up -d web worker assets`, or use the [operator sound installer](tools/assets/README.md#native-gameplay-sounds). Game audio needs the prepared bank and newly processed replay sound evidence. Exact recorded event names and positions do not reproduce native random sample variations, wall acoustics, persistent loops or the complete Source 2 mix. No game audio is bundled in Git or images.

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

Prepared replays use a version 3 manifest and time slices with five seconds of trail context. The browser keeps at most three cached chunks and prefetches the next, while the timeline and event/round indexes cover the whole match. Chunk JSON is capped at 4 MiB, metadata at 16 MiB, decoded output at 512 MiB and stored output at 160 MiB. Prepare a replay by uploading its source recording.

Guest uploads expire after `GUEST_RETENTION_HOURS` (default 24), with separate `GUEST_DEMO_LIMIT` (3) and `GUEST_STORAGE_MB` (512) limits. Only the original browser capability cookie grants access, and expired guests are reclaimed by worker maintenance. Account login does not silently transfer guest ownership.

`RETENTION_DAYS=30` deletes old demos and their notes automatically. `0` disables expiry. The UI states the retention policy. Audit events expire after 90 days. Back up the **whole application data volume**, including SQLite/WAL files, originals and prepared playback. Also preserve the separate map-assets, map-jobs and map-catalog volumes. The private map-cache can be rebuilt and need not be backed up. Stop all services, including optional transcription and assets, before a filesystem backup/restore. A database-only backup omits demo files. Keep backups outside live volumes.

## Map and agent assets

Demos contain recorded match state, not level geometry. Actual 3D maps require a prepared map pack. A calibrated overview provides a useful 2D view and radar when 3D is unavailable. If neither is usable, the viewer explains that the map is unavailable instead of displaying players without a map. Game assets are not included in Git or the container image.

Map names are discovered from the recording rather than a fixed list in the viewer. This does not establish universal map compatibility. The selective installer supports maps present in its pinned official depot. Custom or Workshop content needs a local S2V export and manual preparation with its dependencies. Multi-floor radar layers are not supported yet. Verify each prepared map's alignment and rendering before enabling it for viewers.

[S2V / Source 2 Viewer](https://s2v.app/) exports CS2 content to glTF. The [asset preparation tools](tools/assets/README.md) run on a CPU, pack self-contained GLBs, create desktop/mobile map tiers, and record provenance. Compose mounts prepared output at `/map-assets`; standalone deployments default to `DATA_DIR/maps`. No .NET runtime, CS2 installation or server GPU is needed by the web service itself. The browser renders installed geometry.

The optional Linux x64 operator installer downloads explicit maps and their dependency chunks from Steam, prepares the verified tools, then exports both model tiers, a calibrated radar and the authored sky/distant landscape. It does not install the whole game or require a Steam user login. Run it separately from the web/worker services:

```sh
npm ci --prefix tools/assets
npm --prefix tools/assets run install-steam -- \
  --maps de_mirage,de_dust2,de_ancient,de_cache \
  --output /srv/cswatch/maps --cache /srv/cswatch-asset-cache
```

See the [operator guide](tools/assets/README.md) for tool pins, storage requirements and installation paths. Maps can still require several gigabytes of temporary space. The installer refuses to overwrite installed maps, processes them serially and stops if its free-space reserve is crossed. Keep the private source/tool cache outside the served map directory. Mount only the prepared output at `MAP_ASSETS_DIR`: `/map-assets` in Compose or `DATA_DIR/maps` by default in standalone deployments.

Optional [automatic map preparation](docs/MAP-ASSETS.md) prefers a unique operator-approved source, then offers a clearly labeled latest official snapshot when a reliable historical selection is unavailable. The separate worker periodically discovers current official map names from fixed Steam metadata, so an empty catalog and newly shipped official map names need no manual mapping. The viewer shows the selected manifest and check time. It does not claim that latest geometry matches the original recording.

Enable `AUTO_OFFICIAL_MAPS_ENABLED` in the environment or unlocked admin policy to allow map acquisition. The assets service already runs in the normal stack. Owner/guest authorization, Origin/CSRF, request rates, queue limits, pinned sources and resource budgets apply. Explicit addons, conflicting map evidence and unrecognized official names are blocked. Source integrity failures do not silently choose another version. Conversion subprocesses have no network and can write only their stage. The parser stays networkless and receives no asset-service volumes or credentials. Optional catalog approvals remain available for established historical sources, while manual map-name packs remain explicitly version-unverified. See [map identity and provenance](docs/product/MAP-ACQUISITION.md) for the exact selection rules.

The assets service must remain running to refresh official metadata and process new requests. Its image is separate from the web image, so update both. Administration shows automatic-policy state, worker availability, official-list freshness, historical-catalog status and safe inventory failure stage/code/retry time. An empty historical catalog does not prevent latest Ancient or another listed official map. A missing worker or missing/stale list has its own explanation. An open viewer checks bootstrap availability for at most 45 minutes and requests an eligible source once it becomes available; it does not retry failed conversions automatically. See [setup and troubleshooting](docs/MAP-ASSETS.md#readiness-and-troubleshooting).

When the asset queue is idle, the same service can selectively prepare the fixed official 720p Mirage screenshot used behind the public upload entry. Both S2V decoding and Sharp normalization run in confined conversion children. Existing operator previews are preserved, and missing or failed artwork leaves the page usable. No map screenshot is included in Docker or loaded from a remote image service. This decorative preview does not establish a matching 3D map version.

The same operator workflow prepares actual CS2 weapon, utility, knife and kit icons: see [equipment artwork preparation](tools/assets/README.md#exact-equipment-silhouettes). Install PNGs under `MAP_ASSETS_DIR/equipment`. The HUD uses local assets and a labeled fallback when absent. Native weapon, grenade and C4 GLBs support held/POV models and recorded world placements. The optional [model installer](tools/assets/README.md#static-weapon-grenade-and-c4-models) prepares fixed equipment selections and the 87-clip directional CT/T bank. Recorded movement, aim and available action evidence drive agent poses at absolute demo time. Held equipment follows the native weapon bone when available. Agent poses approximate the native animation graph. Optional first-person rigs include authored hands and weapon clips. Recorded shots drive optional analytical muzzle flashes and a small weapon kick, with reduced-motion support. First-person equipment has independent depth so nearby walls cannot cut through it. An authored muzzle attachment anchors the flash when available. Missing attachment data uses model bounds. Native x-ray follows the posed character mesh and preserves visible artwork. Static-map shadows are reused without freezing changing casters. Options → Performance reports asset availability and provenance. Source 2 lighting, materials and volumetric effects remain approximations. No Valve content is bundled or redistributed by this repository.

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

cswatch initializes its complete SQLite schema in an empty data directory. A server or worker pointed at an incompatible database exits with an instruction to use an empty data directory. Keep the original directory if you need to retain its contents.

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

The GitHub workflow tests/builds on PRs and main pushes, and runs **every Monday**. After verification it rebuilds without cache, pulls the current Node/Debian base, and publishes the application and separate assets images to `ghcr.io/buco7854/cswatch` on main. It prepares checksum-pinned parser/speech fixtures, exercises actual offline English/French inference, and runs upload/ownership/parsing/transcription checks inside the hardened networkless image. Publishing requires the Actions token's package write access. Repository permissions and GHCR visibility are operator-controlled.

Dependabot opens weekly dependency and base/action update PRs; locked npm dependencies change through reviewed PRs. Weekly rebuilds use the checked-in lockfiles. Versioned image tags contain the commit and workflow run number. Scheduled builds do **not** automatically replace a running self-hosted deployment.

```sh
docker compose pull web worker assets
docker compose up -d web worker assets
```

Keep the assets service running for metadata refresh and preparation. If using the optional transcription profile, update that service too:

```sh
docker compose --profile transcription pull web worker assets transcription
docker compose --profile transcription up -d web worker assets transcription
```

Pin published tags/digests through `CSWATCH_IMAGE` and `CSWATCH_ASSETS_IMAGE` when needed. CI labels both images with the full source revision and UTC build time. The web also reports validated immutable build-file fields in `/api/config` and Administration; runtime environment values do not replace them. Local builds without supplied identity report unknown fields. CI checks the running image against its expected source revision. A displayed revision identifies a build, not a passing workflow; verify that revision's workflow before release.

To build a local image explicitly from a source checkout:

```sh
docker build --pull --no-cache -t cswatch:local .
docker build --pull --no-cache --target assets -t cswatch:assets-local .
CSWATCH_IMAGE=cswatch:local CSWATCH_ASSETS_IMAGE=cswatch:assets-local docker compose up -d --pull never
```

Back up application data and operator-managed assets before replacing a deployment.

## Project guide

Start with [AGENTS.md](AGENTS.md), [architecture](docs/ARCHITECTURE.md), [security](SECURITY.md), [feature status](docs/STATUS.md), and [verification record](docs/VERIFICATION.md). The repository's existing license is retained in [LICENSE](LICENSE).

The browser distribution includes the [csgo-sharecode MIT license](frontend/public/licenses/csgo-sharecode.txt) and the [Barlow Condensed](frontend/public/licenses/barlow-condensed.txt) and [IBM Plex Sans](frontend/public/licenses/ibm-plex-sans.txt) font licenses. Game artwork and demo recordings are excluded from Git and Docker build contexts.

Steam and FACEIT use compact locally bundled Simple Icons glyphs (CC0-1.0), with visible localized action labels and shared theme colours. Source identities and trademark attribution are recorded in the shipped [provider brand notice](frontend/public/licenses/provider-brands.txt). These UI icons are separate from the unbundled Counter-Strike game artwork. FACEIT is available in Connected accounts for CS2 history and demo imports.
