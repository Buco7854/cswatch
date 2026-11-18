# Feature status

Updated 2026-11-18. This file is the capability contract. Implementation and local evidence do not establish release publication. Local verification passed 244 backend tests, 121 asset-tool tests and 122 public browser journeys with two intentional policy skips. Dedicated setup and both private registration policies passed separately. The current commit's Actions workflow records container verification and publication. Cache has no published runtime pack.

## Access and personal workspace

- One compact logged-out entry for uploading the visitor's own demo when guest policy permits, with GitHub and the shared language dropdown. Signed-in root opens the personal library. No marketing subpages, community catalogue or HLTV wrapper.
- Private temporary guest capability ownership, separate CSRF, expiring retention, count/storage bounds and cleanup. Environment/admin policy can disable guest uploads independently of registrations. Logging in does not merge guest ownership.
- Atomic first-admin setup protected by a private operator code, or creation-only `ADMIN_USERNAME`/`ADMIN_PASSWORD` provisioning. Environment flags override unlocked admin policy.
- Local accounts and Steam OpenID login/linking with separate provider identities, secure sessions, Origin/CSRF/host checks, persistent rate limits and private-by-default demos/notes. FACEIT is a verified linked data source, not a login provider.
- Account/connections in the user menu and account tabs, paginated full-library search, processing states, rename/delete/explicit sharing and reusable accessible confirmations. Lifecycle guards prevent obsolete auth, upload or mutation responses from changing newer UI/session state. CSRF commits with verified identity, and interrupted setup responses recover through authoritative state checks.
- EN/FR copy and accessibility labels, localized formatting, persisted language and dark/light themes. Keyboard focus indicators, bounded reusable menus/dialogs, stable controls and consistent scrollbars remain.

## Ingestion and replay data

- `.dem` and `.dem.zst` uploads with magic validation, reservations/quotas, bounded decompression, durable queue, required Linux Landlock/seccomp parser confinement and validated output publication. Owner failures show a safe code/reference and structured server diagnostics.
- Actual players/positions/angles/status, recorded inventory/economy, native counters/crosshair codes, events/rounds/dead time, grenade trajectories, objectives and world equipment when the recording supplies them. Missing fields remain unavailable.
- Version 2 byte-adaptive replay chunks with global indexes/bounds, five seconds of spatial trail context, bounded browser caching/prefetch and cancelled irrelevant requests. Context-only samples never establish historical HUD state.
- Three supplied complete recordings passed actual uploads, confined parsing, private transport and desktop/phone review before authorized deletion. Their position-fallback journeys are separate from game-asset validation.
- Manual Premier/Competitive/Wingman, FACEIT and HLTV import guidance. Verified-Steam FACEIT association/history and approved-download adapters, plus Steam next-match share-code discovery, are implemented with credential/missing-access states. Live provider flows require external credentials/approval. Steam OpenID alone does not authorize automatic demo downloads.

## Viewer and recorded review

- Full-tab scene, responsive desktop/tablet/phone controls and optional browser fullscreen. Orbit, overhead, player POV, guarded WASD/ZQSD free camera and calibrated 2D fallback. Third-person follow preserves selected identity, recorded transforms, seek behavior and configured FOV. Genuine CT/T views with recorded AKs passed visual review. The shoulder camera is approximate and has no map collision.
- Seeking/speeds, match/round timeline range, round jumps, manual/automatic dead-time skipping, exact recorded event markers/clusters/filters and private timestamp notes.
- Optional edge-based CT/T rosters with independent identity/equipment/health rows, native equipment glyphs, full inventory drawer and selected-player POV feedback. Compact layouts retain complete-row scrolling and primary touch targets. Display options live in Options, and closing an overlay updates its preference.
- Viewport-centered score/clock, native-counter scoreboard and focus-safe held-Tab access. Bomb planting/fuse/defusing instruments use recorded clocks, actors and outcomes. Unknown deadlines stay elapsed/unavailable, never guessed.
- Custom local crosshair geometry or supported observed-player static crosshairs decoded from recorded native codes. Dynamic native recoil/spread/scope crosshairs are not reproduced.
- Compact symmetric kill/death review, round Kills/Utility lists, recorded throw inputs and genuine landing/detonation navigation. Actions use ordinary seek/camera changes at the current speed, with no clip/return flow. Player/event matching uses immutable IDs.
- Quality-independent recorded projectile visibility, interpolation without extrapolation, independent path controls and analytical utility zones in 3D/2D. Effects are approximations of recorded events, not native smoke/fire physics.
- Optional compact ZQSD/WASD/modifier and mouse visualization when command evidence exists. Physical bindings cannot be inferred. Phone preferences are separate and optional input/mouse/full round lists default off.
- Tap/H/idle chrome fading with inert hidden controls, focus/typing/dialog guards and independent captions. A labeled synthetic practice scene remains separate from uploaded history.

