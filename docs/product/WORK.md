# Active work — coordinated product rebuild

Updated 2026-11-16. The user approved the general public/member visual feeling, but asked for a product-grade rebuild of architecture and UX around it, specialized agents, exhaustive preservation of requirements, proper security/verification, and an explicit push to `main` when ready.

## Current acceptance scope

- Preserve the approved landing and neutral charcoal/light member feel; fix UI at its source rather than stack cosmetic overrides.
- Work navigation is for demos/review/pro matches. Account/security and connections belong in the user dropdown/account area, not primary sidebar destinations. Maintain intentional guest/member/private/registration-disabled journeys.
- Provide an explicit pro/HLTV demo experience. Do not invent playable match data, bypass HLTV challenges, or claim an unofficial API is official. Document upstream limitations and offer working, bounded ingestion of operator-curated demo resources.
- Viewer uses the whole browser tab by default. Controls remain in the viewport; player/review panels are progressive. Fix dropdown behavior and the oversized/awkward light-theme play control. Preserve every existing overlay, camera, skip, note, and quality feature.
- Keep TypeScript, CPU server, native parsing isolation, S2V pipeline, English/French, desktop/mobile/TV, dark/light, private-by-default demos, extensible auth, env/admin policy precedence, Docker behind an existing proxy, and weekly secure image/dependency maintenance.
- Improve unsafe/unbounded or fragile architecture uncovered by review; retain honest limits for proprietary assets, provider credentials, real device performance, and Source 2 parity.

## Team and file boundaries

Root owns integration, product decisions, QA, docs/handoff, and final commit/push. Specialists have bounded file ownership announced in their tasks. No agent commits, pushes, resets, deletes another agent's work, or writes outside its scope without coordinating. All source changes share this checkout. Use additive migrations and typed contracts; no destructive data changes.

## Required evidence before release

1. Build and formatting/locale checks; meaningful parser/auth/ownership/ingestion tests.
2. Real upstream raw/compressed demo integration and new pro-data/source controls.
3. Browser tests for public/member/private/registration-disabled policy, EN/FR, theme persistence, account/connection journeys, full-tab viewer/panels/dropdowns/notes/round navigation.
4. Rendered production checks at 320, 390, 768, 1440, 1920 and landscape, in both themes/languages; inspect screenshots, not only bounds.
5. No proprietary assets, session/provider secrets, temporary databases or QA accounts in Git. No false Source 2/Steam/HLTV/partner capability claims.
6. Update STATUS, ARCHITECTURE, SECURITY, VERIFICATION and HANDOFF. Commit focused changes, verify remote main, push explicitly authorized main update, then inspect CI and address failures.

## Current workstreams

- [ ] Backend architecture/security/native ingestion/replay delivery review and implementation.
- [ ] Product navigation/account/connection UX and accessible viewer-control refinement.
- [ ] Honest HLTV/pro-demo catalog and secure curated source ingestion, with UI and tests.
- [ ] Root integration, CSS/module cleanup, regression tests, deployment verification and release.

This is a scoped rebuild of a working POC. Preserve proven behavior; "from scratch" is not permission to drop requirements or rewrite secure working code without a concrete reason.
