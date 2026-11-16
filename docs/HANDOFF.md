# Current handoff

Updated 2026-11-16. Start with [active work](product/WORK.md), [feature status](STATUS.md) and [verification](VERIFICATION.md). The user authorized autonomous specialist development and pushing verified changes to `main`. Repository: [Buco7854/cswatch](https://github.com/Buco7854/cswatch). The initial proof of concept is preserved in commit `bfb9618`.

## Product decisions to preserve

- Preserve the approved public landing and restrained neutral member direction. Account/connections live in the user menu/account tabs. The viewer takes the whole tab, with in-view controls and progressive mobile panels; additional browser fullscreen is supported.
- The application is TypeScript with CPU-only hosting, React/Three rendering, S2V operator asset preparation, Docker behind the operator's proxy, EN/FR and both themes. The small C launcher provides the Linux security boundary; no Python backend or bundled TLS proxy.
- The user canceled the HLTV/pro catalog. External demos use a manual source guide and normal private uploads. Do not reintroduce `/pro` or `PRO_*` flags.
- Advanced review includes recorded round events, optional economy/inventory/input HUDs, WASD/ZQSD labels, local voice/chat and optional offline CPU subtitles. Missing recorded data stays unknown. These features are progressive, disabled where appropriate by default, and never justify fake history or guessed speech.

## Architecture checkpoints

Read `AGENTS.md`, `ARCHITECTURE.md` and `SECURITY.md` before changes. HTTP handlers never run native parsing. Each child receives only its copied job, stripped environment and read-only runtime through required Landlock ABI 3+/seccomp. Unsupported confinement fails closed. Scratch polling is not a host filesystem quota.

New replay output uses version 2 manifest/chunks with global indexes/bounds and five-second trail context. The browser caches at most three slices and cancels irrelevant requests. Legacy version 1 remains readable. Player IDs remain strings; coordinate transforms are documented in `AGENTS.md`.

Schema v4 separates subtitle state/leases/artifact pointers. Optional offline Whisper CPU transcription runs after the primary replay is ready; failure cannot fail that replay. Compose separates parsing from the optional networkless transcription profile. Model preparation is operator-only; no weights or proprietary assets are committed or bundled.

## Evidence and continuation

The consolidated local record is in `VERIFICATION.md`: backend tests with no skips, public/private browser journeys, actual sandboxed upload/streaming/subtitle smoke and rendered locale/theme/device checks. The Mirage fixture has no voice/chat; communication protocol fixtures and actual public speech validate those paths separately. Docker is unavailable locally; the release workflow performs actual hardened-image verification before publishing.

Specialist responsibilities were workspace UX, native processing/security and offline speech/imports. They worked in the shared checkout with root integration; no parallel agent commits. Use focused ownership and shared contracts for future changes, and update factual status/evidence with every capability change.

Highest-value follow-up is operator CS2 asset/export validation, live provider integration, real voiced-demo corpus and physical S24/TV measurements, followed by independent security review. Exact Source 2 lighting, weapon animation/audio/effects, Game Coordinator downloads and encrypted-chat key import remain incomplete. Do not substitute decorative switches for those capabilities.