## Communications

- Bounded voice/chat extraction, actual Steam/Opus framing, local browser decoding, speaker selection/mutes/volume, playback speed, chat and transcript review.
- Optional offline multilingual CPU Whisper subtitles in an independent durable stage, with read-only operator models, required confinement, leases/quotas, private delivery and retry. Speech failure preserves replay readiness.
- Actual English/French inference passed. Two supplied recordings provided locally decoded voice/chat and one supplied chat without voice. Broad subtitle accuracy remains unverified. Missing/encrypted communications are not reconstructed. There is no companion chat-key import workflow.

## Native assets and browser rendering

- Operator-only Linux x64 checksum-pinned S2V/tool bootstrap and anonymous selective Steam acquisition of explicit maps/resources. Pinned manifests, dependency CRCs, shader preflight, staged publication, exclusive outputs and a persistent disk reserve separate this work from public HTTP/demo workers.
- Complete Mirage, Dust2 and Ancient model/overview/sky/landscape packs passed genuine browser checks. Required image decoding gates readiness. Radar/full 2D share actual overview calibration, and neutral radar/world colors stay independent of the HUD theme. Cache resources/shaders were acquired, but export stopped at the disk reserve and no runtime Cache pack was published.
- Bounded decoded map texture policies, sequential encoding, lossless local Meshopt, private model pools, cancellation/lease/disposal guards, paused demand rendering and recovery through 2D. These reduce avoidable transfer/memory/work without promising a frame rate or total-memory ceiling.
- Authored six-face sky cubemaps and separate-depth distant geometry with recorded transforms. Scoped exact-source black-unlit/cubemap-fog compatibility and static alpha masks for three supported dust/cloud materials. Lighting, HDR/fog and unimplemented shader effects remain approximations.
- Fixed 67-ID native 3D equipment registry and descriptor-anchored local model delivery, streamed digest/range support and disconnect-safe descriptor ownership. Ten IDs are actually prepared and independently decoded: `ak47`, `knife`, `hegrenade`, `flashbang`, `smokegrenade`, `molotov`, `incgrenade`, `decoy`, `c4`, `plantedc4`. Other IDs keep missing-model fallbacks until prepared.
- Static native weapons for held/POV equipment, all six prepared grenade types and recorded dropped/planted world-item transforms. C4/planted C4 use the actual shared native C4 source, without native countdown/arming animation. Attachment presets are explicit approximations with measured native bounds.
- Genuine CT/T geometry prepared with one native rifle-idle frame retargeted to 64 matched bones. These are static generic poses, not recorded player animation, crouch/locomotion/recoil, player-specific skins or native first-person arms. Genuine Mirage/AK POV with both agent types passed on desktop dark/phone light.
- Separate fixed native equipment/review icon registry, safe PNG preparation, hash-bound delivery and actual local artwork checks. No proprietary map/model/icon content is bundled in Git or images.

## Deployment and limits

Docker/Compose runs TypeScript services behind the operator's reverse proxy, without Caddy. The default image is `ghcr.io/buco7854/cswatch:latest` with `CSWATCH_IMAGE` override. Weekly rebuild/publication and dependency-update workflows exist. Docker is unavailable locally, so only the workflow attached to a commit can establish its hardened container verification/publication.

Automatic acquisition of a missing demo map is a [proposal](product/MAP-ACQUISITION.md), not an app feature. Current packs are operator-prepared, identified by map/source version and immutable for an app session. Historical/version/Workshop coverage is incomplete, and map-name equality alone does not prove a matching layout.

Do not claim Source 2 engine execution or exact visual/gameplay parity, full baked lighting/materials/animation/audio, native smoke/fire simulation, automatic Steam demo sync, FACEIT social login, video/clip exports, MFA/recovery, independent security certification or multi-host scaling. Real Galaxy S24/TV performance, live external-provider integration and wider asset/voice quality need separate evidence. CPU-only hosting does not imply low memory use.

See [verification](VERIFICATION.md), [active work](product/WORK.md), [acceptance](product/ACCEPTANCE.md) and [security](../SECURITY.md).
