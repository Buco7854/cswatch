# Architecture

## Deployment and data flow

```mermaid
flowchart LR
 Browser[React + WebGL / 2D browser] --> Proxy[Operator HTTPS proxy]
 Proxy --> Web[Fastify web service]
 Web --> DB[(SQLite WAL)]
 Web --> Files[(Private demo volume)]
 Worker[CPU worker · no network] --> DB
 Worker --> Job[Private per-job input copy]
 Job --> Parser[Landlock + seccomp native parser child]
 Parser --> Validate[Bounded artifact/schema/quota validation]
 Validate --> Files
 Worker --> Speech[Optional separate CPU transcription worker]
 Speech --> Model[Read-only offline Whisper model]
 Speech --> Captions[Validated unique caption artifact]
 Captions --> Files
 S2V[Offline S2V + optimization] --> Maps[Operator-installed map / agent GLBs]
 Maps --> Web
```

The web process authenticates requests and streams uploads. It does not parse demos or decompress untrusted files. The worker atomically claims a queued row, copies its input into a random job directory, and starts the native parser through a required Linux Landlock/seccomp launcher. The child reads runtime code/libraries and reads/writes only its job. Database, other demos and provider environment are outside its boundary. Forks, network and process escape are denied; native threads remain usable. Unsupported kernels fail closed. Timeout/cancellation kills the process group before output validation. Container memory/process/CPU limits bound native allocations; V8 heap limits alone do not bound native memory.

The parent incrementally polls bounded scratch files, validates compressed artifacts and versioned domain shapes, copies accepted regular files into a pending directory, and promotes them only if the row still owns the processing state and output fits quotas. Summary comes from the validated manifest. Failed publication removes promoted fragments; housekeeping reclaims stale jobs. Polling leaves a disk-write race, so host filesystem quotas remain the hard disk boundary. See `parser-job.ts`, `replay.ts` and SECURITY.md.

One SQLite database and one local data volume make deployment and backup straightforward. This is a **single-host architecture**. Multiple workers can claim jobs, but share I/O and each need expansion/memory headroom. Do not mount SQLite on network storage or scale web replicas across hosts. A larger installation should replace the store with PostgreSQL, use object storage, and keep the replay/provider interfaces. No Redis is required for this release.

Queue states: `uploading → queued → processing → ready | failed`. Quotas reserve maximum upload size before accepting bytes, then record actual original size; prepared compressed output is added after success. Stale uploads expire. Interrupted parser jobs become failed after their deadline instead of endlessly retrying crash inputs. Failed originals remain until owner deletion or retention. Worker polling is two seconds; maintenance runs every minute.

## Replay contract

`shared/playback.d.ts` defines the version 1 rendering domain and version 2 streamed transport. Player IDs are strings; positions/angles use Source coordinates. The parser samples player state at 16 Hz from recorded 64 Hz demo ticks, and the renderer interpolates positions and shortest-angle yaw between adjacent samples. Events retain recorded ticks. Round starts/live starts/ends and timeout/freeze segments come from parsed events/game rules. Native rows are grouped/sorted explicitly. Grenade paths sample recorded projectiles; entity ID reuse is separated when there is a gap.

The server checks access independently on the manifest and every chunk. New output consists of `manifest.json.gz` and `chunks/<index>.json.gz`. The manifest retains global events/rounds/dead-time indexes, whole-match ticks and Source-coordinate world bounds. Each chunk has at most 480 new samples, one shared end frame and 80 preceding frames for five seconds of trail context. Trajectories include adjacent points. Global bounds prevent camera/radar shifts between slices.

`replay-cache.ts` keeps at most three decoded slices and two current requests, prefetches forward and cancels irrelevant transfers on seek. `useReplay.ts` owns polling, identity-safe lifecycle, initial/legacy loading, buffering and retry. The controller owns user time/camera decisions; playback pauses during buffering. `playback.ts` stays independent of Three.js and uses the global last tick for timeout skips. Limits are 4 MiB decoded per chunk, 16 MiB metadata, 512 MiB aggregate decoded chunks and 160 MiB stored output, validated before publication. Existing `playback.json.gz` version 1 data remains readable as a whole; re-upload prepares version 2. These bounds do not certify real-device performance.

