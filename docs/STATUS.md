# Feature status

This file is part of the product contract. Update it when implementation or verification changes.

## Implemented

- Distinct branded public landing, viewer/import feature pages, self-hosting page, public exploration and member library routes. Private-instance sign-in entry, policy-aware calls to action and safe auth return paths.
- English/French public/app copy, controls, dynamic states/errors, accessibility labels, localized dates/numbers/plurals, and persisted language selection. Shared dark/light identity and original replay mark.

- TypeScript Fastify backend, React app, shared replay types, SQLite/WAL durable queue and separate native parser process.
- Local username/password accounts; Steam OpenID login/linking; future-provider-friendly identity ownership table. Secure session/CSRF/origin/host policy, rate limits, private demos/notes, audited policy changes.
- `.dem` / `.dem.zst` uploads, magic validation, quotas, bounded decompression, processing status/failure UI, retention, owner rename/delete/share.
- Real parser adapter exercised on an upstream Mirage demo: players, position/angle/HP/armor/money/ammo/duck/flash state, events, rounds/live starts/ends, freeze/timeout flags, grenade trajectories.
- Browser orbit, overhead, player perspective, and 2D position modes; interpolation; timeline/seeking/speeds; round jumps; next live round; manual/automatic dead-time skipping; private timestamp notes.
- Progressive options: x-ray player shapes, centered perspective crosshair, position radar, elimination feed, movement trails, grenade paths, approximate utility zones, quality selection. Device-local persistence.
- Light/dark themes; responsive desktop/tablet/mobile layouts; focus-visible controls; keyboard/remote directional focus, shortcuts, touch orbit/zoom, and fullscreen where supported.
- Clearly labeled original training sample, separate from uploaded/community matches.
- Operator-installed map assets, desktop/mobile tier discovery, optional generic animated agent GLBs, and CPU S2V glTF packing/optimization/provenance tools.
- Verified-Steam FACEIT profile association, match history adapter, and approved signed download import adapter. Steam next-match share-code discovery adapter.
- Admin policy toggles with environment precedence and secret-free configuration; terminal admin creation/password reset.
- Account/connected services in the user dropdown and account tabs; work-only sidebar; full-library paginated search, preserved loaded pages during processing refresh; accessible menus/selects with fullscreen/modal-aware portals.
- Whole-tab viewer, progressive mobile controls with 44 px primary touch targets, neutral light playback control, buffering/error retry and keyboard-safe floating menus.
- Version 2 replay manifest/time slices with global indexes/bounds, five seconds of trail context, at most three cached browser chunks, forward prefetch and cancelled irrelevant requests. Legacy whole-file replays remain readable.
- Required Linux per-job Landlock/seccomp sandbox; private copied input, stripped environment, process/time/scratch bounds, validated artifacts and publication quota/cancellation checks. Real raw/compressed demo and required sandbox fixtures exercised locally.
- Manual Steam/Premier/Competitive/Wingman, FACEIT and HLTV file-import guides; ordinary private uploads, without an HLTV wrapper.
- Time-positioned kill/death, bomb outcome and optional recorded utility-release markers on the seek bar, match/round zoom, accessible dense-event clusters, exact seeking, player filters and progressive event detail. Real players are matched by immutable Steam ID; nickname fallback is restricted to labeled synthetic practice data.
- Optional edge-based spectator HUD: a compact mouse between movement and action/modifier keys; a single right-edge CT/T roster with blue/orange-red side colors, selected-row highlight, weapon silhouettes, utilities and health/armor/money/ammo; Settings-owned visibility at every viewport and complete loadout detail in the Players drawer. Recorded uint64 button states, actual mouse commands when present and WASD/ZQSD action labels. Missing data stays unknown; network snapshots are labeled and do not claim every physical key press.
- Recorded on-screen planting, planted-fuse and defusing timers/progress, actor/site/kit, interruptions and outcomes. Seek-safe global C4 snapshots use actual server-clock deadlines; missing timing stays elapsed/unavailable, never a guessed 40-second fuse.
- Local operator equipment icon packs: 73 known equipment names plus 10 native review/HUD symbols, S2V SVG preparation to safe PNG, provenance and private-policy-aware cached delivery. Actual CS2 icon PNGs were exercised locally, kept outside Git/images.
- Full-viewport scene, single 48 px overlay toolbar, compact playback deck and progressive timeline/phone round options. Scene tap/H, mouse/Tab recovery and optional three-second playback idle fade coordinate inert menus/player HUDs. Inputs, mouse and raw details are Settings-owned; captions remain visible when chrome fades. Primary controls/roster rows retain 44 px touch targets.
- Unified theme-specific viewer surfaces and a flush playback deck; quieter member controls using neutral surfaces and spacing; preserved focus indicators/form affordances, collapsed optional round strip and persistent action menu.
- Bounded TypeScript voice/chat extraction in the parser sandbox; Steam/Opus framing/CRC validation, streamed voice packets, local browser WASM decoding, playback speed/volume, speaker scope and mutes, chat overlays and transcript review.
- Clearly labeled silent EN/FR practice subtitles with clock-based preview. Optional offline CPU multilingual Whisper subtitles in a separate durable stage. Read-only pinned model, actual language identification, English/French speech verification, output/CPU/audio budgets, private caption access, owner-only retry, leases/quota/rollback/crash recovery. Failure preserves the ready replay; partial captions are labeled.
- Docker/Compose without Caddy, Monday no-cache image rebuild/publishing workflow, weekly dependency update PRs, architecture/security/agent handoff docs.

