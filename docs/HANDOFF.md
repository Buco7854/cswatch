# Current handoff

Updated 2026-11-18. Start with [active work](product/WORK.md), [feature status](STATUS.md), [verification](VERIFICATION.md) and [security](../SECURITY.md). Repository: https://github.com/Buco7854/cswatch. The user authorized specialist agents and pushing verified changes to main. Local source verification is complete. The commit-specific Actions workflow is authoritative for container verification and image publication.

## Current state

The access, upload, review and asset work is implemented. All three supplied recordings passed real upload, confined parsing, private chunk delivery and desktop/phone seeking, then were hash-checked and deleted as requested. Keep that position-view evidence separate from the later genuine asset checks.

Complete Mirage, Dust2 and Ancient packs now render geometry, decoded textures, calibrated overview, sky and distant landscape. Genuine Mirage map/AK POV checks also passed with native static CT/T agents and prepared equipment on desktop dark and phone light. The fixed equipment registry contains 67 IDs, but only ten have been prepared and verified locally. Missing models retain explicit fallbacks. CT/T use one genuine rifle-idle pose sampled at frame zero, not recorded bone animation.

The final backend run passed 244 tests without skips, including offline English/French inference. Required runtime upload/ownership/guest/sharing/speech smoke passed. The complete asset aggregate passed 121 tests without skips. The final public browser run passed 122 journeys with two intentional policy skips. Private registrations closed/open each passed their dedicated journey, and first-admin setup passed four cases. Follow markers, genuine CT/T visuals, map-route no-follow delivery and disconnect cleanup are verified. See [verification](VERIFICATION.md) for exact evidence and commands.

Cache acquisition resolved its resources and shaders, but scene export stopped at the unchanged 512 MiB disk reserve. No Cache runtime pack was published. Do not lower the reserve or call its recording's successful parser check a map-rendering check.

## Product and access decisions

Use TypeScript, CPU-only server hosting, browser WebGL, EN/FR and dark/light themes. Docker runs behind the operator's reverse proxy. Never restore a Python backend, bundled TLS proxy, HLTV catalogue or arbitrary remote-import URLs.

Logged-out visitors get one compact page for uploading their own demo when guest policy permits. Signed-in root opens the private library. Keep the shared language dropdown and GitHub link, with no marketing subpages, community catalogue or brand subtitle. Account and connections belong in the user menu/account tabs.

[Access setup](ACCESS-SETUP.md) describes temporary guest ownership and first-admin enrollment. Guest capabilities are separate from member sessions, expire, have their own CSRF and quotas, and never merge into an account. `GUEST_UPLOADS_ENABLED` is independent of registrations and effectively disabled on private/uninitialized instances. Environment values override admin policy.

`ADMIN_USERNAME` and `ADMIN_PASSWORD` create only the first administrator. Otherwise setup requires the private `DATA_DIR/setup-token` code, exact Origin, rate limits and atomic enrollment. Never expose that code or let the first visitor claim the instance. Auth refresh generations publish identity and CSRF together and prevent stale responses from closing a newer dialog. Interrupted setup POST responses trigger an authoritative state check without duplicating enrollment or discarding edits. Reusable confirmation dialogs handle destructive actions and cancellation.

## Replay and viewer invariants

The scene fills the tab. Keep spectator controls at the edges, centered transport/score, separate identity/equipment/health rows, complete roster scrolling and progressive Options. Phone preferences are separate and optional inputs/mouse/full round feed default off. The compact recorded combat recap remains available. Overlay dismissal updates its setting. Captions remain independent of fading chrome.

Use immutable string Steam IDs, recorded counters, actual objective clocks and event positions. Missing data stays unknown. Timeline markers, replay perspectives and utility landing actions are ordinary seeks/camera changes, without temporary clips or return state. Do not infer landings from trajectory endpoints, totals from partial events, physical keys from network snapshots or a fuse duration from a future explosion. See [replay metadata](REPLAY-METADATA.md).

