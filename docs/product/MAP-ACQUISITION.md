# Automatic official map preparation

The service prefers a unique operator-approved source for the recording. When no such source can be selected, it can prepare a clearly disclosed latest official snapshot. The user explicitly accepted this fallback. A latest snapshot is not presented as the map revision originally used by the recording. Both modes use the separate optional asset worker and default-off `AUTO_OFFICIAL_MAPS_ENABLED` policy.

A demo becomes replay-ready independently of game assets. `GET /api/demos/:id/map-assets` applies its ownership/sharing policy and reports source selection, acquisition state and fixed local asset URLs. GET never enqueues or contacts Steam. An eligible owner or guest can authorize a shared job with an empty-body POST, exact Origin, CSRF, persistent owner/IP limits and bounded queue capacity. Viewers of someone else's explicitly shared demo cannot start acquisition. Environment values override admin policy.

## Recorded evidence and source selection

The replay's optional `mapIdentity` retains raw map name, engine build number, patch version, demo-format GUID and known addon presence. Missing values stay missing. Contradictory evidence is marked conflicted. These are unsigned recording fields, not a Steam manifest or a content checksum. The current CS2 header and ServerInfo schemas do not provide the old CS:GO `map_crc` field. [Demo header schema](https://github.com/SteamTracking/Protobufs/blob/master/csgo/demo.proto), [CS2 ServerInfo schema](https://github.com/SteamTracking/Protobufs/blob/master/csgo/netmessages.proto).

