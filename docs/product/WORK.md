# Active work

Updated 2026-11-17. The coordinated product rebuild is implemented. The release checks below apply to this delivery and future changes; inspect the workflow attached to a revision before treating it as released. See [verification](../VERIFICATION.md), [acceptance](ACCEPTANCE.md) and [handoff](../HANDOFF.md).

## Accepted scope

Keep the approved public landing and neutral member design. Account and connections belong in the user dropdown/account tabs. Preserve the whole-tab viewer, correct keyboard/fullscreen dropdown behavior, light playback control and 44 px primary phone actions.

The latest user requests are implemented as recorded round-event review, optional player inputs/economy/inventory, voice/chat and optional offline CPU subtitles. Premier/Competitive/Wingman files have a clear manual import path. Steam OpenID is identity, not automatic demo-download authorization. The user explicitly removed the HLTV catalog/wrapper; retain only source guidance and normal uploads.

Production Compose defaults to the repository's published `ghcr.io/buco7854/cswatch:latest` image, with an optional `CSWATCH_IMAGE` override and explicit source-build instructions. All services, including optional transcription, share that image. CI validates the complete Compose configuration before image verification/publication.

## Release gate

1. Format, locales, build, meaningful backend/browser checks, rendered production review and dependency audits.
2. Confirm generated demos, audio, weights, databases, `.env`, credentials and proprietary assets are excluded from Git and images.
3. Push `main` as explicitly authorized; verify the Node 24 workflow and actual hardened Docker upload/parser/subtitle smoke, then image publication. Fix any failures before reporting completion.

## Next evidence-driven work

- Validate real S2V maps/agents, coordinates/materials and transfer/memory cost with operator-owned assets.
- Exercise Steam and approved FACEIT Downloads flows with operator test accounts/credentials.
- Expand voice/chat corpus coverage with explicitly permitted recorded matches, including unsupported/encrypted protocol cases.
- Measure sustained performance on a physical Galaxy S24 and representative TV browsers/remotes.
- Commission independent security review; retain hard host disk quotas and maintained Linux confinement.

`STATUS.md` is authoritative about incomplete capabilities. No Source 2 parity, native positional game audio, automatic Steam downloads, physical-device certification or independent audit may be claimed without new evidence.

## Current HUD refinement

The latest user explicitly selected CT/T split across both edges on wide/tall screens, superseding the earlier right-only direction. Retain a saved right-only choice and automatic combined stack on narrow/short screens, no visible role headers, CT blue and T orange/red, and selected-player identification only as a row highlight. No separate selected-player card or observer strip. Recorded inputs and the separate mouse diagram default off. Compact timeline metadata and nearby native event glyphs replace excess vertical space; range/player/utility configuration lives in More → Timeline options. Phone transport keeps one row, with round navigation in More. The latest user steering replaces permanent display widgets with scene tap-to-fade. All menus/player HUDs fade together, with H, mouse and Tab recovery; gestures, keyboard focus and dialogs are guarded. The scene fills the entire viewport below overlays; small floating identity/action groups replace the opaque toolbar. Language/theme/account/demo actions live in Viewer menu. Playback idleness fades the interface after three seconds unless disabled; captions remain visible independently. Full inventory remains available in the Players drawer on request. Roster/input visibility and input details belong only in Options. Enabled mobile rosters scroll internally; no Lineups/input collapse/hide buttons remain. A silent, explicitly synthetic EN/FR subtitle preview is available in sample communications.

Toolbar, roster, objective ribbon, physical input instrument and inset playback deck share one palette per dark/light theme. Keep the camera center clear. Exact native CS2 demo kill/death symbols replace generic icons; objective events use the corresponding native HUD symbols. The same operator-only, PNG-only pipeline now supports 73 equipment assets plus 10 native review symbols. Preserve exact event timing, all review options, data honesty, EN/FR and the approved public landing.

Specialist source ownership has returned to root. Run native/browser-heavy checks sequentially; finish rendered review and release checks before pushing the authorized main branch. Proprietary artwork stays ignored and unbundled.

## Recorded review follow-up

Low quality retains recorded grenade projectiles independently of flight-path controls; 2D includes projectiles and analytical utility effects. Inputs are a compact ZQSD/WASD block with modifiers beneath and optional mouse alongside. New-device default is ZQSD, while saved WASD remains valid.