Supported recorded static crosshairs come from native controller codes. Custom crosshairs remain local. Dynamic native recoil/spread/scope behavior is not reproduced. Free camera accepts WASD/ZQSD, with typing/focus guards. Third-person follow passed pure/browser checks and genuine CT/T visual review with recorded AKs. Its approximate shoulder camera does not implement map collision or native animation. Selected actor identity markers stay hidden in this close view.

Keep required Linux Landlock/seccomp confinement, stripped environments, bounded scratch/decompression and validated artifact publication. Full matches use native column projection and adaptive UTF-8 chunk sizes under the existing 4 MiB limit. Trail context is not authoritative historical HUD state. Structured worker errors expose safe stage/code/reference information, never raw native output or credentials. Recorded voice uses cumulative packet-end offsets and ignores unused capacity. Speech failure must leave replay readiness intact.

## Operator assets

Acquisition/conversion is a trusted operator process, separate from public HTTP and the networkless worker. No game content or toolchain cache belongs in Git or images. Current prepared evidence uses depot `2347770`, manifest `6678473446694075055`. Steam's latest listing has advanced to `807392217824910805`. Use an explicit manifest pin when continuing the old source version, and do not mix or relabel cached versions. The explicit map `--manifest` path passed 20 focused installer checks, including mismatched source rejection.

The map pipeline verifies selected VPK entries, follows bounded dependencies, preflights authored shaders and publishes complete model/overview/environment packs. Large selected shader entries use streaming CRC checks without raising the 128 MiB resource-allocation limit. Keep the periodic disk guard, exclusive outputs and verified cleanup. Asset URLs are immutable for an app session. Stop viewers, install a new complete pack and reload tabs rather than replacing active assets.

The validated packs now live at ignored `var/maps-final` after the private preview was stopped and a same-filesystem rename preserved the complete tree. They contain three maps, ten equipment IDs and CT/T rigs. Install this tree as `DATA_DIR/maps` separately from the code/image.

Map textures have decoded budgets of 512 MiB desktop and 256 MiB mobile. Lossless Meshopt reduces transport bytes, not decoded geometry or GPU mip memory. Rendering uses bounded private model pools, cancelled/stale request guards and demand rendering while paused. HUD themes do not recolor the map or radar. Radar ground is opaque neutral `#525252` in both themes.

Authored sky cubemaps and tagged distant geometry use recorded Source transforms and a separate depth pass. Exact black-unlit compatibility and three supported atmospheric alpha-mask bakes address evidenced exporter differences. Lighting, HDR/fog, panning/Fresnel/depth feather, smoke physics and native animation remain approximations. Never hide geometry by a color heuristic.

The native model installer preserves source meters, selects actual default mesh/LOD groups and excludes full animation graphs. Weapons receive one offline +90° Y correction. Agent GLBs keep raw S2V axes for the runtime's existing +90° Y rotation. Keep this distinction. Sparse native accessors are bounded before decoding, checked for valid increasing indices, then expanded to dense storage before lossless packing. Static pose retargeting uses exact matrix inversion with unchanged rigidity guards.

[Automatic map preparation](product/MAP-ACQUISITION.md) is a proposal only. The app currently discovers operator-prepared packs and does not automatically download/convert a demo's missing map.

## Finish and release

The local integration gates in [WORK](product/WORK.md) are complete. Preserve passing assertions and resource bounds when continuing development. Run large exports, native/ASR suites and software-rendered browser checks serially with Node 24 and the lockfile's Chromium. Docker is unavailable locally. After final checks, push as authorized and observe that commit's hardened Docker verification and image publication before calling the revision released.

Keep missing live provider credentials, broader map coverage, physical Galaxy S24/TV performance and independent security review explicit. Browser viewport checks are not real-device certification, and CPU hosting is not a low-memory guarantee.
