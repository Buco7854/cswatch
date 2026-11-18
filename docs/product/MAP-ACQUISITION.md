# Automatic official map preparation

Status: implemented behind optional policy and a separate worker, with local integration verified on 2026-11-18. The current commit’s Actions determines container verification and image publication. Previous commit `413bb88` failed a browser resize journey; its synchronized check now passes locally. See [verification](../VERIFICATION.md). This feature is strict catalog-matched preparation, not universal historical map discovery.

## What the application does

A demo becomes replay-ready independently of map preparation. `GET /api/demos/:id/map-assets` first applies the demo's ownership/sharing policy, then resolves its recorded identity against an operator-approved local catalog. It reports unavailable, disabled, queued, processing, ready or failed state with fixed safe reasons. GET never starts conversion.

When `AUTO_OFFICIAL_MAPS_ENABLED` is enabled and the dedicated worker has a fresh heartbeat, the demo owner can authorize one shared job through `POST /api/demos/:id/map-assets` with an empty body. Exact Origin, member/guest CSRF, persistent owner/IP rates and global queue limits apply. The browser can request a newly eligible job once per viewer lease. Viewers of another user's explicitly shared demo can observe readiness, but cannot start preparation.

The flag defaults off. An explicit environment value overrides the admin UI; an empty/unset flag permits admin management. Compose's optional `assets` profile supplies the separate CPU worker and its dedicated volumes. Neither the HTTP process nor the networkless replay/speech workers download game resources or execute map converters. See the [deployment README](../../README.md) for operator commands and image configuration.

## Identity and approval

The bounded additive replay `mapIdentity` records the raw map name, engine `buildNum`, `patchVersion`, demo-format GUID and known addon presence. Missing fields remain missing. Contradictory header/network evidence marks the identity conflicted. These values are recording-supplied evidence, not a Steam build ID, depot manifest, map CRC or cryptographic statement about geometry.

The operator-owned `MAP_CATALOG_FILE` defaults to `DATA_DIR/map-catalog.json` outside Compose. The initial catalog is deliberately empty:

```json
{ "schemaVersion": 1, "entries": [] }
```

Each approved entry binds all recorded identity fields, with `addonPresence: "none"`, to fixed Steam app `730`, content depot `2347770`, one nonzero uint64 manifest ID and the verified map VPK SHA-256. An optional asset version distinguishes a new preparation policy/output generation. IDs remain decimal strings. There are no catalog URLs, filesystem paths, Workshop selectors, credentials or broad download patterns. Safe official depot basenames are accepted without maintaining a hardcoded map pool. The one-shot catalog maintenance command validates and atomically installs explicit operator JSON; it does not generate approvals or match a build automatically.

Catalogs are bounded to 256 KiB and 512 entries, parsed strictly from a regular, single-link, non-writable-by-others local file. Exactly repeated canonical entries deduplicate. Distinct sources for the same complete identity are ambiguous, including sources with equal map VPK hashes but potentially different dependency versions. Unknown, incomplete, addon, conflicted, unmapped, ambiguous or invalid-catalog states do not select the latest same-name map.

Approval is operator provenance. The operator is responsible for establishing that the source corresponds to the recording identity. Matching header values alone cannot prove this, and an upload can falsify its own header. Selection of an approved source grants no access to accounts, recordings, arbitrary paths or remote URLs.

## Isolated acquisition and conversion

`MAP_ASSETS_DIR` supplies all runtime maps, agents, equipment artwork/models and landing previews. It defaults to `DATA_DIR/maps` outside Compose. `MAP_JOBS_DIR` is a separate bounded queue volume, and `MAP_CACHE_DIR` is the acquisition worker's disposable source/tool cache. Compose mounts prepared assets read-only in web, and the approval catalog read-only in both services. The assets worker receives no application database, demo originals/chunks, provider environment, sessions or real Steam account credentials.

Requests contain only approved source/identity, immutable pack ID and a server-issued generation. They never contain demo IDs, owner IDs, client URLs or paths. Results and heartbeat use bounded fixed schemas and filenames. A single OS `flock` owner processes requests; there are at most 32 pending and 512 retained requests. Owner requests are limited to six per hour and twelve per IP per hour. Scanners count every directory entry up to 1,024, including recognized atomic-write temporaries. Only the single web process, before HTTP admission, removes its own exact safe orphan request temporaries. The worker ignores those names without deleting files that a live web writer may own. Unknown/operator files, links and unsafe entries are never cleanup targets.

The worker uses anonymous official Steam acquisition with an explicitly pinned manifest. It verifies the selected map VPK against the approved SHA-256 before conversion, follows bounded CRC-checked dependencies, preflights authored shaders and preserves the existing byte/storage limits. Ordinary resource reads remain at most 128 MiB. Selected shader verification can stream at most 512 MiB per entry in 64 KiB blocks. There is no whole-game fallback.

