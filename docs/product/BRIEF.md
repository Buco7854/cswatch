# cswatch product brief

## Purpose

Watch and understand a Counter-Strike 2 match in a browser, without launching the game. A player wants to answer: **what happened in that round, from another perspective?** A team reviewer needs accurate navigation and readable context more than decorative statistics.

cswatch is a public-capable, self-hostable review product with private-by-default personal demos. Its brand and public presentation must feel native to competitive Counter-Strike, while the viewer remains an instrument for sustained review. Refrag and FACEIT are craft/UX references, not templates, brands to copy, or asset sources.

## Accepted constraints

- TypeScript throughout; React/Three in-browser rendering, native parser in isolated CPU workers. No server GPU requirement.
- S2V offline asset preparation; no bundled proprietary game content or claim of exact Source 2 parity.
- Upload `.dem` / `.dem.zst`; Steam login/linking; verified linked FACEIT source. Future identity providers must fit the account model.
- Public by default, configurable private instance; independent registrations setting; environment locks override admin UI.
- Desktop, mobile/touch, TV/keyboard/remote; low-power/2D fallback; English/French; dark/light.
- Docker without a bundled reverse proxy, durable storage/queue, bounded untrusted parsing, weekly image rebuild and dependency maintenance.
- Premier/Competitive/Wingman demos use the normal CS2 file pipeline. Steam identity is separate from download authorization. External HLTV demos are downloaded at their source and uploaded; no HLTV catalog or scraping wrapper.
- Advanced review follows the reference viewer as a completeness reference: recorded scores/clocks, native-counter scoreboard, symmetric kill/death replays, round kill/utility lists, throw/landing navigation, all-player economy/status/inventory, event-bound throw inputs and continuous inputs with WASD/ZQSD labels, voice, chat and optional local speech subtitles. Present these progressively and preserve unknown/missing data.

## Product surfaces

**Public entry:** one compact page for logged-out visitors, centred on uploading their own demo when guest uploads are enabled. Include a GitHub link, shared language dropdown and short account/privacy information. No separate marketing pages, community catalogue or example-demo call to action. Signed-in users go directly to their library.

**Member workspace:** own demos first, upload/import as a clear primary task, processing state and recovery, private sharing, connections/account. Never fill it with fictional personal statistics.

**Viewer:** the scene occupies the whole tab with progressive controls and independent subtitles. Keep a route back to the library or public entry. Guests can upload and view their own private, temporary demos when policy permits, without creating an account. Saving notes requires an account. Explicit shared links remain separate from a removed community catalogue.

**Private instance:** a branded, useful sign-in entry, with no anonymous access to demos, asset files or community listing. New-account actions follow the independent registrations policy. Do not leak demo metadata through navigation/previews while gated.

## Brand rejection history (keep this context)

1. Black rounded-panel Aftermatch review room: too generic; oversized synthetic sample dominated the entry.
2. Light cswatch framed-sheet/sidebar restyle: still bland; mostly an admin-template appearance and no real public journey.

The next design must resolve positioning, navigation, imagery, typography, shapes and interaction together. Passing an automated design inspector does not constitute design approval. Avoid treating another palette switch as the requested change.

## Latest accepted direction — member workspace pass

The current user direction replaces the old marketing site with a single smaller upload entry. Keep the restrained charcoal/paper member palette and existing brand. Their Refrag reference remains an inspiration for clear grouping, not permission to copy branding or content. Use reusable dropdowns/dialogs, restrained keyboard focus indicators, stable button geometry and consistent scrollbars.

The viewer must occupy the **whole browser tab**. Render the match in a dedicated viewport with the playback/round dock inside it. Players, events, notes and advanced settings open over the scene. Browser fullscreen is additional, not the only way to get a full-sized viewer. No workspace sidebar or page footer should consume the viewing area. Test both portrait and landscape, as well as TV-sized viewports.

Sign-in and registration use dedicated themed pages, with restrained neutral actions and safe return intent. Do not restore the rejected giant green authentication modal. Official Steam/FACEIT artwork identifies authentication/data connections and retains separate brand notices. FACEIT remains a data source, not a sign-in provider.

Account settings and connected services belong in the user dropdown and account tabs. Keep the sidebar for match work. Communications, inputs and economy start disabled; the viewer's primary controls remain usable without enabling advanced overlays. Round events stay discoverable on phones, while the expanded round strip starts collapsed on narrow/short screens.

## Spectator HUD direction

The HUD takes its review navigation from CS demos and its live information from esports broadcasts. Recorded events sit at their actual timeline positions. Optional team rosters split across both edges on wide/tall screens, with a right-only preference and narrow-screen fallback. They use CT blue and T orange/red to show equipment and status at a glance, with selection only as a row highlight and no role headers; input actions use recognizable mouse/key shapes. Bomb actions show actor, icon and recorded progress. On small screens, expose advanced overlays progressively instead of squeezing every element onto the scene. Use space, alignment and neutral surface changes to group controls; avoid nested outlines around every panel and button.
