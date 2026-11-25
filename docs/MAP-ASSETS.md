# Map assets

Official map preparation is optional and defaults off. The web app prefers a unique operator-approved source for the recording. Without one, it can use a clearly disclosed latest official snapshot from worker-observed Steam metadata. Latest geometry is never presented as the recording's original revision. The separate assets worker prepares maps on the CPU and browsers render them locally.

The worker requires Linux x86-64, Landlock ABI 3 or later and seccomp. The application image stays the default Docker target. The assets image is `ghcr.io/buco7854/cswatch:assets-latest`, with revision tags `assets-sha-<commit>-<run>`. Neither image contains game artwork, recordings or prepared Steam assets. Deploy both images from the same verified revision.

## Run and update the worker

```sh
docker compose pull web worker assets
docker compose up -d web worker assets
```

Set `AUTO_OFFICIAL_MAPS_ENABLED=true` to lock the feature on, or leave it empty and manage it in Administration (initially off). The worker refreshes official map metadata at startup and about hourly. Steam/FACEIT credentials and `.env` are never passed to it.

| Volume                | Web                      | Asset worker       | Demo/transcription workers |
| --------------------- | ------------------------ | ------------------ | -------------------------- |
| `cswatch-map-assets`  | Read-only                | Read/write         | Not mounted                |
| `cswatch-map-jobs`    | Read/write               | Read/write         | Not mounted                |
| `cswatch-map-catalog` | Read-only                | Read-only          | Not mounted                |
| `cswatch-map-cache`   | Not mounted              | Private read/write | Not mounted                |
| `cswatch-data`        | Private application data | Not mounted        | Private application data   |

The service has its own egress network, no published ports, a read-only root, UID/GID 1000, no capabilities and `no-new-privileges` (defaults: 8 GiB RAM, two CPUs, 128 processes). Every conversion step runs as a separate child under `asset-network-deny`: Landlock limits writes to the job's scratch directory and seccomp denies networking, process creation, metadata changes and cross-process signals. Each child also has CPU, file-size, RSS, time, output and scratch-storage limits. New volume roots are owned by UID 1000; bind mounts need the same ownership.

## What a map job produces

For one map the worker:

1. downloads the selected map VPK and the referenced `pak01` entries from the fixed anonymous depot and checks the map's SHA-1, size and SHA-256;
2. runs the pinned .NET 11 exporter ([tools/cs2export](../tools/cs2export/README.md), ValveResourceFormat 21.1) to read the compiled world, the map's own 3D sky prefab, entities, materials, textures, lightmaps, cubemaps, probe volumes and post-processing;
3. packs geometry and the desktop BC texture tier, then encodes the phone ASTC tier with a checksum-pinned astc-encoder 5.7.1 build;
4. validates every payload hash, decoded extent and Brotli sibling, prepares the radar overview, and publishes an immutable generation by rename.

A published map is `maps/<map>/map.json` plus content-hashed payloads and `maps/overviews/<map>/`. The client picks the BC tier when the device has BPTC, RGTC and S3TC (sRGB) and 18 fragment texture units. Otherwise it picks ASTC when available with 15 units. With neither, it shows the 2D map and says that the device lacks the texture support needed for 3D. Files are served only through `GET /api/demos/:id/world/:generation/:hash/:file`, which checks access to the demo, the ready generation and the manifest hash, and returns the Brotli sibling when the browser accepts it.

## Readiness and troubleshooting

Administration lists worker-prepared maps with a reusable deletion confirmation. Deletion removes the map for all demos using it. Recordings are kept, and the worker retires the files. A deleted map is not downloaded again automatically; its demo owner can request it again. The same page shows the shared player, HUD, equipment and sound banks, with a bounded retry.

Viewer explanations distinguish automatic preparation disabled, worker unavailable, official list missing or stale, unknown official map, invalid recording identity and missing owner authorization. While a job runs the viewer shows the worker phase (`tools`, `source`, `geometry`, `desktop`, `mobile`, `publishing`). Follow a job with:

```sh
docker compose ps
docker compose logs --tail 100 assets
```

Inventory failures log a fixed `phase` (storage, toolchain, downloader, metadata, publication), `code`, `retryAt` and, when available, `exitCode`. Steam exit 4 is `steam_rate_limited` and pauses new Steam work for fifteen minutes. Paste these fields instead of private cache logs. Administration also shows the web image's source revision and build time from `/api/config`; updating the web image does not update the assets image.

## Presentation assets

After a successful inventory refresh the idle worker prepares the fixed native CT/T agents, HUD icons, one landing screenshot (`de_mirage` 720p, at most 1600×900), the gameplay sound bank, then one equipment model or first-person rig at a time. Each comes from a pinned depot manifest with verified hashes; a missing official resource stays unavailable rather than being substituted. Existing operator banks are preserved. See [asset tools](../tools/assets/README.md).

## Latest official snapshots

The worker lists direct map VPK entries from app `730`, depot `2347770`. A fresh inventory binds safe map names to one Steam manifest, SHA-1 and size (at most 128 KiB and 256 names), plus the official community addon of a map that has one (depot `2347773`, its own manifest, SHA-1 and size). New selections need a check within 24 hours. An owner or guest request carries no source arguments; the server derives the selection from the inventory and the recording's map name. Explicit addon or conflicting evidence and unknown names stay blocked. Queued jobs keep their manifest pin. The viewer shows the manifest and check time and never presents a latest snapshot as the historical revision.

## Optional approved historical sources

The initial catalog is empty: `{ "schemaVersion": 1, "entries": [] }`. An entry must match the recorded `map`, `buildNum`, `patchVersion`, `demoVersionGuid` and `addonPresence: "none"`, and name app 730, depot 2347770, one pinned manifest and the map VPK SHA-256. See the [shared contract](../shared/map-acquisition.d.ts) and [catalog schema](../backend/src/map-catalog.ts). Install a reviewed catalog with the networkless one-shot service:

```sh
docker compose --profile maintenance run --rm -T catalog < /trusted/catalog.json
```

The updater accepts at most 256 KiB and 512 entries, refuses linked or concurrently changed targets and replaces the catalog atomically. The worker rechecks the source policy before conversion and before publication. Removing an entry revokes that approved source; it does not block the separate latest policy.

## Resources and recovery

Acquisition is serialized by a filesystem lock. Source and tool storage is capped at 16 GiB, prepared assets at 32 GiB, with a 512 MiB free-space reserve and a 45-minute request deadline. A conversion's scratch is capped at 3 GiB and needs 4 GiB free. An exported map needs a few GiB of RAM; no server GPU is required. Owners can retry transient failures after a five-minute cooldown. Source mismatches and removed approvals need operator correction.

Only exact worker-owned source and staging markers are cleaned up. Prepared packs and unmarked operator folders are preserved. A changed preparer revision prepares maps again under a new identity. For a manual installation, place the worker's output tree (`<map>/` and `overviews/<map>/`) in `/map-assets`; it is labeled version-unverified and used only while automatic preparation is disabled.

Build the assets image locally with `docker build --target assets -t cswatch:assets .`. CI verifies confinement and publication with original synthetic content before publishing both images.