Downloads/bootstrap and conversion have different authority. The required Linux x86-64 conversion helper installs Landlock ABI 3+ and seccomp before S2V or Node conversion. All container-scoped reads remain possible, so the container must not contain application data or secrets. Byte writes, truncation, creation, removal and rename are restricted to the fresh map stage. Converter HOME/TMP live inside that stage, separate from the downloader's home, control files and manifest pins. Network sockets, io_uring, process creation/escape, remote process/FD access, links, FIFOs and device creation are denied; ordinary native threads remain available. Unsupported confinement fails closed. This helper does not replace the demo parser's stricter existing sandbox.

Each job has a 45-minute deadline, serialized acquisition/conversion, periodic free-space checks and the unchanged 512 MiB reserve. Worker cache and prepared-asset budgets are 16 GiB and 32 GiB. Only exact worker-marked old source caches and orphaned preparation stages can be reclaimed; operator folders, published packs and arbitrary cache paths are not deletion candidates. Host quotas, memory limits, monitoring and sufficient free space remain necessary.

## Publication, crashes and retries

A pack ID is SHA-256 of the canonical full approval, including the optional asset version. Request generation is separate from pack identity. Complete self-contained desktop/mobile models, calibrated overview, environment and provenance must validate before publication to `MAP_ASSETS_DIR/packs/<packId>/maps`.

Publication uses descriptor-anchored, same-parent `renameat2(RENAME_NOREPLACE)`, without an empty destination placeholder or replacement of an existing pack. A ready result is written only after validation and a fresh approval check. Every versioned descriptor/model/image request checks current unambiguous catalog approval and ready status. File bounds, no-follow/single-link opens, content hashes, instance access policy and disconnect-safe streaming still apply. Removing approval prevents subsequent pack requests; it cannot retract files already downloaded.

A durable attempt ledger survives worker crashes. At most three fresh conversions run per request generation. Recovering an already valid published pack does not consume another conversion attempt. Exhaustion becomes a fixed failure rather than an endless crash/restart loop.

After 300 seconds, an owner may explicitly retry eligible `source_unavailable`, `storage_limit`, `preparation_failed` or `worker_interrupted` failures when policy, heartbeat, CSRF, rates and pending capacity allow. The server writes a fresh random generation before removing the old terminal result, preserving approval and pack ID. If safe removal fails, the terminal failure remains. `source_mismatch` and `approval_removed` remain terminal for that approval. A changed approved source creates a distinct pack ID.

The browser never automatically retries a failed job. It performs a bounded read-only cooldown check and offers an explicit retry action when eligible. Repeated clicks and uncertain POST responses do not create parallel retries. Leaving the viewer cancels that viewer's HTTP work, not the shared durable job.

## Viewer behavior and limits

The browser keeps discovery scoped to demo/user/map identity and validates only fixed local pack URLs. It distinguishes preparation from subsequent geometry/texture loading, without invented percentages or finish estimates. Queued/processing polling backs off to ten seconds and stops after a bounded wait. Replay controls and events remain usable while assets are unavailable.

Automatic mode never silently substitutes a version-blind manual pack. When automatic matching is disabled, explicitly installed manual packs remain available with `version-unverified` status. Uploaded demos with no usable model or calibrated overview show a preparing/unavailable state instead of unexplained player dots. Compact radar requires a usable calibrated overview. The labeled synthetic practice scene remains separate.

The preparation server remains CPU-only; browser WebGL uses the viewer device's GPU. Successful local checks do not establish Source 2 visual parity, complete shader/animation behavior, native smoke physics or physical Galaxy S24/TV performance.

## What remains unresolved

Automatic catalog generation, complete historical manifest lookup and Workshop/private/custom content are not implemented. Empty catalogs are honestly unmatched. Native installation of a particular map is also bounded by exporter capabilities and host storage; the local Cache pack remains unpublished after hitting the disk reserve.

The public fixture's 7,213-byte game-session manifest was decoded under the required parser sandbox: LZSS expands it to 14,187 bytes containing 450 resource paths, with only zero padding after parsing. It contains no map paths or content checksum. The upstream decoder's resource handles hash filenames, not payloads. [Clarity manifest implementation](https://github.com/skadistats/clarity/blob/master/src/main/java/skadistats/clarity/processor/resources/Resources.java)

Anonymous official PICS metadata can identify a current app build and its paired content/Linux depot manifests. Future snapshot maintenance could enumerate new official map basenames and inspect pinned engine metadata, preserving every observed identity/source conflict. However, recording headers do not include those Steam identifiers, and an engine build can span content changes. Reading engine metadata or running a minimal headless version probe has not been established as a universal exact matcher. Never infer a historical layout from latest-by-name, protocol equality, a GUID, engine date or resource-list hash. Publisher-only history APIs and unavailable historical manifests remain external limitations. [Valve application metadata API](https://partner.steamgames.com/doc/webapi/ISteamApps), [CS2 ServerInfo schema](https://github.com/SteamTracking/GameTracking-CS2/blob/master/Protobufs/netmessages.proto)
