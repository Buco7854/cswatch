# Working on cswatch

Start with the current entries in [Handoff](docs/HANDOFF.md) and [Active work](docs/product/WORK.md). Consult the relevant parts of the [product brief](docs/product/BRIEF.md), [architecture](docs/ARCHITECTURE.md), [feature status](docs/STATUS.md) and [security model](SECURITY.md) before changing a subsystem.

## Project rules

- Keep the TypeScript application, CPU-only hosting, S2V asset preparation and Docker behind the operator's reverse proxy. Keep desktop, mobile and TV usable in English and French and in both themes.
- Keep demos private by default. Read routes use `accessDemo` and mutations require ownership. Notes and guest capabilities stay private and separate from member accounts. Keep exact Origin, CSRF, identity and asynchronous revalidation checks. Use synchronous SQLite transactions.
- Bound uploads, decompression, native runtime and artifact sizes. Keep the parser and speech workers networkless and require their Landlock/seccomp isolation. Use only fixed provider endpoints and approved imports. Steam sign-in alone does not authorize demo downloads.
- Keep player Steam IDs as strings and derive review from recorded evidence. Missing values stay unknown. Version incompatible replay changes. Keep S2V metre/Y-up conversions and replay inches/Z-up conversions distinct.
- Keep asset conversion isolated from app data. Use pinned official sources for network acquisition. Automatic map acquisition defaults off. Distinguish approved historical sources from disclosed latest official snapshots. Publish immutable assets and preserve operator files.
- Keep generated data and proprietary assets out of Git and images. Credentials stay server-side and out of logs, fixtures and Git. Pushing, publishing and sending external messages require explicit authorization.

## Read for the change

| Area                            | Start here                                                                                                                         |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Accounts, uploads and providers | [Access setup](docs/ACCESS-SETUP.md) and [Security](SECURITY.md)                                                                   |
| Parser, replay and audio        | [Replay contract](docs/ARCHITECTURE.md#replay-contract) and [Replay metadata](docs/REPLAY-METADATA.md)                             |
| Viewer controls and rendering   | [Viewer maintenance](docs/VIEWER-MAINTENANCE.md), [UX](docs/product/UX.md) and [renderer roadmap](docs/product/NATIVE-RENDERER.md) |
| Map and artwork worker          | [Acquisition](docs/product/MAP-ACQUISITION.md), [removal](docs/MAP-MANAGEMENT.md) and [asset tools](tools/assets/README.md)        |

## Verification

Use Node 24 and [README setup and tests](README.md#development). Linux native checks require Landlock ABI 3+, C tools and the pinned fixture. Count fixture skips as skips. Run the relevant tests, `npm run format:check` and `npm run check:locales` when messages change.

For UI work, use the design skill's app workflow and inspect the rendered production build on desktop, tablet and mobile in both themes. Preserve keyboard and touch controls, reduced motion and missing/error/access states. Use isolated test accounts and the [verification methods](docs/VERIFICATION.md#verification-methods).

Update status, handoff and verification when capabilities or evidence change. Require successful exact-revision checks for releases. Report the actual fixture, device, renderer and limits of the evidence.
