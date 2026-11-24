# Map assets

Official map preparation is optional and defaults off. The web app prefers a unique operator-approved source for the recording. If a historical selection is unavailable, it can use a clearly disclosed latest official snapshot from worker-observed Steam metadata. Latest geometry is never presented as the original recording's revision. The separate worker prepares game assets on the CPU and browsers render them locally.

The worker requires Linux x86-64, Landlock ABI 3 or later and seccomp. The published application image stays the default Docker target. The separate assets image is `ghcr.io/buco7854/cswatch:assets-latest`, with revision tags named `assets-sha-<commit>-<run>`. Neither image includes game artwork, recordings or prepared Steam assets.

Deploy published application and asset images from the same verified revision. Release requires a successful workflow for the exact source revision. For unpublished local work, build the assets target and set `CSWATCH_ASSETS_IMAGE` to that local image.

## Run and update the asset worker

The normal Compose stack starts web, parser and assets services. Start or update all three explicitly:

```sh
docker compose pull web worker assets
docker compose up -d web worker assets
```

Set `AUTO_OFFICIAL_MAPS_ENABLED=true` in `.env` to lock the feature on, or leave it empty and enable it in the admin UI. An empty value permits UI management and initially defaults off. The worker refreshes bounded official map metadata at startup and about hourly. With automatic acquisition enabled, a known official name can use the disclosed latest mode without any catalog entries. Optional catalog approvals remain preferred for established historical sources. Steam/FACEIT credentials and `.env` are never passed to this service.

The long-running assets service starts with the normal Compose stack. Keep it running for metadata refreshes, eligible map jobs and optional native artwork/sounds. Map acquisition still defaults off independently of service startup. Update its separately published image alongside the application image. Add the optional `transcription` service and its profile when using subtitles.

Compose keeps these stores separate:

| Volume                | Web                      | Asset worker       | Demo/transcription workers |
| --------------------- | ------------------------ | ------------------ | -------------------------- |
| `cswatch-map-assets`  | Read-only                | Read/write         | Not mounted                |
| `cswatch-map-jobs`    | Read/write               | Read/write         | Not mounted                |
| `cswatch-map-catalog` | Read-only                | Read-only          | Not mounted                |
| `cswatch-map-cache`   | Not mounted              | Private read/write | Not mounted                |
| `cswatch-data`        | Private application data | Not mounted        | Private application data   |

The asset service has its own egress network, no published ports, a read-only root, UID/GID 1000, all capabilities dropped and `no-new-privileges`. Its defaults are 8 GiB RAM, two CPUs and 128 processes. Parsing and transcription retain `network_mode: none`. Native S2V and Node conversion subprocesses have an additional required filesystem/network/process boundary even though the acquisition service can reach Steam and the pinned tool sources. Landlock confines byte writes to the current stage; seccomp also denies metadata mutation, cross-process signals/limits and unsafe descriptor operations. The trusted supervisor still performs bounded Sharp image validation/compaction outside that child boundary. The asset container and resource bounds remain necessary; this does not sandbox every native image decoder in the supervisor.

New volume roots are owned by UID 1000 in both images. Bind-mount replacements need equivalent ownership and permissions. For existing manual packs, mount the complete prepared maps tree at `/map-assets` read-only in web. Use the same tree read/write in the asset worker if automatic preparation is enabled.

The private `/map-cache` tool volume must permit execution of checksum-verified binaries. Keep the container root read-only; bootstrap supplies its own private writable HOME and bundle directory under disposable cache staging. No writable image home or additional capabilities are needed. Initial setup logs `map.toolchain_preparing` and then `map.toolchain_ready`; cold tool preparation has a bounded 20-minute budget separate from the subsequent inventory listing.

## Readiness and troubleshooting

