# Map assets

Official map preparation is optional and defaults off. The web app matches a demo's recorded map identity against an operator-approved catalog, then queues one shared immutable pack. It never guesses that today's map matches an older recording. The separate asset worker downloads selected official Steam resources and prepares them on the CPU. Browsers render the result locally.

The worker requires Linux x86-64, Landlock ABI 3 or later and seccomp. The published application image stays the default Docker target. The optional image is `ghcr.io/buco7854/cswatch:assets-latest`, with revision tags named `assets-sha-<commit>-<run>`. Neither image includes game artwork, recordings or prepared Steam assets.

The assets tag is available only after this revision's verification/publication workflow succeeds. Before that, build the assets target locally and set `CSWATCH_ASSETS_IMAGE` to the resulting local image.

## Enable the optional worker

Start the ordinary deployment, then enable the profile:

```sh
docker compose up -d
docker compose --profile assets up -d
```

Set `AUTO_OFFICIAL_MAPS_ENABLED=true` in `.env` to lock the feature on, or leave it empty and enable it in the admin UI. An empty value permits UI management and initially defaults off. Enabling the worker without catalog approvals does not authorize any downloads. Steam/FACEIT credentials and `.env` are never passed to this service.

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

## Approve exact sources

The initial catalog is deliberately empty:

```json
{ "schemaVersion": 1, "entries": [] }
```

Each entry must match the complete recorded `map`, `buildNum`, `patchVersion`, `demoVersionGuid` and `addonPresence: "none"`. Its source must identify app 730, depot 2347770, one pinned uint64 Steam manifest and the expected SHA-256 of the selected map VPK. An optional `assetVersion` labels preparation provenance. See the [shared contract](../shared/map-acquisition.d.ts) and [validated catalog schema](../backend/src/map-catalog.ts).

Recorded build fields are unsigned evidence from the demo, not Steam manifest IDs or cryptographic layout proof. Approvals are explicit operator provenance. Addon maps, incomplete identity, ambiguous approvals, unavailable historical versions and unknown sources remain unavailable for automatic preparation. No arbitrary URL, caller-supplied source path, whole-game selector or authenticated Steam account is accepted.

The authorized replay manifest at `GET /api/demos/:id/playback` exposes the recording's optional `mapIdentity`. Obtain the source manifest from the pinned official preparation report, and hash its selected `game/csgo/maps/<map>.vpk` with SHA-256. Establish the source/recording relationship before approving it. Copying a header tuple alone does not verify that relationship.

Install a reviewed local catalog with the separate one-shot maintenance service. Its only application volume is the catalog, mounted read/write. It has no network, `.env`, provider credentials, recordings, maps, queue or cache mounts. Web and the acquisition service both retain read-only catalog access.

```sh
docker compose --profile maintenance run --rm -T catalog < /trusted/catalog.json
```

The updater accepts at most 256 KiB of UTF-8 JSON and 512 strict schema entries, opens every filesystem ancestor without following links, and requires an owned control directory. A real filesystem lock serializes updates. It refuses linked, hardlinked, special or concurrently changed catalog targets, fsyncs a private temporary file and atomically renames it before syncing the directory. Failed validation preserves the active catalog. This is operator approval maintenance, not automatic Steam mapping discovery or catalog generation.

The worker rechecks approval before conversion stages and publication. Published packs use immutable content-derived IDs, matching manifests, self-contained geometry, calibrated overview, decoded sky images and hashes. Web access remains scoped to the demo and instance policy. Current manual map-name packs are explicitly version-unverified and are used only when automatic preparation is disabled.

## Resources and recovery

The worker serializes acquisition with a real filesystem lock. Private source/tool storage is capped at 16 GiB and normally retains the current and one previous marked source version, with earlier reclamation near the cap. Prepared assets are capped at 32 GiB. A 512 MiB free-space reserve and 45-minute request deadline stop work rather than exhausting the host. Host filesystem quotas remain the hard storage boundary.

Desktop/mobile preparation budgets decoded textures at 512/256 MiB and uses lossless Meshopt transport compression. Compression reduces transfer bytes, not decoded geometry or GPU mip memory. Native map exports still need substantial RAM and scratch space. No server GPU is required.

Inspect service state with `docker compose --profile assets logs assets`. Transient source, storage, conversion and interruption failures can be explicitly retried by an owner after the five-minute cooldown while the worker is healthy and approval is still valid. Source mismatches or removed approvals require operator correction. Steam may deny historical manifest request codes even when an older manifest file was previously available. A failed old source never falls back to the latest map.

Only exact worker-owned source/staging markers are cleanup candidates. Prepared packs and unmarked operator folders are preserved. Back up the catalog and prepared assets. Disposable source/tool caches can be rebuilt, subject to upstream availability. Stop active viewers before replacing manual assets and reload tabs afterward.

Operator preparation also supports genuine native CT/T rifle locomotion cycles. These are analytical replay approximations, not the recorded animation graph, firing/reload animation or exact weapon grips. The existing verified geometry and selected clips came from manifests `6678473446694075055` and `807392217824910805` respectively. Mixed packs record both source versions explicitly.

For manual preparation commands and artwork/model limits, see [asset tools](../tools/assets/README.md). Build the optional image locally with `docker build --target assets -t cswatch:assets .`. CI verifies confinement and publication using only original synthetic geometry/pixels, then publishes both images after the complete verification job. A passing local source check does not establish container verification or image publication.
