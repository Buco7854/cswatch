# Feature status

This file is part of the product contract. Update it when implementation or verification changes.

## Implemented

- Distinct branded public landing, viewer/import feature pages, self-hosting page, public exploration and member library routes. Private-instance sign-in entry, policy-aware calls to action and safe auth return paths.
- English/French public/app copy, controls, dynamic states/errors, accessibility labels, localized dates/numbers/plurals, and persisted language selection. Shared dark/light identity and original replay mark.

- TypeScript Fastify backend, React app, shared replay types, SQLite/WAL durable queue and separate native parser process.
- Local username/password accounts; Steam OpenID login/linking; future-provider-friendly identity ownership table. Secure session/CSRF/origin/host policy, rate limits, private demos/notes, audited policy changes.
- `.dem` / `.dem.zst` uploads, magic validation, quotas, bounded decompression, processing status/failure UI, retention, owner rename/delete/share.
- Real parser adapter exercised on an upstream Mirage demo: players, position/angle/HP/armor/money/ammo/duck/flash state, events, rounds/live starts/ends, freeze/timeout flags, grenade trajectories.
- Browser orbit, overhead, player perspective, and 2D position modes; interpolation; timeline/seeking/speeds; round jumps; next live round; manual/automatic dead-time skipping; private timestamp notes.
- Progressive options: x-ray player shapes, centered perspective crosshair, position radar, elimination feed, movement trails, grenade paths, approximate utility zones, quality selection. Device-local persistence.
- Light/dark themes; responsive desktop/tablet/mobile layouts; focus-visible controls; keyboard/remote directional focus, shortcuts, touch orbit/zoom, and fullscreen where supported.
- Clearly labeled original training sample, separate from uploaded/community matches.
- Operator-installed map assets, desktop/mobile tier discovery, optional generic animated agent GLBs, and CPU S2V glTF packing/optimization/provenance tools.
- Verified-Steam FACEIT profile association, match history adapter, and approved signed download import adapter. Steam next-match share-code discovery adapter.
- Admin policy toggles with environment precedence and secret-free configuration; terminal admin creation/password reset.
- Docker/Compose without Caddy, Monday no-cache image rebuild/publishing workflow, weekly dependency update PRs, architecture/security/agent handoff docs.

## Requires operator resources or external verification

- CS2 map/agent/weapon assets are not bundled. The S2V export step needs installed CS2 content and the operator's S2V binary. Optimization was tested with a synthetic glTF; a full CS2 export/alignment has not been tested in this environment.
- Steam/FACEIT end-to-end network flows need real accounts/keys and FACEIT Downloads API approval. Tests verify local access policy and Steam callback rejection, not a live login or successful partner download.
- Container execution/Compose hardening must be exercised on a Docker host; Docker is not installed in the development environment. CI defines the image build/runtime smoke test.
- Real-device performance remains unverified. A Galaxy S24 is a target, not a certified benchmark. Browser viewport checks do not measure mobile GPU memory or thermals. TV browser/remote behavior varies by model.

## Not implemented / do not claim

- Source 2 engine execution in-browser or exact visual/gameplay parity.
- Reconstructed baked map lighting/light probes/skyboxes, exact shaders or material blending.
- Exact character AnimGraph/poses/player-specific skins, weapon/bone attachments or first-person weapon animations. Optional agent clips are generic deterministic approximations.
- Volumetric smoke simulation, exact fire spread, weapon effects, positional game audio or voice chat.
- Automated Steam Game Coordinator demo resolution/download/sync; Steam login alone cannot provide this.
- FACEIT as a social login provider. It is a verified linked data source, as requested for current Steam-only social auth.
- Per-round replay streaming/chunk caching. Entire replay loads into memory; oversized prepared replays fail at a 200 MB uncompressed ceiling. Improve this before claiming long-match support on memory-constrained phones/TVs.
- Exact server-rendered CS2 video, GPU streaming, AI coaching, clips/video exports, drawing collaboration, MFA, email recovery, moderation, or multi-host horizontal scaling.

The next high-value work is real CS2 asset validation, chunked replay delivery for mobile, stronger per-job filesystem sandboxing, exact weapon/animation/effects work, and real-device performance testing. None should be represented by a decorative UI switch before it works.