Display settings live only in the browser. Account data, visibility, and notes stay on the server. The synthetic sample is deterministic and independent of database data. Its authored EN/FR subtitle preview is explicitly labeled, contains no recorded audio and never calls transcription APIs. The 2D position plot needs no map asset or WebGL. Its lack of map geometry is explicit.

Recorded input/economy fields are optional and accompanied by explicit capabilities. Optional native query groups fall back independently; unavailable input must not erase available money/equipment data. Button masks stay uint64 decimal strings. Key labels are conventional actions (WASD/ZQSD), not recovered physical bindings; input state is sampled at 16 Hz. `review-events.ts` groups recorded events and matches player IDs. `timeline.ts` projects events onto the whole-match or current-round axis; `ReplayTimeline` shares that axis with the native seek thumb, preserves exact event stems and exposes crowded markers through named menus. Scrubbing pauses playback and freezes round bounds during the drag. Compact 32 px event targets and 44 px scrub targets do not overlap; visual padding keeps the native thumb and event stems on one axis. Timeline settings use a native modal portalled into the viewer so fullscreen/hidden-dock behavior stays correct. `RoundEventReview` retains the full filtered detail list.

## Spectator HUD and operator artwork

`ReviewHud` positions independent inputs and equipment at the scene edges. The mouse sits between movement and action/modifier keys; optional source/raw details are controlled through Options. One right-side CT/T stack shows recorded weapons, utilities, health, armor, money and ammo, with side colors and only a selected-row highlight. It scrolls internally on compact screens; there are no inline display/collapse controls. Complete inventory lives in the Players drawer. `viewer-presentation.css` owns one palette per theme and the full-viewport composition, with a single 48 px overlay toolbar and flush playback deck. Language/theme/account/demo actions share Viewer menu; AccountMenu accepts supplemental actions without duplicating logout behavior.

`useViewerChrome.ts` separates persisted manual `controlsHidden` from transient playback idle hiding. Primary scene taps under 500 ms/8 px toggle visibility; movement, secondary pointers and canceled gestures prevent a tap. Three-second auto-hide is optional and does not interrupt floating surfaces, active gestures, buffering, panels or keyboard focus. Chrome fades with inert/ARIA state and keyboard recovery; mouse movement, H and Tab reveal it. Inputs, roster, radar, objectives and controls share visibility, while captions remain independent and reposition above the current deck safe area. Pausing restores transiently hidden controls. Mouse/input-details preferences default false; `autoHideControls` defaults true. H ignores text fields, managed menus and native/ARIA dialogs.

`review-prompts.ts` indexes global recorded events independently of current frame/trajectory chunks. Immutable observed-player IDs, known utility types, strict entity lifetimes and unambiguous owner matching associate actual detonation coordinates; bounded/dense or conflicting data suppresses suggestions. No chunk endpoint becomes a claimed landing. Binary clock lookup handles seeks. Optional `ReviewActions` live outside fading chrome. Actions are normal navigation: kill rewind only seeks/plays, while grenade viewing seeks/plays and centers the ordinary free camera. Current speed/selection are preserved; no temporary clip, end stop, saved return state or back button exists. Existing 2D stays 2D. A short-lived detonation annotation can expire without changing playback or the camera, and free-camera poses persist across ordinary mode changes.

`utility-state.ts` interpolates only between recorded projectile samples and builds analytical effects from actual event positions. Scene quality controls resolution/shadows/model tier; it never removes utility state. Projectiles render from their first sample even when path lines are disabled. The 2D plot renders the same projectile/effect concepts and keeps its no-map-geometry label. Automatic quality observes viewport/coarse-pointer changes. Caption overlay height is measured with ResizeObserver and shared through a safe-area variable, keeping optional input/roster/action surfaces above multilingual captions.