## Requires operator resources or external verification

- CS2 map/agent/weapon assets are not bundled. The S2V export step needs installed CS2 content and the operator's S2V binary. Optimization was tested with a synthetic glTF; a full CS2 export/alignment has not been tested in this environment.
- Steam/FACEIT end-to-end network flows need real accounts/keys and FACEIT Downloads API approval. Tests cover a successful mocked Steam assertion and adversarial callbacks/access policy, not a live account login or approved partner download.
- Docker is unavailable locally. The release workflow builds and runs the hardened image with actual parsing/transcription before publication; consult the successful workflow attached to a revision. Operators still need a compatible maintained kernel and deployment preflight.
- Subtitle generation requires an operator-prepared local model and enabled transcription worker/profile. Models and speech fixtures are not bundled in Git/images. Actual English/French CPU and required-sandbox inference were exercised with public speech; the actual Mirage CS2 fixture has no voice/chat. Full real-world voiced-demo corpus validation remains outstanding.
- Real-device performance remains unverified. A Galaxy S24 is a target, not a certified benchmark. Browser viewport checks do not measure mobile GPU memory or thermals. TV browser/remote behavior varies by model.

## Not implemented / do not claim

- Source 2 engine execution in-browser or exact visual/gameplay parity.
- Reconstructed baked map lighting/light probes/skyboxes, exact shaders or material blending.
- Exact character AnimGraph/poses/player-specific skins, weapon/bone attachments or first-person weapon animations. Optional agent clips are generic deterministic approximations.
- Volumetric smoke simulation, exact fire spread, weapon effects or Source 2 positional gunshot/footstep audio. Recorded VoIP playback is implemented separately.
- Recovery of missing voice/Discord calls, encrypted team/private chat, or encrypted public chat without its companion key. There is no `.dem.info` key-import workflow yet.
- Automated Steam Game Coordinator demo resolution/download/sync; Steam login alone cannot provide this.
- FACEIT as a social login provider. It is a verified linked data source, as requested for current Steam-only social auth.
- Exact server-rendered CS2 video, GPU streaming, AI coaching, clips/video exports, drawing collaboration, MFA, email recovery, moderation, or multi-host horizontal scaling.

The next high-value work is real CS2 asset validation, exact weapon/animation/effects work, real-device performance testing, live provider validation and independent security review. None should be represented by a decorative UI switch before it works. See the [acceptance matrix](product/ACCEPTANCE.md).