Administration lists worker-prepared snapshots with a reusable deletion confirmation. Deletion removes the selected map/radar/landscape snapshot for all demos using it while retaining recordings. The HTTP service queues an exact reviewed marker/version, and the asset worker performs retirement and bounded cleanup. Operator-managed directories are listed read-only. A deleted snapshot is not downloaded again automatically. Its demo owner can explicitly request preparation again after cleanup. The assets service must be running for deletion.

The same page shows fixed native-player, HUD-artwork and equipment preparation. Fresh installations obtain these shared banks automatically after successful official inventory discovery. Core player models and HUD icons come first, then the landing artwork and sounds, then one equipment model or first-person rig at a time. Unsupported fixed resources remain unavailable rather than being replaced with another weapon. Safe progress and a bounded retry action diagnose failed preparation. This does not provide arbitrary asset downloads or choose historical game versions. Existing operator banks are preserved.

Administration separates automatic-policy state, the worker heartbeat, the official-list freshness and the optional historical catalog. The administrator-only diagnostic response contains bounded status/count/version fields, without host paths, credentials or Steam requests. Viewer explanations distinguish automatic preparation disabled, worker unavailable, official list missing/stale, unknown official map, invalid recording identity and lack of owner authorization. An empty catalog is not itself an error for latest-official preparation.

For a newly uploaded Ancient recording, enable automatic maps and confirm that the assets service is running and has a fresh official list containing `de_ancient`. No historical Ancient approval is required for the clearly labeled latest mode. Inspect the service with:

```sh
docker compose ps
docker compose logs --tail 100 assets
```

The viewer rechecks missing-worker/list bootstrap states after 2, 5, 15 and then 30 seconds, bounded to 45 minutes. These are read-only checks. Once an owner or original guest capability becomes eligible, it can submit one source-scoped acquisition request under the existing Origin/CSRF/rate controls. A read-only availability action can refresh diagnostics; failed conversions still require an explicit eligible retry. Starting a worker does not silently restart a failed job or label a manually installed map as a historical match.

Fresh inventory requires working anonymous Steam access, available tool sources and sufficient storage. Failed metadata refreshes back off, and an explicit Steam exit 4 pauses all new service Steam work for fifteen minutes while heartbeats continue. Preserve the 512 MiB reserve and review source/storage/confinement failure codes before retrying. A valid current list cannot guarantee that an older selected manifest remains accessible.

Cold first use can download, verify and compile the fixed toolchain. It retains the tool preparer's existing 20-minute overall budget. The separate three-minute inventory deadline starts after those tools verify, and the actual Steam listing process stays capped at two minutes. Operator cancellation remains `interrupted`; actual deadlines remain `timeout`, including generic child-process cancellation wrappers. Safe `map.toolchain_preparing` and `map.toolchain_ready` events mark that boundary. No tool/source/storage/ownership checks are relaxed.

If updated worker logs still show only `{"event":"map.inventory_unavailable"}`, check the assets image separately from the web image and recreate that service. The current worker includes fixed diagnostic fields. A `toolchain` failure occurs before Steam listing, so first inspect the prepared cache/lock and tool acquisition rather than historical map approvals. Do not delete cache/operator files based solely on the broad phase code.

Inventory failures log a fixed safe `phase`, `code` and `retryAt`, with a bounded process `exitCode` when available. The phases are storage, toolchain, downloader, metadata and publication. For example, `phase: "storage", code: "storage_limit"` points to the reserve/cache ceiling; `phase: "toolchain", code: "network_unavailable"` identifies recognized network failure while preparing tools. Steam exit 4 is `steam_rate_limited`, not an unavailable historical source. The validated failure remains in worker heartbeat/admin diagnostics until a successful refresh clears it, including when the service subsequently stops. Raw errors, URLs, credentials and host paths are never included. Paste these structured fields when seeking help instead of private cache logs.

Administration also shows the web image's immutable source revision and UTC build time from `/api/config`. CI supplies these at build time and verifies the running image against the expected revision; absent local-build fields remain unknown. Pulling a new web image alone does not update the asset worker's separate image or existing immutable prepared assets.