`objectives.ts` captures recorded arming, planted-fuse and defuse deadlines. Absolute server clocks are mapped through the actual `net_Tick` packet and recorded tick interval, not relative reader time or later explosion events. `objective-state.ts` compiles global snapshots/lifecycle events once and answers arbitrary seeks with binary lookup. It handles abort, death, round reset, partial metadata and recorded outcomes; a zero countdown never invents completion. Missing deadlines show elapsed time. `ObjectiveHud` renders actor/site/kit, icons and progress without announcing every timer update to screen readers.

`shared/equipment-icons.json` is the only equipment registry. The trusted `tools/assets/prepare-equipment.mjs` converts operator-exported drawing-only SVG to bounded PNG with source/output hashes. Game artwork stays outside Git and images. `/api/assets/equipment` exposes validated fixed filenames under the instance access policy; descriptor-anchored, no-follow Linux reads reject symlinks/hardlinks, malformed PNGs and unrecognized paths. A bounded cache is revalidated against file identity. The generic map server excludes this subtree. `ReviewEventGlyph` maps native demo kills to the circled crosshair and deaths to the skull; plant/defuse/explosion use distinct native HUD assets. `equipment-icons.ts` shares one local manifest across glyphs and accepts only exact same-origin registry URLs; there is no runtime CDN or arbitrary fetch.

## Communications and CPU subtitles

`communications.ts` uses the typed `cs2parser` reader inside the existing parser sandbox. One incremental entity world also observes C4 and player-controller state; only changed objective snapshots are retained, capped at 10,000. `voice-packets.ts` validates bounded Steam containers/CRC and raw Opus framing; unsupported data produces a capability/warning, never guessed speech. The manifest holds bounded text chat and communication status; chunks hold bounded voice packets with immutable speaker IDs and recorded times. `voice-playback.ts` decodes locally with trusted bundled libopus WASM, caps decoder/scheduling state, and resets scheduled audio on seeks/pauses. CSP permits WebAssembly compilation without permitting general JavaScript eval. Recorded communications share their demo's access policy.

Schema v4 adds an independent transcription state, start time, claim lease, byte count and artifact pointer. Optional `transcription-worker.ts` claims ready replay jobs without changing primary replay status. It copies validated slices, grants a dedicated model directory read-only, and starts `transcription-job.js` under the same kernel boundary. Local-only Whisper CPU inference groups bounded speaker utterances, suppresses silent input, detects or accepts a language, and emits timed cues. Parent validation checks bounds/speakers/content/size before publication. Unique `captions-<lease>.json.gz` artifacts and a transactional DB pointer prevent stale workers or rollback from replacing another result. Quotas include captions. Cancellation, graceful shutdown and stale/orphan cleanup preserve the ready replay.

`WORKER_ROLE=parse|transcription|all` separates scheduling; Compose uses a normal parser and an optional networkless transcription profile so long speech jobs do not delay uploads. Runtime model downloads/cloud fallback are disabled. `tools/transcription` prepares checksum-pinned weights and public speech fixtures offline from the application. `Communications.tsx` owns optional voice/chat/subtitle controls and caption polling; outputs are approximate and carry provenance. Text is rendered as text, never HTML. Encrypted or missing content stays unavailable.

## Rendering and S2V

S2V exports game content offline, using its CLI and the operator's installed game files. The preparation tool packs textures into GLBs, optimizes them, emits desktop/mobile variants, and records version/hash information. Export/optimization is CPU work, not real-time server rendering. Assets are installed by the operator, not uploaded through a public API.

The browser loads map geometry and applies replay positions. Standard glTF PBR differs from Source 2's shaders. S2V map export omits important lighting/sky information; the current renderer uses approximate ambient/directional lighting. Event-based smoke/fire geometry is an analytical overlay, not volumetric smoke or exact fire coverage. Optional agent models use cloned skeletons and generic deterministic clip selection. Exact character poses, weapon/viewmodel attachments, animation graphs, audio, and game effects require additional work.

Desktop/mobile quality controls adjust resolution/shadows and select the prepared map tier. This is not a hardware benchmark; test transfer size, memory, sustained frame rate, and thermal behavior on actual target devices.

