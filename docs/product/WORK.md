# Active work

Updated 2026-11-16. The coordinated product rebuild is implemented. The release checks below apply to this delivery and future changes; inspect the workflow attached to a revision before treating it as released. See [verification](../VERIFICATION.md), [acceptance](ACCEPTANCE.md) and [handoff](../HANDOFF.md).

## Accepted scope

Keep the approved public landing and neutral member design. Account and connections belong in the user dropdown/account tabs. Preserve the whole-tab viewer, correct keyboard/fullscreen dropdown behavior, light playback control and 44 px primary phone actions.

The latest user requests are implemented as recorded round-event review, optional player inputs/economy/inventory, voice/chat and optional offline CPU subtitles. Premier/Competitive/Wingman files have a clear manual import path. Steam OpenID is identity, not automatic demo-download authorization. The user explicitly removed the HLTV catalog/wrapper; retain only source guidance and normal uploads.

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

The latest user correction requires a single CT/T roster on the right, no visible role headers, CT blue and T orange/red, and selected-player identification only as a row highlight. No separate selected-player card or observer strip. Recorded inputs and the separate mouse diagram default off. Compact timeline metadata and nearby native event glyphs replace excess vertical space; range/player/utility configuration lives in More → Timeline options. Phone transport keeps one row, with round navigation in More. The latest user steering replaces permanent display widgets with scene tap-to-fade. All menus/player HUDs fade together, with H, mouse and Tab recovery; gestures, keyboard focus and dialogs are guarded. The scene fills the entire viewport below overlays; one 48 px toolbar replaces both previous rows. Language/theme/account/demo actions live in Viewer menu. Playback idleness fades the interface after three seconds unless disabled; captions remain visible independently. Full inventory remains available in the Players drawer on request. Roster/input visibility and input details belong only in Options. Enabled mobile rosters scroll internally; no Lineups/input collapse/hide buttons remain. A silent, explicitly synthetic EN/FR subtitle preview is available in sample communications.

Toolbar, roster, objective ribbon, physical input instrument and flush full-width playback deck share one palette per dark/light theme. Keep the camera center clear. Exact native CS2 demo kill/death symbols replace generic icons; objective events use the corresponding native HUD symbols. The same operator-only, PNG-only pipeline now supports 73 equipment assets plus 10 native review symbols. Preserve exact event timing, all review options, data honesty, EN/FR and the approved public landing.

Specialist source ownership has returned to root. Run native/browser-heavy checks sequentially; finish rendered review and release checks before pushing the authorized main branch. Proprietary artwork stays ignored and unbundled.