## Graphics coverage for the official map inventory

The asset worker records a graphics audit in each prepared desktop and mobile tier. It inventories exported primitive definitions by Source shader, material treatment and feature. It picks up to 24 camera poses on actual triangles in glTF metres, giving distinct features a turn before choosing more materials from one family. A future map can use these paths as soon as the worker sees it in a Valve depot manifest. New shader families appear as unknown. Omitted materials remain in the inventory. Source-backed entries identify a recovered property, such as constant glass opacity. They do not certify the rest of that material or map.

Read the snapshot on the asset worker using the same volumes and UID as the service.

```sh
docker compose exec -T assets node tools/assets/map-graphics-inventory.mjs > graphics-inventory.json
```

Each map in the observed manifest has a row, including unrequested, queued and failed jobs. A missing inventory produces a diagnostic and exit code 1. A stale snapshot retains its observation time. Prepared historical approvals appear separately. For published tiers the report includes the audit path, shader decisions, model size, lighting counts and prepared environment features. Compact has a separate geometry and triangle count. Its flat materials do not support detailed shader comparisons. Inventory reads leave Steam, the queue and the asset files untouched.

To check a tier on a QA workstation, mount the pack read-only and run the [offline capture procedure](../scripts/graphics/README.md). Give the capture tool a new private output directory. To join these results on a host where the same files are mounted, pass `--captures DIR` to the inventory command and put each report under `DIR/<packId>/<tier>/capture.json`. The join checks the exact tier, model, audit and ordered camera list. Counts distinguish materials shown on screen, missing views, prior viewer baselines and supplied external references. Comparisons use the supplied camera, source revision and projection. A reproducible baseline measures change within cswatch. Comparison to CS2 or the reference viewer requires a corresponding independently captured frame.

