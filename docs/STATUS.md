# Feature status

Maps are native world packs exported from Valve's compiled resources (ValveResourceFormat 21.1) and drawn by a WebGL2 port of the CS2 shaders in one graded frame with actors, smoke and the first-person rig. The confined assets worker prepares any official map with a desktop BC tier and a phone ASTC tier. Devices with neither texture format get the 2D map with an explanation. Doors, breakables and recorded visibility drive both drawing and camera, label, floor and sound queries. 21 of the 22 playable official maps prepare on the test host; rush_001 (Valve's Rush mode map) needs more free disk than the test host has. de_debris, de_eldorado and de_poseidon read their materials, sky, grading and radar from their official community addon in Steam's platform depot. Baked lighting keeps its full shipped resolution on both tiers (most maps ship 8192² irradiance), so most maps exceed the 100 MB desktop and 70 MB phone downloads and report the overage. [Native rendering](product/NATIVE-RENDERER.md) · [Map assets](MAP-ASSETS.md) · [Verification](VERIFICATION.md#native-worlds)

The viewer shows the current worker phase while an official map is being prepared, and an intact, manifest-verified source cache can skip the initial Steam transfer.

Recorded body, head and armor hits, named bullet impacts, surface footsteps, jump takeoffs and landings use the native sound bank. The 3D viewer can also position a representative impact where a recorded shot meets nearby opaque map geometry. [Player hits and steps](VERIFICATION.md#recorded-hits-and-steps) · [Wall impacts](VERIFICATION.md#nearby-wall-impacts)

Classic CT and T announcements use the recorded winner and play centrally across listener perspectives. Catalog discovery can finish during playback. The approved sound bank has no MVP music. [Round audio checks](VERIFICATION.md#recorded-round-announcements)

First-person stride bob and third-person boot contact now fade through recorded ballistic movement. [Mirage jump comparison](VERIFICATION.md#airborne-arm-and-boot-motion)

Demo processing and map loading use one screen with a stable return link. Account titles retain assistive focus, and text fields and library search show one focus outline.

A LAN administrator can connect directly or through a trusted proxy that sends `X-Real-IP` or `X-Forwarded-For`, including when the proxy also sends `CF-Connecting-IP`. Server-side Steam import diagnostics record the failed stage and any numeric Steam result. [Operator guide](ACCESS-SETUP.md)

Library and administration use the same dropdown and pagination controls. Members can pair a manual upload with a listed match, including when an automatic provider download is offered.

Steam match import uses the member’s installed CS2 client and an explicitly selected replays folder, with paired manual uploads available on all supported browsers. FACEIT player stats can supply the map before import. Authorized administrators can open Administration from workspace navigation on desktop and mobile. [Access setup](ACCESS-SETUP.md)

Library rows show native map emblems, local map previews or a map-name fallback. A linked Steam identity can see its recorded counters and rank. FACEIT can supply a match roster level. [Verification](VERIFICATION.md#local-library-match-details)

## Access and replay

- Schema 9 accounts have private email addresses and shared display names. SMTP is optional. New signups verify mailbox ownership before workspace access when enabled. An email supplied for the first administrator in setup or the environment starts verified. A verified mailbox can receive a password-reset link. MFA and operator-assisted recovery retain their independent controls. [Account setup](ACCESS-SETUP.md#email-delivery-verification-and-password-reset)

- Public mode offers guest upload and a private temporary viewing capability. Members manage their own demo library, sharing and private notes. Private mode gates viewers and assets independently. Sign-in supports local accounts, configured Steam identity and discoverable passkeys. Enrolled accounts require a second factor after password or Steam sign-in. Optional French and English local speech transcription is available.
- Passkey setup flags invalid names before opening the browser’s creation prompt. Interrupted setup can resume in its originating tab with the original grant and deadline. Tab data enables resumption after a reload. Selecting a different passkey during confirmation shows guidance to select the newly created key and retry. [Access setup](ACCESS-SETUP.md#account-sign-in-and-recovery)
- Browser tabs share guest upload setup. An admitted guest upload can finish through an anonymous grant renewal within its original upload window. An unconfirmed guest cookie that protects no demos or upload reservations can be replaced once after a short delay. [Guest upload policy](ACCESS-SETUP.md#guest-upload-policy)
- The version 3 transport serves authorized manifests and bounded chunks. Timeline indexes are global, with a three-chunk browser cache and prefetch. Parser and speech work run in networkless Linux sandboxes. Unknown game fields stay unavailable.
- The private library opens on **My demos** with a source filter. Linked members with the required instance and account setup also see paged **Steam** and **FACEIT** tabs. Each tab filters downloaded matches from owned demos. Steam uses saved match sharing codes for client-assisted downloads or optional server imports through a shared Game Coordinator. The match row distinguishes disabled imports, a refused server login, a Steam Guard challenge and an expired replay. Each member can opt in to automatic imports. Provider-specific upload dialogs link to the relevant match. FACEIT offers match-room links, private paired uploads and confirmed imports with an approved Downloads token. Live provider workflows still need credentialed verification. [Provider setup](ACCESS-SETUP.md#steam-and-faceit)
- SQLite is initialized in an empty data directory. Startup checks the current schema and refuses incompatible data stores. Keep existing data and operator-managed assets under operator control.
- Administration blocks turning off Steam while a linked account relies on it for sign-in. An admin-network denial during a page read conceals the private view while the browser verifies the account and current access. [Access setup](ACCESS-SETUP.md#disabling-steam)
- Administration rejects stale second-factor policy changes and restores the current role set after a conflict or an interrupted save response. A failed check leaves the policy read-only until a fresh read succeeds. [Verification](VERIFICATION.md#local-second-factor-policy-recovery)
- Instance settings refresh from current server values and save only pending local edits to unlocked settings. [Verification](VERIFICATION.md#local-second-factor-policy-recovery)
- Administrator-issued reset links for other accounts expire with the code and are concealed when the issuing session changes. The recovery form can resume the same reset after a lost claim response. It verifies the current browser and matching unexpired receipt before opening the password form or showing the sign-in name. [Account security](ACCOUNT-SECURITY.md)
- Administration records sampled account detail reads and denials with separate capacity for durable operator changes and linked publication outcomes. [Audit retention](ACCOUNT-SECURITY.md#administrative-audit)

## Viewer

- Finished demos open in a living player’s POV at the first recorded live round when available. Explicit links and saved tab positions override this starting tick. Wide screens show live team cards, a larger radar and round review by default.
- The whole-tab viewer supports POV, follow, free, overhead and tactical 2D cameras. Map loading exposes progress and 2D recovery. The playback controls, scoreboard, review, captions and input overlays support keyboard and touch, responsive layouts, and English and French in light and dark themes.
- Scene labels use posed heads and avoid each other and the HUD. Overhead shows team direction arrows through roofs, with a ring on the observed player. The north-up radar crops the recorded playable bounds when they fit the calibrated overview. Living and eliminated roster cards share a row height.
- Recorded events and sampled state drive economy, objectives, recorded player input, crosshairs, combat recap, native sound and grenade paths. Flash and damage feedback follow demo time. Tracers use recorded aim and bounded prepared-map occlusion. Reduced motion keeps steady feedback and disables tracers.
- The directional CT/T bank uses 101 native clips with recorded movement, aim and available action evidence. Missing rigs use capsule bodies. The dedicated first-person pass discovers automatically prepared, hash-bound weapon and hand rigs. Static equipment, movement inference and recorded event cues cover missing assets or evidence.
- Third-person equipment packs use the authored weapon root and the recorded animation’s weapon axes. Held items follow the posed grip, including independent left and right grips for Dual Berettas. The agent bank adds grenade and dual-pistol upper-body poses and weapon-class defuse loops. Live sun shadows render player and equipment depth separately from the cached map shadow. Low quality uses a floor-traced contact shadow.
- The directional player renderer uses demo-time foot plants and nearby rendered floor support. Corpse support uses bounded skin samples. Compact devices scale world equipment textures before resident-budget checks. The POV pass applies source weapon-metal parameters and its own highlight response inside the shared grade.

## Assets and rendering

- The separate assets service handles pinned official preparation, pending jobs and operator-authorized removal. Automatic acquisition defaults off. Latest snapshots are disclosed; manual map-name assets remain version-unverified.
- Every map job runs the native exporter, desktop packer, phone ASTC encoder and publication as separate networkless children with CPU, memory, time, output and scratch limits. Packs are immutable and hash-bound, and served only to viewers of a demo using that map.
- Smoke uses one volume pass with journal or analytic density. Native animation graphs, dynamic local lights, vertex animation and wind remain outside the renderer; each pack lists its limits in `unsupported`.

See [verification](VERIFICATION.md), [active work](product/WORK.md), [acceptance](product/ACCEPTANCE.md) and [security](../SECURITY.md).