Optional observed-player moment actions offer a recorded grenade landing/detonation view and a rewind to a recent kill. Each can be disabled in Options. Actual attributable global detonation coordinates drive the alternate view; missing/ambiguous data suppresses it. The user rejected temporary clip/return navigation. Replay now seeks back and plays in the current camera at the current speed; grenade viewing seeks back and centers the ordinary free camera (or retains 2D). Playback continues normally with no back button or end stop. Both actions share one compact filled card. Contextual actions and captions remain usable while menus/player HUD fade. Preserve these distinctions in future work.

## Replay studio refinement

The user rejected overly compressed controls and inconsistent component quality, particularly mouse-button label clearance. The current direction is a neutral replay studio: readable desktop controls and equipment, progressive phone controls, a genuinely different short-landscape arrangement, measured complete roster rows and physical keyboard/mouse proportions. Inputs/mouse remain independently opt-in; every review feature, EN/FR, both themes and full-tab rendering remain. Viewer layout now has one CSS owner rather than repeated member/legacy overrides. Preserve the new actual-text-bounds and simultaneous-overlay regressions; viewport tests do not imply physical-device performance or user design approval.

## Current open-space refinement

The user asked for a shorter bar, utilities clear of health, and a substantially more open match view inspired by the supplied demo reference. Keep the approved public landing. The player now uses floating header groups, a 100 px two-row playback deck (96 px short landscape), split desktop teams with normal-flow equipment/status rows, and progressive five-category settings. Custom crosshair color/geometry/outline/dot/T controls and vertical 3D field of view are functional, device-local preferences. Recorded crosshair recovery remains unavailable; presets are cswatch JSON, not native share codes. Final browser/source review and release evidence belong in VERIFICATION.md.

## Additional spectator review scope (release verification)

Before release the user requested centered transport controls in a narrower deck, bottom-left inputs and a larger radar; recorded scores/clock and a Tab-accessible scoreboard; symmetric kill/death perspective replays; and a progressive kills/utility list plus throw toast with recorded input marks and separate throw/landing navigation. Preserve all existing review features, private data rules, both themes and EN/FR. Specialist ownership: native/shared match-state and exact throw-event input evidence; indexed score/stat components; viewer layout and review feed; root navigation/toasts/integration. The previous passing open-space check is a checkpoint, not the release of this expanded scope. No push until the new features and rendered/security regressions pass.

The expanded source is implemented. Native-counter provenance replaced an unsafe event-only zero baseline; actual mid-recording totals survive seeks. Full backend checks passed 127 cases, the isolated upload/required-sandbox/private-sharing/CPU-speech smoke passed with the new metadata, and focused score/layout/review journeys passed. The complete browser run passed 69 cases with one intentional private-policy skip; both private registration policies passed. Final production inspection passed with zero failures and a documented metadata-size warning; source/locale/format hygiene passes. Image release remains gated by the commit-specific Docker verification/publication workflow. Do not expand scope without a concrete bug or further user steering.

## Broadcast layout follow-up

The latest user steering removes visible CT/T text next to the official marks, centres the actual clock text at every viewport, and folds bomb/defuse artwork, recorded progress and countdown into the score band. Actor/site/kit remain in one shared caption; the standalone objective instrument survives disabling scores. Replay prompt arrival must never reduce the roster viewport. Desktop playback clears both player columns, with inputs at bottom left and a separate bottom-right prompt lane. Compact lanes reserve space from enabled preferences rather than moment height.

Specialist source ownership has returned to root. The final complete browser suite passed 72 public journeys with one intentional private-policy skip; both private registration policies passed separately. Nineteen focused layout cases and the native-asset 64-capture review passed. The final production app inspection reports zero failures/warnings in both themes, with all 12 images reviewed. Source/locale/build checks pass. The previous spectator commit `82e2293` passed actual Docker verification and image publication; this follow-up remains gated by its new commit-specific release workflow before it is reported done.

The last requested polish lightens the physical mouse body to the raised HUD surface and replaces Landing glyphs with consistent location pins in both entry points. Eight targeted HUD/review tests and refreshed renders pass; all broader behavior remains as above. Wait for this final revision's full CI/Docker/publication workflow before reporting completion.