## Accounts and providers

A user owns credentials, sessions, demos, and notes. `identities(provider, subject, user_id)` separates external identities from accounts. This supports adding identities without changing ownership or trusting display names. Only Steam is currently a social login provider; FACEIT is a linked data source verified through Steam.

Adding another login provider requires a provider adapter with fixed authorization/token/userinfo origins, state and PKCE where appropriate, exact redirect URI validation, a verified immutable subject, a new env/admin policy flag, and callback tests. Reuse session issuance and identity uniqueness. Never implement account merging by nickname or email. Extract the growing provider route registry before adding several providers; the current two adapters do not justify an elaborate plugin framework.

Steam uses verified OpenID assertions. FACEIT Data API supplies profiles/history, and approved Downloads API supplies signed demo URLs. Downloads accept only authenticated upstream resource URLs on restricted HTTPS provider hosts, with no redirects. User input is a match ID. Steam next-match discovery returns share codes, not demo files; resolving/download access through Steam's Game Coordinator is not implemented.

## API shape

- `/api/config`, `/api/health`: non-secret instance config/health.
- `/api/auth/*`: local accounts, Steam, session management, password change.
- `/api/demos`: streamed uploads and paginated own/public lists.
- `/api/demos/:id`: detail, owner rename/visibility/delete.
- `/api/demos/:id/playback`: authorized prepared replay.
- `/api/demos/:id/playback/chunks/:index`: authorized version 2 time slice.
- `/api/demos/:id/captions`: authorized caption status/artifact; `/captions/retry` is owner-only with CSRF/origin/rate policy.
- `/api/demos/:id/bookmarks`, `/api/bookmarks/:id`: private notes.
- `/api/connections/*`: Steam discovery and verified FACEIT imports.
- `/api/maps/:name`, `/api/assets/agents`: installed asset discovery.
- `/api/assets/equipment`, `/api/assets/equipment/:filename`: private-policy-aware equipment registry and validated operator PNGs.
- `/api/admin`: admin-only policy, recent accounts, queue counts, audit events.

All API errors return a safe `detail`; raw provider responses, tokens, and native parser exceptions are not exposed. Unknown API paths return 404, never the SPA shell. Frontend routes fall back to the app shell after instance access policy checks.

## Public/product routing and localization

The public shell serves `/`, `/features/viewer`, `/features/imports`, and `/self-host`. The workspace serves `/library`, `/explore` and account routes. `WorkspaceShell` owns work navigation; `AccountMenu` contains account, connections and administration. `/account/connections` is canonical; `/connections` redirects. The whole-tab viewer has a separate shell. `docs/product/UX.md` is the route/access authority. Private mode may serve the generic frontend shell for a useful sign-in gate; content APIs and map/agent files remain authenticated independently.

Steam auth state stores an allowlisted local `return_to` path (schema v2). The callback does not accept an arbitrary redirect origin. Local authentication preserves the current route, so an upload intent returns to the library and focuses the import control. Viewer links carry a local origin context for returning to landing/explore/library.

`frontend/src/i18n.ts` owns language persistence, locale selection and translation. Catalogs use English source messages as keys with key/namespace separators disabled. Dynamic user content is not translated. Add both catalogs; `check:locales` and catalog/placeholder tests catch omissions. Public/member components share `Brand.tsx` and semantic tokens. `public.css` owns approved marketing composition; `member.css` scopes member/viewer styling over legacy foundations in `styles.css`/`workspace.css`. `Controls.tsx` and `member-controls.css` own accessible menus/selects; portals stay inside native dialogs/fullscreen and own their theme tokens. Delete obsolete selectors rather than stack more overrides.

## Provider downloads

`remote-download.ts` implements restricted provider resources with an exact host policy, conservative public DNS validation, one pinned TLS address, no redirects and streaming byte/time bounds. FACEIT selects authenticated upstream resources by match ID. There is no arbitrary client URL fetch endpoint or HLTV scraping/catalog wrapper; external demos use normal file uploads.
