# Feature status

Library and administration use the same dropdown and pagination controls. Members can pair a manual upload with a listed match, including when an automatic provider download is offered.

Library rows show native map emblems, local map previews or a map-name fallback. A linked Steam identity can see its recorded counters and rank. FACEIT can supply a match roster level. [Verification](VERIFICATION.md#local-library-match-details)

## Access and replay

- Schema 9 accounts have private email addresses and shared display names. SMTP is optional. New signups verify mailbox ownership before workspace access when enabled. A verified mailbox can receive a password-reset link. MFA and operator-assisted recovery retain their independent controls. [Account setup](ACCESS-SETUP.md#email-delivery-verification-and-password-reset)

- Public mode offers guest upload and a private temporary viewing capability. Members manage their own demo library, sharing and private notes. Private mode gates viewers and assets independently. Sign-in supports local accounts, configured Steam identity and discoverable passkeys. Enrolled accounts require a second factor after password or Steam sign-in. Optional French and English local speech transcription is available.
- Passkey setup flags invalid names before opening the browser’s creation prompt. Interrupted setup can resume in its originating tab with the original grant and deadline. Tab data enables resumption after a reload. Selecting a different passkey during confirmation shows guidance to select the newly created key and retry. [Access setup](ACCESS-SETUP.md#account-sign-in-and-recovery)
- Browser tabs share guest upload setup. An admitted guest upload can finish through an anonymous grant renewal within its original upload window. An unconfirmed guest cookie that protects no demos or upload reservations can be replaced once after a short delay. [Guest upload policy](ACCESS-SETUP.md#guest-upload-policy)
- The version 3 transport serves authorized manifests and bounded chunks. Timeline indexes are global, with a three-chunk browser cache and prefetch. Parser and speech work run in networkless Linux sandboxes. Unknown game fields stay unavailable.
- The private library opens on **My demos** with a source filter. Linked members with the required instance and account setup also see paged **Steam** and **FACEIT** tabs. Each tab filters downloaded matches from owned demos. Steam sync uses saved match sharing codes and opens downloads in CS2. FACEIT offers match-room links, private paired uploads and confirmed imports with an approved Downloads token. Live provider workflows still need credentialed verification. [Provider setup](ACCESS-SETUP.md#steam-and-faceit)
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
- Third-person equipment packs use the authored weapon root and the recorded animation’s weapon axes. Held items follow the posed grip, including independent left and right grips for Dual Berettas. The agent bank adds grenade and dual-pistol upper-body poses and weapon-class defuse loops. Live sun shadows render player and equipment depth separately from the cached map shadow. Compact 3D uses a floor-traced contact shadow.
- The directional player renderer uses demo-time foot plants and nearby rendered floor support. Corpse support uses bounded skin samples. Compact devices scale world equipment textures before resident-budget checks. The POV pass applies source weapon-metal parameters and its own highlight response inside the shared grade.

## Assets and rendering

- The separate assets service handles pinned official preparation, pending jobs and operator-authorized removal. Automatic acquisition defaults off. Latest snapshots are disclosed, manual map-name assets remain version-unverified, and publication requires complete validated packs with bound models and texture plans. Invalid worker-owned map packs enter preparation again.
- Detailed and optional Compact 3D share the replay cameras and calibrated overview. The graded output pass uses authored lighting data where available. One smoke volume pass uses journal or analytic density and reports an unavailable renderer.
- Detailed official map packs can use world-verified v8.2 lightmaps, sourced sun channels, supported cubemap and untextured gradient fog, and authored grading. Preparation reports PBR fallback reasons and removes unresolved non-solid effects from the playable world and sky geometry.
- Local 3D map evidence covers Mirage, Dust2, Inferno, Nuke, Ancient, Anubis, Overpass, Train, Vertigo and Office. Earlier 2D evidence covers Cache. Native animation graphs, exact Source 2 materials and mixing, Workshop acquisition, and physical-device performance remain outside the verified feature set.

See [verification](VERIFICATION.md), [active work](product/WORK.md), [acceptance](product/ACCEPTANCE.md) and [security](../SECURITY.md).