ServerInfo and spawn-group messages also carry resource manifests. The known decoder reads directories, filenames and extensions, and derives handles by hashing resource paths. Those handles do not hash file contents. Our retained public-fixture probe decoded 450 resource paths without a map content checksum. A resource-list fingerprint may help compare recordings, but cannot establish that two files with the same names contain the same geometry. [Primary decoder implementation](https://github.com/skadistats/clarity/blob/master/src/main/java/skadistats/clarity/processor/resources/Resources.java).

Selection follows these rules:

1. Prefer a complete non-addon recording identity with exactly one approved catalog source. Ready approved packs remain preferred over newer official metadata.
2. An approved job whose terminal failure is `source_unavailable` may select a fresh latest snapshot. Integrity mismatches and removed-approval failures remain terminal for the selected source.
3. Missing build fields, an unmapped identity, ambiguous approvals or an unavailable catalog can use latest only when the recording's safe bare map name appears in worker-observed official depot metadata. Explicit addon evidence, conflicted identity and disagreement between recording map names block this fallback.
4. Caller-supplied URLs, depot IDs, manifest IDs, content hashes, paths and converter arguments are never accepted. A user-controlled map name is only a lookup key, not evidence that its content is official.

The optional catalog binds the full recorded tuple to fixed app `730`, depot `2347770`, one uint64 manifest and a map VPK SHA-256. It starts empty and is bounded to 256 KiB/512 strict entries. Canonical duplicates deduplicate. Different sources remain ambiguous even when their map VPK hashes match, because dependencies may differ. Removing an approval revokes that source and its URLs, not the global latest policy for the official map name. An approval is operator provenance, not cryptographic proof of the original recording's geometry. The isolated maintenance command validates supplied JSON without inventing approvals. An empty catalog does not prevent the disclosed latest mode.

## Current official inventory

The asset supervisor lists only the fixed official selector `game/csgo/maps/*.vpk` in anonymous app `730`, depot `2347770`. The wildcard is used for metadata listing, never a whole-game download. Only direct, validated bare-map entries become membership. New official map basenames need no application whitelist change. Nested prefab/package paths cannot become caller-selectable maps.

`official-inventory.json` in the job volume records one pinned manifest, check time, map names, SHA-1 hashes and byte sizes. It is bounded to 128 KiB/256 unique maps, stored atomically through owned no-follow controls and refreshed at startup and approximately hourly. Failure backoff starts at 15 minutes and increases to one hour to respect upstream login limits. New selection requires metadata at most 24 hours old. A stale validated inventory may retain access to a previously prepared immutable snapshot, but cannot authorize a new acquisition.

A Steam depot manifest supplies file sizes and SHA-1 hashes for a particular source build. It does not map a demo header to that build. The downloader verifies the selected manifest, exact map size and SHA-1, then computes the downloaded map's SHA-256 before conversion. Changing the current inventory never rewrites an already queued source pin. A denied pin fails rather than silently switching that job to another version. [Valve build/manifest documentation](https://partner.steamgames.com/doc/store/application/builds), [SteamKit manifest-request API](https://github.com/SteamRE/SteamKit/blob/master/SteamKit2/SteamKit2/Steam/Handlers/SteamContent/SteamContent.cs).

## Isolation and resources

The asset image and volumes contain no application database, recordings, accounts, provider environment or Steam account credentials. `MAP_ASSETS_DIR` holds prepared output, `MAP_JOBS_DIR` holds bounded control state and `MAP_CACHE_DIR` holds disposable source/tool data. Web mounts prepared assets read-only. The catalog is read-only to web and worker. Replay and speech workers remain networkless and have no asset-service mounts.

A single `flock` owner processes jobs. There are at most 32 pending and 512 retained requests, six owner requests per hour and twelve per IP per hour. Request scanners stop at 1,024 directory entries. Only single-web startup reclaims its exact safe orphan request temporaries. The worker ignores live web temporaries and preserves unknown/operator files.

Acquisition uses fixed anonymous Steam selectors and pinned tool downloads. Each S2V/Node conversion subprocess requires Linux x86-64, Landlock ABI 3+ and seccomp. Byte writes are confined to its fresh stage, including HOME/TMP. Network sockets, process creation/escape, remote process/FD access, links, metadata mutation and unsafe descriptor operations are denied. Native threads remain available. Unsupported confinement fails closed. The trusted supervisor still runs bounded Sharp validation/compaction outside the child sandbox, so image bounds, container limits and maintained dependencies remain necessary.

Jobs retain the 45-minute deadline, 16 GiB source/tool cache and 32 GiB prepared-asset budgets, periodic disk guards and 512 MiB free-space reserve. Only marked obsolete source caches and orphaned stages are cleanup candidates. Ordinary native resource reads stay capped at 128 MiB. Large shader CRC checks stream at most 512 MiB in 64 KiB blocks. Host quotas and adequate export scratch remain necessary.

## Immutable publication and recovery

Approved job IDs hash their full canonical approval. Latest queue IDs hash the official map/manifest/SHA-1/size selection. Latest content pack IDs separately include the post-download SHA-256. Request generations remain independent of both IDs.

Before publication, both self-contained GLB tiers, calibrated overview, environment and provenance must validate. Latest source proof is persisted before conversion so a crash after publication can recover the same content without another download. A strict marker binds the queue selection, actual source and content ID. The stage is renamed only after its converter exits, then published by same-parent `renameat2(RENAME_NOREPLACE)`. No existing immutable pack is overwritten.

Delivery rechecks instance access, ready status and source evidence. Approved packs require current unambiguous approval. Latest packs require their validated marker/request/result, matching content ID and official-name membership. Updating the current manifest does not relabel or invalidate previously published snapshot URLs. Manual map-name packs remain explicitly `version-unverified` and are not silently substituted in automatic mode.

A durable ledger allows three fresh conversions per request generation. Valid published-pack recovery consumes no new conversion attempt. Eligible transient failures can be explicitly retried after 300 seconds under the same policy/CSRF/rate/capacity checks. The fresh generation publishes before clearing the old failure. A latest retry retains verified source proof as processing state when needed to recover an already-published pack. Source mismatches and removed approvals remain terminal for that source. The browser never automatically retries failed jobs or cancels shared work when its own viewer closes.

## Viewer and operator evidence

The viewer distinguishes approved source, latest official snapshot, unverified manual pack and unavailable assets. Latest disclosure includes its selected Steam manifest and metadata check time. A prepared source is not proof of the recording's original revision, nor evidence that the native scene has finished loading. Actual model/material image decoding gates rendering. A calibrated 2D overview remains usable independently of 3D and WebGL.

For read-only operator diagnostics, run `node tools/assets/inspect-map-identity.mjs --replay /local/validated/manifest.json --catalog /local/catalog.json`. Omitting `--replay` reads bounded JSON from stdin. The tool reports map identity, missing/conflicting fields and approval candidates without outputting actors, communications, credentials or local provenance. It does not parse demos, acquire resources, approve sources or assert original map bytes.

Complete historical resolution, Workshop/custom content and exact native renderer parity remain outside this implementation. Retain prepared snapshots and their provenance rather than assuming Steam will continue serving an old pin. The locally prepared Cache overview is 2D evidence only. New official metadata listing does not establish a successful Cache 3D export or real-device performance. See [verification](../VERIFICATION.md) and [deployment](../MAP-ASSETS.md) for current evidence and operational limits.
