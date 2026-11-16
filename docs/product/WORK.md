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
