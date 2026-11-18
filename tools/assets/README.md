# S2V map preparation

This is an **operator-only, CPU pipeline**, separate from the public app. It uses local CS2 content, either selectively downloaded below or provided by an existing installation, and [Source2Viewer-CLI](https://s2v.app/ValveResourceFormat/guides/command-line.html). The runtime does not require .NET or a GPU on the server.

## Install selected official maps from Steam

The operator installer can obtain the selected official map VPKs and their required resources without downloading the whole game. It uses anonymous access to fixed CS2 app `730` and content depot `2347770`. An explicit map list is required. There is no full-game fallback, account login, arbitrary URL option or public HTTP endpoint.

```sh
npm ci --prefix tools/assets
npm --prefix tools/assets run install-steam -- \
  --maps de_mirage,de_dust2 \
  --output /srv/cswatch/maps \
  --cache /srv/cswatch-assets-cache
```

Use Node 24 on Linux x64. When executables are not supplied, `prepare-toolchain.mjs` prepares checksum-pinned S2V, SteamFileDownloader and the .NET toolchain in a versioned private cache. It uses the pinned upstream sources and package checksums, and records executable hashes and build provenance. The application image and runtime remain TypeScript and do not acquire .NET or game assets. To use your own trusted installed tools, supply both `--s2v /path/Source2Viewer-CLI` and `--downloader /path/SteamFileDownloader`. Their hashes are recorded instead of claiming they match the bootstrap pins.

The installer first lists exact selected files, checks their sizes and pins one Steam manifest ID. Supply `--manifest PINNED_UINT64` to reuse a known depot version across separate map/equipment runs. The initial listing must match that exact string before any resource download. Without the option, the current official manifest is selected once and pinned for the rest of that run. It then downloads only the selected map VPKs, game search-path files, package directories and the Steam chunks holding needed resources. The package scanner verifies CRCs before traversing resource dependencies. Sparse holes never count as available data. Up to eight dependency waves can reveal materials and then their textures. Before scene export, the actual reference closure's CRC-verified material files are copied in bounded private batches for DATA inspection. Their authored shader names determine the required Vulkan families, highest indexed feature model and exact declared program stages. Only CRC-missing matching programs are selectively fetched. Source proofs, selected families and repairs remain in private installation provenance. Native export failures remain fatal after a complete preflight. Asynchronous progress text is never used to infer which material caused an exception. Unknown materials, models or textures fail installation. Missing baked-cache resources and game scripts remain reported limitations.

Sky preparation inspects the map's actual entity lumps for its enabled `skybox_reference` and `env_sky`. It authorizes one exact prefab VPK inside that selected map's own directory, then lists and downloads it from the same pinned depot manifest. It never guesses the current prefab name when a map references a legacy variant. The same CRC/dependency and shader checks cover that prefab. Its recorded `sky_camera` supplies the landscape origin/scale, and its enabled sky environment takes precedence over the main map's environment when present. The separate sky world is merged offline into the ordinary desktop/mobile GLBs; there is no second runtime map URL. Recorded sky material, exposure, brightness, tint and orientation produce six bounded PNGs prepared in the viewer's Y-up cube-face order. These SDR faces and glTF geometry remain approximations of Source 2 rendering, including clipped HDR range and different lighting/material behavior.

For three explicitly supported native atmospheric materials (ordinary dust, skybox dust and clouds), the installer also resolves their omitted opacity masks. A bounded phase-zero bake multiplies the actual linear mask channels, preserves source/vertex alpha and wraps at the authored UV repeat periods. The prepared material uses unlit alpha blending; the normal desktop/mobile packer resizes/compresses the embedded result. This static approximation avoids opaque dust/cloud cards without deleting geometry. Mask animation, Fresnel, depth feather, native effects fog and HDR values remain limitations. Other effects and unsupported variants are not silently converted. Provenance records the exact resources, hashes, periods, sampling and omissions.

Prepared model tiers have decoded image budgets, not just maximum texture edges: desktop 512 MiB and mobile 256 MiB of resident RGBA8, with 2048/1024 pixel edge ceilings. The deterministic allocator retains base-color/emissive detail at weight 2 and auxiliary maps at weight 1, accounts for shared images/sampler variants, and halves larger contributors until the budget fits. Images encode sequentially; actual output dimensions are checked. GPU mipmaps add roughly one-third and browsers also retain geometry, source data and other resources, so these caps are not total-memory or frame-rate guarantees. Compact manifest summaries bind a bounded `texture-plan.json` by SHA256. Publication rejects missing, altered or over-budget plans.

Fresh S2V map exports compact satellite PNGs as the pinned exporter explicitly reports each completed write. Only exact local filenames in this run's initially empty export directory are eligible. Complete PNG chunks/CRCs and decoded pixels, source identity and fresh content hashes are checked before atomic replacement. Images above the desktop 2048 pixel ceiling are resized as lossless PNGs, preserving alpha. Smaller images retain their original bytes. Per-image allocation, cumulative I/O and provenance bounds remain independent of the 512 MiB disk reserve. Full input/output hashes remain in private preparation reports. Output cancellation drains cooperative image work before scratch cleanup.

The landscape merge also applies the desktop decoded texture budget before building its intermediate GLB. Later tier preparation reuses unchanged WebP bytes. This avoids retaining several gigabytes of raw exported images through a second full binary write. The operator subprocess environment limits the .NET managed heap to 4 GiB and requests memory conservation; native texture allocations still require additional RAM. These preparation settings do not change the application or parser-worker limits. Steam metadata preflight has a two-minute deadline and selected download stages ten minutes. Native export stages retain their separate timeout. A failed connection or rate limit remains a visible failure, with no full-game or unverified-cache fallback.

Geometry uses local lossless Meshopt transport compression. Every compressed buffer view is decoded and compared with its original bytes; position, normal, UV, vertex-alpha and index order are preserved. No quantization is applied. The runtime loads a bundled decoder, never a CDN. Encoded and decoded bounds remain 2 GiB per model/geometry allocation. Compression reduces downloads and source-buffer retention; it does not remove decoded vertex memory or draw calls.

Previously prepared tiers can be updated without another Steam download or S2V export:

```sh
node tools/assets/retier-map.mjs \
  --input /OLD/de_dust2/desktop/scene.glb \
  --output /NEW/de_dust2/desktop --map de_dust2 --tier desktop
```

Repeat with `--tier mobile` and matching mobile paths. Retiering preserves geometry and the source asset version, applies current image budgets and compresses geometry. An already WebP image with unchanged target dimensions keeps its encoded bytes. For a budgeted pack that needs only lossless geometry compression, use `compress-prepared-map.mjs` with the same flags; its image and texture-plan bytes remain unchanged. Both commands require fresh output directories. Validate the complete map/overview/environment version, stop viewers, install the new pack and reload their tabs. Never replace an active pack in place.

Before each real scene export, shader preflight derives families from CRC-checked material resources rather than asynchronous exporter progress messages. Bounded private DATA batches inspect only those materials, select the actual native shader model and check its declared indexed programs. Only missing exact programs are fetched and CRC-verified. Complete shaders do not authorize a speculative retry of a failing export. This remains an operator-only operation, separate from demo parsing.

Maps are exported and prepared serially. Both model tiers, the overview and the complete environment pack must validate against one asset version before publication. Existing map/overview/environment directories are never replaced, and failure rolls back only newly claimed directories across all three destinations. After the landscape merge succeeds, its embedded buffers/images and byte ranges are checked and the original glTF source hashes are recorded privately. Only this run's superseded main/sky export directories are reclaimed before tier packing; external inputs, raw Steam content, prepared sky faces and logs are retained. Source paths containing links or escaping the per-map stage cannot authorize cleanup. The remaining private scratch is removed after each map. Progress, pinned manifests, transfer/storage diagnostics and tool/resource provenance are retained in the cache. Ctrl+C cancels the active process group. Re-run with only the maps still needed, or use a new output directory for an update.

Budgets are explicit: at most 16 maps, 50,000 exact resource selections, 8 GiB selected bytes and 16 GiB allocated cache storage, with a 512 MiB free-disk reserve checked before stages and every 250 ms while a subprocess runs. Each prepared GLB is capped at 2 GiB to match runtime discovery, and a model/overview pair is capped at 4 GiB in total. Immediately before writing a tier, the packer checks the actual encoded GLB size plus the reserve against its filesystem's free space. It does not estimate compressed output from source texture sizes. Outputs are created exclusively. Only one periodic filesystem check runs at a time. A reserve failure stops that stage's process group and preserves partial sparse downloads for retry. Steam chunks can contain adjacent resources, so actual transfer/storage differs from the sum of selected entry bytes. Sparse VPK logical lengths also exceed physical disk usage. Host disk quotas and monitoring remain the hard storage boundary. Preparation additionally needs temporary space for source textures and both GLB tiers. If the available storage is insufficient, the installer stops instead of broadening the download.

Install `/srv/cswatch/maps` as the web service's `/data/maps` mount or copy the completed directories into the existing data volume. Files and newly created asset directories are made readable, while existing operator-directory permissions are preserved. Keep the cache private and outside the web asset mount. Do not add game content or the toolchain cache to Git or Docker images. Asset availability does not grant redistribution rights. Check your intended hosting rights, verify map coordinates with known positions, and inspect rendering/performance before making an installed pack public. glTF export still has the lighting/material limitations below.

`npm --prefix tools/assets run test:installer` exercises synthetic VPK/RERL files, strict selections, pinned prefab acquisition, environment precedence, shader planning, verified map/overview/environment publication, rollback and process cancellation. It does not contact Steam or substitute for a real map export, sky-orientation and alignment check.

Prepared environments live at `environments/<map>/environment.json` alongside `px.png`, `nx.png`, `py.png`, `ny.png`, `pz.png`, `nz.png` and private `provenance.json`. The six equal square PNGs are at most 1024 pixels and 8 MiB each, with a 32 MiB total bound. Runtime discovery checks their hashes, brightness from 0 to 16, and matching map/asset versions in both prepared tier manifests before exposing fixed, instance-policy-protected URLs. Generic static access cannot bypass these checks. Landscape capability reports geometry already merged into the map. The public application never accepts arbitrary sky URLs or performs this conversion on uploaded demos.

The installer also prepares opacity for explicitly supported atmospheric materials whose native mask channels are absent from S2V's glTF color texture. It validates the full native material/shader identity, selectively acquires only exact local mask/color resources, verifies VPK availability/CRCs and decodes them with their original alpha and linear mask channels. A bounded static phase-zero bake is embedded before tier packing. Its patch preserves the original geometry/binary bytes, changes only the supported material texture binding and records private provenance. It does not infer opacity from tint alpha or apply to unrelated materials. Native panning, Fresnel and depth feather remain explicit approximations; recorded gameplay smoke effects are separate. No extra mask URL or public conversion endpoint is introduced.

## Prepare an existing local map export

```sh
cd tools/assets
npm ci
npm run prepare-map -- --s2v /opt/s2v/Source2Viewer-CLI \
  --game '/games/Counter-Strike Global Offensive/game/csgo' \
  --map de_mirage --output /tmp/cswatch-assets --asset-version CS2_BUILD
```

You can also use `--input /path/to/S2V-export.gltf` instead of `--s2v` and `--game`. Keep external textures and buffers next to that source export. The tool embeds them in self-contained GLBs. It generates separate desktop/mobile files, compressed WebP textures, simplified mobile geometry, and provenance manifests. It refuses to overwrite an existing tier. Prepare offline, validate, then copy the complete map directory into the app's `DATA_DIR/maps/`. Never replace files while clients are watching.

S2V already converts Source inches/Z-up into glTF meters/Y-up. The viewer rotates exported assets +90° about Y to match its `(Source X, Source Z, -Source Y)` frame; it **does not scale them again**. Pin your S2V release and check coordinate alignment using known spawn points after upgrades. The documented CLI arguments can change between S2V versions.

See [S2V map export documentation](https://s2v.app/ValveResourceFormat/guides/exporting-maps.html): exported maps omit baked lighting, point/spot lights, and skyboxes, and reduce some blended materials. The selective installer above separately prepares authored sky cubemaps and referenced distant geometry. It does not reconstruct baked lighting or all Source material blending. Maps can remain large even after optimization; validate transfer size and GPU memory on target phones. The generated tiers are a starting point, not a mobile performance certification.

Agent/weapon exports use S2V's [model export guide](https://s2v.app/ValveResourceFormat/guides/exporting-models.html). Static spectator weapons, recorded world equipment and optional agent rigs are supported with prepared packs. Native hand poses, recoil, animation graphs and Source 2 effects remain incomplete.

No Valve assets are bundled. Operators provide assets and determine whether their intended hosting/distribution is permitted. S2V's own open-source license does not grant rights to game content. Don't put proprietary exports into this repository or its public container image.

## Local 2D map and radar overviews

The 3D GLB and 2D overview are separate assets. For the 2D view and radar, export the actual map's radar artwork to PNG from your own local content with S2V. Use matching Valve overview text from the same map version, or supply a calibration you have checked against known Source coordinates. This standalone preparation command does not acquire artwork, infer missing map geometry, or guess calibration. The selective installer above can acquire the explicit matching artwork and overview metadata.

```sh
npm --prefix tools/assets run prepare-overview -- \
  --map de_mirage --image /tmp/operator-export/de_mirage_radar.png \
  --overview /tmp/operator-export/de_mirage.txt \
  --output /tmp/cswatch-map-assets --version CS2_BUILD \
  --source 'Local CS2 artwork exported with S2V VERSION'
```

The overview text must contain one matching map block and scalar `pos_x`, `pos_y` and `scale` fields. Optional `material`, `zoom`, `CTSpawn_x/y`, `TSpawn_x/y`, `bombA_x/y`, `bombB_x/y` and `inset_left/top/right/bottom` are loading metadata. `rotate` may be absent, zero or one. This legacy flag rotates the complete in-game overview panel, rather than changing the raster's world calibration. cswatch keeps the north-up raster and records the source display flag in provenance. This follows Valve's separate `WorldToMap` and `GetViewAngle`/`MapToPanel` operations in [Source SDK's MapOverview.cpp](https://github.com/ValveSoftware/source-sdk-2013/blob/master/src/game/client/game_controls/MapOverview.cpp), and the same north-up formula is used by [Awpy's current `world_to_pixel`](https://github.com/pnxenopoulos/awpy/blob/main/crates/awpy-python/python/awpy/plot.py). Other rotate values, nested/layered maps, duplicate fields and includes are rejected. Multi-level radar support is not implemented. Use explicitly calibrated north-up artwork when the source layout does not fit this supported subset.

For a calibration you have independently verified, replace `--overview` with `--origin-x=SOURCE_X --origin-y=SOURCE_Y --scale=SOURCE_SCALE`. Do not combine both modes. The image maps Source coordinates to normalized image coordinates as `u = (x - origin.x) / (scale * 1024)` and `v = (origin.y - y) / (scale * 1024)`. The reference size is always 1024, even for a 2048 px image. Origins must be finite within ±10,000,000 Source units and scale must be from 0.001 to 10,000.

Only regular local PNG files up to 8 MiB and 2048×2048 square pixels are accepted. The tool fully decodes and normalizes the artwork into a self-contained PNG, rejects linked input paths and refuses to replace an existing output. It writes `overviews/<map>/overview.png`, `overview.json` and `provenance.json` below `--output`. Hashes bind the calibration metadata to the prepared image. Source paths and provenance are not served through the app.

Inspect the result, check the intended distribution rights and install the complete `overviews` directory under `DATA_DIR/maps/overviews`, or `/data/maps/overviews` in Docker. Keep files readable by the web service's UID 1000. For example, the Mirage pack lives at `/data/maps/overviews/de_mirage/overview.json`. The existing named data volume can store it. An operator-controlled read-only bind mount at `/data/maps` on the web service also works without embedding game artwork in the image. Install a new version while viewers are stopped, then reload their tabs.

`/api/maps/<map>` exposes only a fixed local image endpoint and validated calibration when both files are present and valid. The image endpoint checks the same instance access policy, regular file bounds, PNG structure/CRC and metadata hash. Generic `/map-assets/overviews/` access is blocked. Missing or invalid artwork remains explicitly unavailable. Installing an overview does not install a 3D world, and installing a GLB does not provide a radar image.

`npm --prefix tools/assets run test:overview` uses original synthetic PNGs and calibration text to check output, identical north-up calibration/raster orientation for display flags zero and one, unsupported metadata, path safety, bounds and overwrite protection. It does not validate real CS2 exports or alignment. Validate those separately using the actual map version before claiming an installed map works.

## Exact equipment silhouettes

The broadcast HUD can use the real, weapon-specific CS2 equipment artwork supplied by an operator. With no pack installed, recorded weapon labels and original schematic vectors remain available. cswatch does not bundle Valve's silhouettes. Community archives such as [counter-strike-icons](https://github.com/Juknum/counter-strike-icons) explicitly identify the artwork as Valve's; a repository or extractor license does not license that artwork.

Export the equipment folder from your local CS2 installation using the [S2V CLI](https://s2v.app/ValveResourceFormat/guides/command-line.html). S2V supports [byte-exact SVG export for Panorama vector graphics](https://s2v.app/ValveResourceFormat/guides/format-support.html):

```sh
Source2Viewer-CLI -i '/games/Counter-Strike Global Offensive/game/csgo/pak01_dir.vpk' \
  --vpk_filepath 'panorama/images/icons/equipment/' \
  --vpk_extensions vsvg_c --vpk_decompile --output /tmp/cswatch-equipment-export

node tools/assets/prepare-equipment.mjs \
  --input /tmp/cswatch-equipment-export/panorama/images/icons/equipment \
  --output /tmp/cswatch-equipment-pack \
  --version CS2_BUILD \
  --source 'Valve Corporation; local CS2 installation exported with S2V VERSION'
```

Point `--input` at the directory containing the exported `.svg` files if your S2V version uses a different output layout. The tool accepts only the 83 entries in [the equipment registry](../../shared/equipment-icons.json): 73 equipment silhouettes plus 10 native review/HUD symbols. Flat equipment directories remain supported; to include the demo kill/death symbols, distinct bomb objective artwork, team emblems and headshot detail, use a full `panorama/images/` export with the fixed paths in [native review artwork](REVIEW-EVENTS.md). The tool ignores unrelated files, rejects executable SVG elements/external references/symlinked files and ancestors, rasterizes drawing primitives to alpha PNGs of at most 256×64, and records source/output SHA-256 hashes in `provenance.json`. No SVG is served to browsers. The output directory must be new, and an error removes its temporary output.

After checking your rights and inspecting the prepared pack, install the complete directory as `DATA_DIR/maps/equipment/` and restart the server. Keep the provenance file beside the PNGs. The authenticated/private-instance access policy applies to `/api/assets/equipment`; it publishes only validated known PNGs. The browser loads this local manifest once per tab and applies each silhouette in the current theme color. Reload the tab after installing a new pack. No game CDN, external image URL or online icon service is used at runtime.

`npm --prefix tools/assets run test:equipment` checks preparation with original synthetic geometry, including SVG references, output limits, provenance, overwrite protection and symlink rejection. It does not fetch or commit game artwork.

## Static weapon, grenade and C4 models

Prepare native equipment separately from maps and HUD icons. Use the same explicit Steam manifest as the map packs, with the fixed model registry:

```sh
npm --prefix tools/assets run install-equipment-models -- \
  --items all --agents ct,t --manifest 6678473446694075055 \
  --output /srv/cswatch/maps --cache /srv/cswatch-asset-cache
```

`--items` also accepts an explicit comma-separated subset such as `ak47,knife,smokegrenade,c4,plantedc4`. `--agents ct,t` is optional and can be run without equipment selection. The installer acquires exact selected model resources and their bounded static dependencies, checks CRCs and shader programs, and uses native default mesh/LOD masks. It excludes animation graphs and avoids exporting both legacy/HD geometry or first-person arms as duplicate body meshes. Every completed item is published atomically and never overwrites an installed item. A failed later item preserves completed immutable outputs. Restart with only missing IDs or use a new output root for updates.

Models are capped at 16 MiB encoded, 16 MiB decoded texture RGBA and 8 MiB decoded vertex/index data each. Inputs are checked before allocation, textures compress serially, and lossless Meshopt transport is decoded and compared before publication. Runtime model descriptors use fixed same-origin URLs and hash-bound self-contained GLBs. The browser loads visible items lazily under a shared device memory budget. Missing/failed models are reported in Options → Performance; they never remove the map. Recorded grenade bodies retain a small visible fallback when a model is unavailable.

Equipment geometry receives one offline +90° Y rotation into viewer meters/Y-up/+X-forward coordinates, with no second Source scale. Static hold/POV presets use measured bounds and keep the model ahead of the camera near plane. They are spectator approximations, without native arms, recoil or first-person animation. Dropped items, grenade rotations and planted C4 use recorded entity transforms when present. C4 and planted C4 share the actual native C4 model, with separate fixed IDs. Native digits and planting animation are not reconstructed.

For agents, the optional installer selects the native third-person body/gloves and one genuine full-pose non-additive rifle-idle clip plus its skeleton. It retargets that single frame into the skin by exact native bone identities. It does not expand the complete animation graph or present a bind T-pose as gameplay. The resulting static rifle-idle pose remains an explicit approximation. Its source S2V axes are preserved for the existing runtime +90° Y correction, unlike equipment's offline correction. Inspect actual prepared characters and weapon placements before public use.

## Other optional agent exports

The renderer discovers `DATA_DIR/maps/agents/ct.glb` and `t.glb`. Export chosen agents with S2V using `--gltf_mesh_list` to exclude first-person arms and optional meshes. Export only the idle/walk/run/crouch clips needed; full CS2 animation libraries are very large. Pack an export with:

```sh
node prepare-model.mjs --input /tmp/s2v-ct/agent.gltf --output /data/maps/agents/ct.glb
```

Each on-screen agent gets a cloned skeleton. For operator exports that include clips, the renderer selects idle/move/crouch names and samples animation time from the demo clock, so scrubbing is deterministic. This is a generic animation approximation, not CS2's AnimGraph. The simple player body remains the fallback when no model is installed. Player-specific skins, bone-exact poses and first-person weapon animations are not implemented. Validate animation names, runtime size limits and actual rendering before installation.