To compare what a player sees during a recorded match, [capture a production POV](../scripts/graphics/README.md#capture-a-recorded-production-pov) at the same tick and player. With worker-managed maps, supply the mounted jobs directory and configured catalog. The tool stages the selected pack metadata privately and revalidates the live generation before writing the frame. Add `--play-seconds 12` to measure moving playback from the same pose.

To capture every prepared detailed tier in one observed inventory, run this loop from the checkout on the QA host. Set `MAP_ASSETS_DIR` to the mounted asset root and `CAPTURE_ROOT` to a new private directory. The loop visits the manifest and historical approvals, sequentially. Preparation stays under the normal acquisition policy.

```sh
set -eu
umask 077
: "${MAP_ASSETS_DIR:?required}" "${CAPTURE_ROOT:?required}"
mkdir -m 700 "$CAPTURE_ROOT"
jq -r '(.maps[]?, .approved[]?) | select(.status == "ready") as $p
  | ("desktop","mobile") as $t | $p.tiers[$t] | select(.status == "audited")
  | [$p.packId, $t, .auditPath] | @tsv' graphics-inventory.json > "$CAPTURE_ROOT/tiers.tsv"
while read -r pack tier audit; do
  mkdir -p "$CAPTURE_ROOT/$pack"
  node scripts/capture-graphics.mjs --audit "$MAP_ASSETS_DIR/$audit" --out "$CAPTURE_ROOT/$pack/$tier"
done < "$CAPTURE_ROOT/tiers.tsv"
```

## Automatic landing artwork

After a successful current-inventory refresh, an idle worker first checks for existing operator previews, then can prepare one fixed native 720p Mirage screenshot. The source is exactly `panorama/images/map_icons/screenshots/720p/de_mirage_png.vtex_c` from anonymous app `730`/depot `2347770` at the selected manifest. Package SHA-1, entry CRC and output hashes are verified; only that resource and its package index are selected. It does not download the game or derive artwork from a private demo.

S2V decoding and Sharp PNG normalization both run in conversion-only children with no network and stage-only writes. Downloader manifests, controls, home and cached tools stay outside those writable roots. The image remains at most 1600×900 and 8 MiB. The same-parent `--publish-preview` helper accepts only shared fixed map names and refuses an existing target. Any existing fixed operator preview is preserved. The landing periodically checks for newly available local artwork, with a usable no-image fallback; no image is bundled in Docker or fetched from a remote image service.

Artwork preparation has a five-minute deadline, bounded attempts and the shared Steam cooldown. Queued map work has priority. The artwork follows the player models and HUD icons, and the sound bank precedes the longer weapon queue. Artwork failure never changes map/replay readiness. It preserves the same storage reserve and prepared-asset accounting as other service work.

The November 19 local native conversion proof used the retained CRC-verified screenshot from manifest `807392217824910805`: confined S2V and Sharp produced the exact existing 1280×720 PNG without changing installed artwork. That is cached-source conversion evidence, not a new current-manifest download. A new current-source artwork acquisition was not run on the disk-constrained host. See [verification](VERIFICATION.md) for the active revision's release gates.

## Third-person equipment and agent packs

The asset worker prepares the weapon-frame equipment and the 101-clip agent banks. Equipment metadata uses schema 2 and agent animation declarations use schema 3. The equipment packer removes the S2V studio transform using each model’s named weapon joint. The standalone defuser retains its separate authored origin. Held equipment uses the animated weapon axes and the model’s authored grip. Analyst replays preserve recorded rotations for dropped, planted and thrown items, with nearby floor support for resting items.

The two native banks are validated against fixed identities and pinned Valve resources.

## Automatic first-person rigs

The asset worker prepares default authored hands, the exact held item, its idle pose and draw clip, and recorded firing and reload clips where applicable. It alternates the static and first-person items in fixed priority order after agents and HUD icons. The administrator can see the current item, counts, unsupported IDs and retry state. A missing official resource produces `missing_official_resource`. The worker pins an official depot manifest for the category and never substitutes another item's mesh.

The instance authorizes one bounded viewmodel catalog. Each previewed first-person asset comes from its validated byte count and SHA-256 descriptor. Missing rigs use static equipment. The active rig has an independent bounded cache, so world-model leases cannot exhaust its mobile budget. Rig files embed their own textures. Playback uses the recorded active item, draw transition, shot and reload evidence. The selected source supplies one default arms model for both sides. Stock knives use their respective models.

Prepared maps and shared presentation use a preparer revision in their identities. An invalid current map is prepared again within the existing attempt and storage limits. The worker safely retires only positively identified, allowlisted content. Old format generations are ignored and operator files are preserved.

## Authored lighting and environment

The installer checks the selected official map VPK against the depot manifest, then reads the compiled world and its own CRC-checked atlas references. Lightmap version 8.2 uses HDR irradiance, direction and the active sun's authored stationary shadow slot. Each detailed tier validates the atlas and binds supported secondary UVs within its existing texture budget. Unsupported formats, missing bindings and insufficient optional scratch space retain PBR with a fixed reason in installation provenance. Vertex-light streams require an explicit export binding before they can be used.

Trusted operators preparing an exact S2V export can supply `--irradiance-exr`, `--sun-shadow-png`, `--sun-shadow-channel` and verified `--lighting-direction-png` to `tools/assets/prepare-map.mjs`. All inputs must share the geometry's source version and atlas layout. The automatic path resolves supported painted layers from each prepared material's declared texture roles using the selected package indexes.

The renderer uses each map's authored sun direction, supported cubemap fog and untextured gradient fog. A standalone sky can ship without a landscape, and a map with no authored sky can still supply fog or grading. The world pack drops tool surfaces and effect planes whose transparency the exporter could not resolve. It retains validated alpha cutouts and authored masks that the converter can reproduce. Radar calibration retains the official north-up projection, records authored floor ranges and uses the primary radar raster.

The preparer can also bind modern materials by matching their exported mesh, material and draw counts to the verified compiled model. Its vertex layout and material input signature establish which glTF coordinate addresses the atlas. The pinned exporter applies the world's atlas scale. Draws with conflicting signatures keep the ordinary material path. The renderer can use indirect light when the compiled draw declares vertex lighting and the verified `COLOR1` layout matches the exported data channel. Foliage tint and wind channels stay separate. Verified water materials can retain a static approximation of their fog tint, roughness and angular reflection on desktop and mobile. Unsupported water and the Compact tier omit the surface. [Water inputs and measurements](../tools/assets/README.md#refractive-water-approximation) [Pinned exporter](https://github.com/ValveResourceFormat/ValveResourceFormat/blob/942df5b37ebbde6153f6c488880b91d4bed003e6/ValveResourceFormat/IO/Gltf/GltfModelExporter.Mesh.cs) [Compiled draw flags](https://github.com/ValveResourceFormat/ValveResourceFormat/blob/942df5b37ebbde6153f6c488880b91d4bed003e6/ValveResourceFormat/Resource/ResourceTypes/Mesh.cs)

Map preparer revision 5 gives approved and latest-official map jobs and packs new identities. Opening a demo can request a new pack through the normal acquisition policy and source checks. The worker publishes to the new identity and preserves earlier pack files, job records and operator-managed assets. Equipment and agent banks have an independent revision.

## Latest official snapshots

No manual map whitelist or default approval is needed. The worker lists direct map VPK entries only from fixed anonymous app `730`, depot `2347770`. A fresh inventory binds safe map basenames to one Steam manifest, SHA-1 and byte size. It is capped at 128 KiB and 256 unique names. New selections require a check within 24 hours. Failed refreshes back off rather than opening a login loop. The inventory is not a statement about an uploaded demo's original map version.

An owner/guest request contains no source arguments. The server derives its selection from that inventory and the recording's safe map name. Explicit addon/conflicting evidence and unknown official names remain blocked. Downloaded map size and SHA-1 must match the selected snapshot, and the worker computes SHA-256 before conversion. Queued jobs keep their manifest pin even if Steam updates again. A denied pin fails without silently selecting another one inside the same job.

The viewer distinguishes a latest snapshot from an approved historical source and displays its manifest/check time. Existing immutable snapshot URLs remain stable after inventory refresh. Stale metadata cannot create another acquisition, but can retain a validated cached snapshot. These rules do not promise exact historical geometry or continued access to old Steam manifests.

## Optional approved historical sources

The initial catalog is deliberately empty:

```json
{ "schemaVersion": 1, "entries": [] }
```

Each entry must match the complete recorded `map`, `buildNum`, `patchVersion`, `demoVersionGuid` and `addonPresence: "none"`. Its source must identify app 730, depot 2347770, one pinned uint64 Steam manifest and the expected SHA-256 of the selected map VPK. An optional `assetVersion` labels preparation provenance. See the [shared contract](../shared/map-acquisition.d.ts) and [validated catalog schema](../backend/src/map-catalog.ts).

Recorded build fields are unsigned evidence from the demo, not Steam manifest IDs or cryptographic layout proof. Approvals are explicit operator provenance. A complete matching tuple can prefer that approved source. Incomplete or ambiguous identities can instead use disclosed latest mode when official membership is known. Explicit addon/conflicted evidence remains blocked. A historical source with terminal `source_unavailable` can use a fresh latest selection, while integrity and still-selected removed-approval failures do not silently switch sources. No arbitrary URL, caller-supplied source path, whole-game selector or authenticated Steam account is accepted.

The authorized replay manifest at `GET /api/demos/:id/playback` exposes the recording's optional `mapIdentity`. Obtain the source manifest from the pinned official preparation report, and hash its selected `game/csgo/maps/<map>.vpk` with SHA-256. Establish the source/recording relationship before approving it. Copying a header tuple alone does not verify that relationship.

Install a reviewed local catalog with the separate one-shot maintenance service. Its only application volume is the catalog, mounted read/write. It has no network, `.env`, provider credentials, recordings, maps, queue or cache mounts. Web and the acquisition service both retain read-only catalog access.

```sh
docker compose --profile maintenance run --rm -T catalog < /trusted/catalog.json
```

The updater accepts at most 256 KiB of UTF-8 JSON and 512 strict schema entries, opens every filesystem ancestor without following links, and requires an owned control directory. A real filesystem lock serializes updates. It refuses linked, hardlinked, special or concurrently changed catalog targets, fsyncs a private temporary file and atomically renames it before syncing the directory. Failed validation preserves the active catalog. This is operator approval maintenance, not automatic Steam mapping discovery or catalog generation.

The worker rechecks the selected source policy before conversion stages and publication. Removing a catalog entry revokes that approved source and its URLs, but is not a permanent ban on preparing the same official map through the separate latest policy. Published packs use immutable content-derived IDs, matching manifests, self-contained geometry, calibrated overview, decoded sky images and hashes. Web access remains scoped to the demo and instance policy. Current manual map-name packs are explicitly version-unverified and are used only when automatic preparation is disabled.

## Resources and recovery

The worker serializes acquisition with a real filesystem lock. Private source/tool storage is capped at 16 GiB and normally retains the current and one previous marked source version, with earlier reclamation near the cap. Prepared assets are capped at 32 GiB. A 512 MiB free-space reserve and 45-minute request deadline stop work rather than exhausting the host. Host filesystem quotas remain the hard storage boundary.

Desktop/mobile preparation budgets decoded textures at 512/256 MiB and uses lossless Meshopt transport compression. Compression reduces transfer bytes, not decoded geometry or GPU mip memory. Native map exports still need substantial RAM and scratch space. No server GPU is required.

Compatible opaque static desktop siblings are also batched in 64 m cells, preserving material/source metadata, named hierarchy, transforms and exact images. Mobile stays unbatched by default after both 16 m and 64 m experiments regressed this host's measured software-rendered pacing. Batching reduces draw submissions independently of compression and does not promise a frame rate. A changed preparer revision rebuilds worker packs. Runtime model cancellation aborts initial transfer promptly while allowing already-started bounded embedded-image parsing to settle into private retired-resource cleanup, avoiding false texture errors on camera/2D switches.

Inspect service state with `docker compose logs assets`. Transient source, storage, conversion and interruption failures can be explicitly retried by an owner after the five-minute cooldown while the worker is healthy and approval is still valid. Source mismatches or removed approvals require operator correction. Steam may deny historical manifest request codes even when an older manifest file was previously available. An unavailable historical selection can create a separate, clearly disclosed latest request from fresh inventory. It never relabels the failed old job or changes a pin within that job.

Only exact worker-owned source/staging markers are cleanup candidates. Prepared packs and unmarked operator folders are preserved. Back up the catalog and prepared assets. Disposable source/tool caches can be rebuilt, subject to upstream availability. Stop active viewers before replacing manual assets and reload tabs afterward.

Operator preparation also supports genuine native CT/T rifle locomotion cycles. These are analytical replay approximations, not the recorded animation graph, firing/reload animation or exact weapon grips. The existing verified geometry and selected clips came from manifests `6678473446694075055` and `807392217824910805` respectively. Mixed packs record both source versions explicitly.

For manual preparation commands and artwork/model limits, see [asset tools](../tools/assets/README.md). Build the separate image locally with `docker build --target assets -t cswatch:assets .`. CI verifies confinement and publication using only original synthetic geometry/pixels, including the shipped Sharp conversion child and fixed no-replace preview publisher, then publishes both images after the complete verification job. A passing local source check does not establish container verification or image publication.
