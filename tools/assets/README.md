# S2V map preparation

This is a **trusted operator CPU pipeline**, separate from replay parsing and the HTTP process. The isolated asset worker invokes the same map installer for preferred approved historical sources or disclosed latest official snapshots; see [automatic-map deployment](../../docs/MAP-ASSETS.md). It uses local CS2 content, either selectively downloaded below or provided by an existing installation, and [Source2Viewer-CLI](https://s2v.app/ValveResourceFormat/guides/command-line.html). The web/replay runtime requires neither .NET nor a server GPU. The asset service uses verified native/.NET tools in its private cache for conversion.

## Install selected official maps from Steam

The operator installer can obtain the selected official map VPKs and their required resources without downloading the whole game. It uses anonymous access to fixed CS2 app `730` and content depot `2347770`. An explicit map list is required. There is no full-game fallback, account login or arbitrary URL option. The public map-request endpoint accepts no source selectors and cannot invoke conversion inside the HTTP or replay worker process.

```sh
npm ci --prefix tools/assets
npm --prefix tools/assets run install-steam -- \
  --maps de_mirage,de_dust2 \
  --output /srv/cswatch/maps \
  --cache /srv/cswatch-assets-cache
```

Use Node 24 on Linux x64. When executables are not supplied, `prepare-toolchain.mjs` prepares checksum-pinned S2V, SteamFileDownloader and the .NET toolchain in a versioned private cache. It uses the pinned upstream sources and package checksums, and records executable hashes and build provenance. The application image and runtime remain TypeScript and do not acquire .NET or game assets. To use your own trusted installed tools, supply both `--s2v /path/Source2Viewer-CLI` and `--downloader /path/SteamFileDownloader`. Their hashes are recorded instead of claiming they match the bootstrap pins.

The standalone installer selects the current official manifest once unless `--manifest PINNED_UINT64` is supplied. It pins that version for the entire run. An explicit pin is useful for reproducible selection across map and equipment runs. The automatic service always supplies a source selected from its worker-generated official inventory or an approved historical entry. Neither mode infers the recording's original geometry. Historical access can disappear, as observed for our older `6678473446694075055` and `807392217824910805` pins. A denied pinned run stops rather than quietly changing that job to another version. It then downloads only the selected map VPKs, game search-path files, package directories and the Steam chunks holding needed resources. The package scanner verifies CRCs before traversing resource dependencies. Sparse holes never count as available data. Up to eight dependency waves can reveal materials and then their textures. Before scene export, the actual reference closure's CRC-verified material files are copied in bounded private batches for DATA inspection. Their authored shader names determine the required Vulkan families, highest indexed feature model and exact declared program stages. Only CRC-missing matching programs are selectively fetched. Source proofs, selected families and repairs remain in private installation provenance. Native export failures remain fatal after a complete preflight. Asynchronous progress text is never used to infer which material caused an exception. Unknown materials, models or textures fail installation. Missing baked-cache resources and game scripts remain reported limitations.

Sky preparation inspects the map's actual entity lumps for its enabled `skybox_reference` and `env_sky`. It authorizes one exact prefab VPK inside that selected map's own directory, then lists and downloads it from the same pinned depot manifest. The selected resource is the prefab named by the authored reference. The same CRC/dependency and shader checks cover that prefab. Its recorded `sky_camera` supplies the landscape origin/scale, and its enabled sky environment takes precedence over the main map's environment when present. The separate sky world is merged offline into the ordinary desktop/mobile GLBs; there is no second runtime map URL. Recorded sky material, exposure, brightness, tint and orientation produce six bounded PNGs prepared in the viewer's Y-up cube-face order. These SDR faces and glTF geometry remain approximations of Source 2 rendering, including clipped HDR range and different lighting/material behavior.

For three explicitly supported native atmospheric materials (ordinary dust, skybox dust and clouds), the installer also resolves their omitted opacity masks. A bounded phase-zero bake multiplies the actual linear mask channels, preserves source/vertex alpha and wraps at the authored UV repeat periods. The prepared material uses unlit alpha blending; the normal desktop/mobile packer resizes/compresses the embedded result. This static approximation avoids opaque dust/cloud cards without deleting geometry. Mask animation, Fresnel, depth feather, native effects fog and HDR values remain limitations. Other effects and unsupported variants are not silently converted. Provenance records the exact resources, hashes, periods, sampling and omissions.

Prepared model tiers have decoded image budgets, not just maximum texture edges: desktop 512 MiB and mobile 256 MiB of resident RGBA8, with 2048/1024 pixel edge ceilings. The deterministic allocator retains base-color/emissive detail at weight 2 and auxiliary maps at weight 1, accounts for shared images/sampler variants, and halves larger contributors until the budget fits. Images encode sequentially; actual output dimensions are checked. GPU mipmaps add roughly one-third and browsers also retain geometry, source data and other resources, so these caps are not total-memory or frame-rate guarantees. Compact manifest summaries bind a bounded `texture-plan.json` by SHA256. Publication rejects missing, altered or over-budget plans.

Map preparation attempts an optional Compact 3D tier. The converter derives it from the exact SHA-256-bound mobile model, with source colors, texture-free static batches, quantized geometry and lossless Meshopt transport. It emits a separate `compact/scene.glb` and manifest when the result is smaller and fits 12 MiB, 450,000 triangles and 512 primitives. The confined worker publishes qualifying compact output with the verified map. Worker-owned packs publish under immutable content identifiers. For an operator-managed map, derive into a separate copy before installation with `node tools/assets/prepare-compact-map.mjs --input OLD/de_mirage/mobile/scene.glb --output NEW/de_mirage/compact --map de_mirage`. Keep the original mobile tier, overview, environment and provenance in the replacement directory. Auto selects Compact 3D on phones when present.

Fresh S2V map exports compact satellite PNGs as the pinned exporter explicitly reports each completed write. Only exact local filenames in this run's initially empty export directory are eligible. Complete PNG chunks/CRCs and decoded pixels, source identity and fresh content hashes are checked before atomic replacement. Images above the desktop 2048 pixel ceiling are resized as lossless PNGs, preserving alpha. Smaller images retain their original bytes. Per-image allocation, cumulative I/O and provenance bounds remain independent of the 512 MiB disk reserve. Full input/output hashes remain in private preparation reports. Output cancellation drains cooperative image work before scratch cleanup.

The landscape merge applies the desktop decoded texture budget before building its intermediate GLB. Later tiers reuse unchanged WebP bytes. Combined raw exports above 1 GiB use lossless Meshopt for the merged scene unless a supported atmosphere patch requires one physical buffer. The desktop, mobile and Compact operations each run in a separate confined process so their decoded geometry and codec memory can be reclaimed between tiers. The operator subprocess environment limits the .NET managed heap to 4 GiB, uses two logical processors and requests memory conservation. Native texture allocations still require additional RAM. Steam metadata preflight has a two-minute deadline and selected download stages ten minutes. Native export stages retain their separate timeout. Failed connections and rate limits return a visible failure.

Geometry uses local lossless Meshopt transport compression. Every compressed buffer view is decoded and compared with its original bytes; position, normal, UV, vertex-alpha and index order are preserved. No quantization is applied. The runtime loads a bundled decoder, never a CDN. Encoded and decoded bounds remain 2 GiB per model/geometry allocation. Compression reduces downloads and source-buffer retention; it does not remove decoded vertex memory or draw calls.

Map preparation automatically batches compatible opaque static siblings only in the desktop tier, using 64 m spatial cells. Mobile remains unbatched by default after browser-rendering regressions in the experimental batched variant. This separately reduces draw submissions while keeping material identities/extras, named hierarchy, source transforms and image bytes. Animated/skinned/morphed geometry, blended materials and incompatible vertex layouts or rotation/scale bases remain separate. It does not remove texture memory or promise FPS. Explicit `--batch-static` remains available for operator experiments. For example, `node tools/assets/compress-prepared-map.mjs --batch-static --input OLD/de_mirage/mobile/scene.glb --output NEW/de_mirage/mobile --map de_mirage --tier mobile` opts into experimental 16 m mobile cells. Validate actual rendering before installing such a variant. It is not the supported mobile default. The existing tier stays untouched; its original asset version, image bytes and validated texture plan remain bound in the derived manifest. Stop viewers before installing a complete verified variant, preserve provenance/backups and reload tabs.

Previously prepared tiers can be updated without another Steam download or S2V export:

```sh
node tools/assets/retier-map.mjs \
  --input /OLD/de_dust2/desktop/scene.glb \
  --output /NEW/de_dust2/desktop --map de_dust2 --tier desktop
```

Repeat with `--tier mobile` and matching mobile paths. Retiering preserves geometry and the source asset version, applies current image budgets and compresses geometry. An already WebP image with unchanged target dimensions keeps its encoded bytes. Both commands require the source GLB hash and length from its tier manifest. Use `compress-prepared-map.mjs` for lossless geometry compression. It validates the bound texture plan and preserves the plan and encoded image bytes. Both commands require fresh output directories. Validate the complete map/overview/environment version, stop viewers, install the new pack and reload their tabs. Never replace an active pack in place.

Before each real scene export, shader preflight derives families from CRC-checked material resources rather than asynchronous exporter progress messages. Bounded private DATA batches inspect only those materials, select the actual native shader model and check its declared indexed programs. Only missing exact programs are fetched and CRC-verified. Complete shaders do not authorize a speculative retry of a failing export. This remains an operator-only operation, separate from demo parsing.

Maps are exported and prepared serially. Both model tiers, the overview and the complete environment pack must validate against one asset version before publication. Existing map/overview/environment directories are never replaced, and failure rolls back only newly claimed directories across all three destinations. After the landscape merge succeeds, its embedded buffers/images and byte ranges are checked and the original glTF source hashes are recorded privately. Only this run's superseded main/sky export directories are reclaimed before tier packing; external inputs, raw Steam content, prepared sky faces and logs are retained. Source paths containing links or escaping the per-map stage cannot authorize cleanup. The remaining private scratch is removed after each map. Progress, pinned manifests, transfer/storage diagnostics and tool/resource provenance are retained in the cache. Ctrl+C cancels the active process group. Re-run with only the maps still needed, or use a new output directory for an update.

Budgets are explicit: at most 16 maps, 50,000 exact resource selections, 8 GiB selected bytes and 16 GiB allocated cache storage, with a 512 MiB free-disk reserve checked before stages and every 250 ms while a subprocess runs. Each prepared GLB is capped at 2 GiB to match runtime discovery, and a model/overview pair is capped at 4 GiB in total. Immediately before writing a tier, the packer checks the actual encoded GLB size plus the reserve against its filesystem's free space. It does not estimate compressed output from source texture sizes. Outputs are created exclusively. Only one periodic filesystem check runs at a time. A reserve failure stops that stage's process group and preserves partial sparse downloads for retry. Steam chunks can contain adjacent resources, so actual transfer/storage differs from the sum of selected entry bytes. Sparse VPK logical lengths also exceed physical disk usage. Host disk quotas and monitoring remain the hard storage boundary. Preparation additionally needs temporary space for source textures and both GLB tiers. If the available storage is insufficient, the installer stops instead of broadening the download.

Install `/srv/cswatch/maps` as the web service's `/data/maps` mount or copy the completed directories into the existing data volume. Files and newly created asset directories are made readable, while existing operator-directory permissions are preserved. Keep the cache private and outside the web asset mount. Do not add game content or the toolchain cache to Git or Docker images. Asset availability does not grant redistribution rights. Check your intended hosting rights, verify map coordinates with known positions, and inspect rendering/performance before making an installed pack public. glTF export still has the lighting/material limitations below.

`npm --prefix tools/assets run test:installer` exercises synthetic VPK/RERL files, strict selections, pinned prefab acquisition, environment precedence, shader planning, verified map/overview/environment publication, rollback and process cancellation. It does not contact Steam or substitute for a real map export, sky-orientation and alignment check.

Prepared environments live at `environments/<map>/environment.json` alongside `px.png`, `nx.png`, `py.png`, `ny.png`, `pz.png`, `nz.png` and private `provenance.json`. The six equal square PNGs are at most 1024 pixels and 8 MiB each, with a 32 MiB total bound. Runtime discovery checks their hashes, brightness from 0 to 16, and matching map/asset versions in both prepared tier manifests before exposing fixed, instance-policy-protected URLs. Generic static access cannot bypass these checks. Landscape capability reports geometry already merged into the map. The public application never accepts arbitrary sky URLs. Demo parsing does not convert game assets; optional map acquisition uses the separate official-source service.

Publication requires the environment descriptor with `schemaVersion: 2`. A supported enabled master post-processing volume also supplies a bounded `grade.rgba` sidecar. The installer selects the entity's exact compiled resource, uses the existing pinned depot flow if its VPK payload is absent, and validates the CRC before the DATA dump. SHA-256 binds the 3D color LUT to the descriptor. Unsupported or unavailable authored grading omits the sidecar and uses the viewer’s neutral grade.

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

S2V already converts Source inches/Z-up into glTF meters/Y-up. The viewer rotates exported assets +90° about Y to match its `(Source X, Source Z, -Source Y)` frame; it **does not scale them again**. Pin your S2V release and check coordinate alignment using known spawn points when selecting another S2V release. The documented CLI arguments can change between S2V versions.

The selective installer prepares supported v8.2 lightmaps, authored sky cubemaps and referenced distant geometry alongside the S2V export. Unsupported atlas bindings fall back to PBR with a fixed reason. Authored point and spot lights, reflection probes and additional Source material families remain outside the current conversion. Maps can remain large even after optimization. [S2V map export documentation](https://s2v.app/ValveResourceFormat/guides/exporting-maps.html)

Agent/weapon exports use S2V's [model export guide](https://s2v.app/ValveResourceFormat/guides/exporting-models.html). Static spectator weapons, recorded world equipment and optional agent rigs are supported with prepared packs. Native hand poses, recoil, animation graphs and Source 2 effects remain incomplete.

## Local 2D map and radar overviews

The 3D GLB and 2D overview are separate assets. For the 2D view and radar, export the actual map's radar artwork to PNG from your own local content with S2V. Use matching Valve overview text from the same map version, or supply a calibration you have checked against known Source coordinates. This standalone preparation command does not acquire artwork, infer missing map geometry, or guess calibration. The selective installer above can acquire the explicit matching artwork and overview metadata.

```sh
npm --prefix tools/assets run prepare-overview -- \
  --map de_mirage --image /tmp/operator-export/de_mirage_radar.png \
  --overview /tmp/operator-export/de_mirage.txt \
  --output /tmp/cswatch-map-assets --version CS2_BUILD \
  --source 'Local CS2 artwork exported with S2V VERSION'
```

The overview text must contain one matching map block and scalar `pos_x`, `pos_y` and `scale` fields. Optional `material`, `zoom`, `CTSpawn_x/y`, `TSpawn_x/y`, `bombA_x/y`, `bombB_x/y` and `inset_left/top/right/bottom` are loading metadata. `rotate` may be absent, zero or one. Valve’s display flag rotates the complete in-game overview panel, rather than changing the raster's world calibration. cswatch keeps the north-up raster and records the source display flag in provenance. This follows Valve's separate `WorldToMap` and `GetViewAngle`/`MapToPanel` operations in [Source SDK's MapOverview.cpp](https://github.com/ValveSoftware/source-sdk-2013/blob/master/src/game/client/game_controls/MapOverview.cpp), and the same north-up formula is used by [Awpy's current `world_to_pixel`](https://github.com/pnxenopoulos/awpy/blob/main/crates/awpy-python/python/awpy/plot.py). Other rotate values, nested/layered maps, duplicate fields and includes are rejected. Multi-level radar support is not implemented. Use explicitly calibrated north-up artwork when the source layout does not fit this supported subset.

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
  --items ak47,knife,smokegrenade,c4,plantedc4 --manifest PINNED_UINT64 \
  --output /srv/cswatch/maps --cache /srv/cswatch-asset-cache
```

Replace `PINNED_UINT64` with a source manifest you have approved and can access. Equipment/model installation requires this explicit pin. `--items` also accepts an explicit comma-separated subset such as `ak47,knife,smokegrenade,c4,plantedc4`. `--agents ct,t` is optional and can be run without equipment selection. The installer acquires exact selected model resources and their bounded static dependencies, checks CRCs and shader programs, and uses native default mesh/LOD masks. It excludes animation graphs and avoids exporting both legacy/HD geometry or first-person arms as duplicate body meshes. Every completed item is published atomically and never overwrites an installed item. A failed later item preserves completed immutable outputs. Restart with only missing IDs or use a new output root for updates.

Models are capped at 16 MiB encoded, 16 MiB decoded texture RGBA and 8 MiB decoded vertex/index data each. Inputs are checked before allocation, textures compress serially, and lossless Meshopt transport is decoded and compared before publication. Runtime model descriptors use fixed same-origin URLs and hash-bound self-contained GLBs. The browser loads visible items lazily under a shared device memory budget. Missing/failed models are reported in Options → Performance; they never remove the map. Recorded grenade bodies retain a small visible fallback when a model is unavailable.

Equipment geometry is normalized into its authored weapon root in Y-up metres. S2V already converts inches to metres. The viewer mounts the held model using its native grip and the agent’s sampled weapon axes. The static POV fallback is positioned from the normalized bounds. Recorded world items use recorded entity transforms when present, with nearby floor support for dropped and planted models. C4 and planted C4 share the native C4 model under separate fixed IDs. Planting animation and the native digits remain outside this pack.

New firearm preparation also inspects bounded native mesh metadata for an exact supported single-bone `muzzle_flash` attachment. Matching variants retain a named GLB marker and private source evidence, with one bone-local inches-to-metres conversion. Missing or unsupported attachment evidence is unavailable rather than guessed as native. The browser can use this marker for its recorded-event analytical flash. Existing operator packs are preserved and use a bounds-based analytical fallback. A small optional shot kick and separate first-person depth pass do not establish native arms or native recoil/reload animation.

The automatic assets worker prepares the full equipment registry in bounded selections and the directional CT/T bank separately. To prepare the CT/T bank manually, pass `--agents ct,t` with the explicit available manifest and a fresh output directory. The fixed registry selects all 101 full-pose resources for class locomotion, attacks, carry poses, defusing and shared deaths. The installer keeps one manifest through exact selection, VPK CRC checks and conversion. Each clip exports independently. The packer retains agent tracks from action exports and discards tracks for their separate weapon skins.

Retargeting uses exact joint names. It verifies each moving clip's direction from root travel or, for in-place clips, the planted foot trajectories. The pack records stride in metres and the normalized foot-cycle offset. Retargeting is capped at 8,192 samples, 1,000,000 sampled joints and 64,000,000 posed vertices per agent. Decoded geometry and animation data remain below 8 MiB, encoded GLB and decoded texture RGBA below 16 MiB each. Rotation and translation keys use quantized values in glTF float accessors with Meshopt transport. Agent packs retain S2V axes so the viewer applies the +90° Y correction once.

## Prepare existing native agent exports

Agent outputs are `agents/ct.glb` and `t.glb` with bounded manifests and provenance. Use a fresh output directory. For local full-pose exports, run `node tools/assets/prepare-agent-model.mjs --help` and supply all roles as flags, for example `--rifle-walk-w WALK_LEFT.gltf`. The shared contract defines the exact roles. The pack records the source files and versions in private provenance. [Shared agent contract](../../shared/agent-animation-contract.mjs)

## Native gameplay sounds

The version-controlled [sound registry](../../shared/gameplay-sounds.json) contains 116 fixed native samples and exact supported sound-event aliases. Source acquisition uses only official app `730`/depot `2347770`, a pinned manifest, a SHA-1-verified package index and CRC-checked selected VSND entries. No whole-game download, user account, uploaded sound or arbitrary URL is accepted. Keep all native files, decoded audio and preparation caches outside Git and application images.

The long-running `assets` service prepares this bank after a successful current-inventory refresh, only when no map job is ready to run and after its smaller landing-artwork task. It rechecks map work between idle tasks and shares storage guards, bounded attempts and the Steam login cooldown. Audio failure is logged independently and never changes map/replay readiness. An existing installed bank avoids repeat acquisition and is not overwritten. The web and replay workers do not download or convert sounds.

For standalone operator preparation, build the backend contracts and required conversion helper, create a fresh output root, then supply the verified official manifest as a decimal string:

```sh
npm --prefix backend run build
npm --prefix tools/assets run build:boundary
mkdir -p /srv/cswatch/new-sound-assets
node tools/assets/install-gameplay-sounds.mjs \
  --manifest PINNED_UINT64 \
  --output /srv/cswatch/new-sound-assets \
  --cache /srv/cswatch-private-audio-cache \
  --network-deny "$PWD/tools/assets/bin/asset-network-deny"
```

Replace `PINNED_UINT64` with the worker-observed or otherwise independently verified official source manifest, never a value inferred from a demo header. The command can bootstrap the pinned toolchain. Both `--s2v /absolute/Source2Viewer-CLI` and `--downloader /absolute/SteamFileDownloader` may instead select already verified operator tools. Keep source caches separated by manifest. The installer preserves the 512 MiB free-space reserve and has a fifteen-minute overall deadline. Missing/oversize fixed resources and unsupported codecs are reported per sample. Source hash/CRC failures remain integrity failures rather than silently selecting another version.

S2V writes native WAV or MPEG audio and may emit auxiliary files beside its input. Every input is therefore copied into a fresh conversion-only stage with its own HOME/TMP. Downloader manifests, `files.json`, home and cached tools are outside its writable roots. Native MPEG samples are normalized offline by pinned `mpg123-decoder` in a second confined Node child with a 128 MiB V8 heap and a thirty-second deadline. Complete frame counts, format and supported Xing/LAME metadata are checked against independent byte/sample limits. The HTTP server and browser receive only uncompressed PCM WAV, not MPEG. No remote decoding service or FFmpeg installation is required.

The installed layout is `sounds/<id>/{sound.wav,manifest.json}`, with private bank provenance at `sounds/provenance.json`. Each payload is at most 2 MiB, ten seconds, 48 kHz and two channels, and the encoded bank is capped at 64 MiB. The parent revalidates PCM structure, decoded duration and hashes before same-parent atomic no-replace publication. Existing banks are never overwritten. To change a bank, prepare a new output root, stop active viewers, preserve provenance and install the validated bank before reloading tabs. Native sample variations, full sound layering, wall acoustics and continuous loops remain incomplete even when recorded event names and positions are exact. See [replay sound evidence](../../docs/REPLAY-METADATA.md#gameplay-sound-evidence).

## Optional landing map preview

A decorative local map screenshot fades into the public landing, from the right on desktop and above the upload controls on phones. A fresh Docker image contains no game screenshot. The `assets` service can prepare the fixed native 720p Mirage screenshot automatically after its official metadata refresh, while no map request is ready. It checks for any existing fixed operator preview first and preserves it. It rechecks map jobs before starting the larger sound bank. Artwork failure does not change map or replay readiness.

`install-map-preview.mjs` selects only `panorama/images/map_icons/screenshots/720p/de_mirage_png.vtex_c` and its package index from fixed app `730`/depot `2347770` at one explicit observed manifest. It verifies the index SHA-1 and native entry CRC, reuses freshly verified cached bytes and records input/output hashes. Source selection is capped at 32 MiB, individual native/image files at 8 MiB and the task at five minutes. Fresh CDN downloads still reserve chunk overhead as well as the unchanged 512 MiB free-space floor; existing verified cache entries do not trigger unnecessary downloads. Conversion and final publication have independent write reservations.

Native input is copied into a fresh conversion-only root. Both S2V decoding and Node/Sharp normalization run through the required Landlock/seccomp helper, with stage-local HOME/TMP and no network. Downloader controls, manifests, cached tools and final assets stay outside converter writes. Final PNGs are fully decoded, normalized to at most 1600×900 and structurally/hash validated before the exact `--publish-preview` no-replace operation. Only the shared fixed target names are accepted. Output is `previews/<map>/{preview.png,preview.json,provenance.json}` with readable finalized artwork and retained private provenance.

For standalone automatic-source preparation, build the boundary, create a fresh output root and use a verified current manifest:

```sh
npm --prefix tools/assets run build:boundary
mkdir -p /srv/cswatch/new-preview-assets
node tools/assets/install-map-preview.mjs \
  --manifest PINNED_UINT64 \
  --output /srv/cswatch/new-preview-assets \
  --cache /srv/cswatch-private-preview-cache \
  --network-deny "$PWD/tools/assets/bin/asset-network-deny"
```

Do not infer `PINNED_UINT64` from demo header fields or overwrite another manifest's source cache. The verified toolchain can be bootstrapped, or supply both explicit trusted `--s2v` and `--downloader` paths. Steam exit 4 uses the worker's shared fifteen-minute cooldown. No arbitrary image URL, user credential, public upload or whole-game selector is accepted.

Alternatively prepare one of the fixed [preview map names](../../shared/map-previews.json) from an operator-provided local PNG:

```sh
node tools/assets/prepare-map-preview.mjs \
  --image /tmp/native-preview/de_mirage.png --map de_mirage \
  --output /srv/cswatch/maps --version CS2_BUILD \
  --source 'Local native CS2 map preview, exact source version recorded separately'
```

The local helper fully decodes a bounded single PNG and refuses an existing preview. Runtime delivery binds the image hash and fixed map name under normal setup/private policy. The public entry checks for newly available local artwork with bounded polling and retains a usable no-image fallback. This decorative image is not replay calibration or proof that a matching 3D pack is installed. Keep all native source/output artwork outside Git and application images.

The November 19 native proof converted the retained exact VTEX from manifest `807392217824910805` through confined S2V and Sharp, fully decoded the resulting 1280×720 PNG and matched its existing output digest. The installed preview remained unchanged. No new current-source Steam acquisition was run below the host's storage reserve; do not relabel this cached-source proof as a current download.

## Acquisition service and catalog maintenance

The separate assets Docker target supplies tools and the required Linux x86-64 Landlock/seccomp helper without the application database, auth/provider dependencies, account environment or game content. Acquisition alone has network access. S2V and Node conversion subprocesses receive stage-local HOME/TMP, confined byte writes, metadata/process restrictions and no sockets. The trusted supervisor still runs bounded Sharp decoders and publication validation outside that subprocess filter; maintain its memory/container limits and pinned dependencies. This does not make arbitrary native decoders safe or replace host quotas.

Automatic acquisition defaults off. The optional historical approval catalog starts empty. Latest fallback obtains official membership and source pins from fixed Steam metadata without generating approvals. Operators must establish recording/source relationships before adding historical entries. The viewer labels latest snapshots separately. [Deployment instructions](../../docs/MAP-ASSETS.md) cover read-only application catalog mounts, the isolated one-shot updater, resources, explicit retry and crash recovery. `npm --prefix tools/assets run test:catalog` validates updater bounds, atomic replacement and filesystem protection with original fixtures. No test acquires official game content. Docker/Compose runtime behavior is established by CI, not by the local source tests.

The long-running asset service starts in the normal Compose stack, without a profile. Automatic map acquisition still defaults off independently; metadata discovery and bounded idle artwork/sound bootstrap do not grant demo owners map-acquisition permission. Use `docker compose pull web worker assets` and then `docker compose up -d web worker assets` to update both the application and separate asset image. Administration distinguishes policy disabled, absent worker, missing/stale official inventory and optional historical-catalog state. Inventory failures retain only a fixed safe stage/code, timestamp/retry time and optional process exit code in logs/heartbeats/admin diagnostics, clearing on success. An empty catalog does not block latest official Ancient. Bootstrap polling is read-only and bounded; it does not retry failed conversions. Build revision/time describe the built image, while successful exact-revision CI remains the release evidence.

## Inspect recorded map evidence

Build the backend pure contracts first with `npm --prefix backend run build`, then inspect an already validated version 3 replay manifest:

```sh
node tools/assets/inspect-map-identity.mjs \
  --replay /operator/exported/manifest.json --catalog /operator/catalog.json
```

The catalog is optional. Without `--replay`, the command reads bounded JSON from stdin, so there is no need to mount the application database or recordings into an asset container. It reports only map fields, missing/conflicting evidence and distinct approval candidates. It does not parse `.dem`, contact Steam, create approvals or output actors/communications. Even a unique tuple match remains operator provenance rather than proof of the original map bytes. Actual approved/latest source selection is described in [map acquisition](../../docs/product/MAP-ACQUISITION.md).

## Cold image verification

Inventory preparation lets fixed tool setup use its existing bounded 20-minute bootstrap, then starts a separate 180-second metadata budget. The listing child still has a 120-second cap. Wrapped cancellations preserve timeout versus operator-interruption identity; source integrity, free-space limits and retry/cooldown policy remain intact.

Bootstrap sets a private HOME, CLI home and single-file bundle directory inside its fresh staging root. Cleanup removes that tree before tool provenance/publication, and existing verified caches are unchanged. The tool-cache mount must permit execution; the image root stays read-only. Fixed restore/compile/version progress and bounded child exit status support diagnosis without public native-output logging.

The parallel `asset-bootstrap` CI job builds the actual assets image and starts with a new private tool cache under read-only/non-root/cap-free container restrictions. It downloads and builds the checksum-pinned SDK, S2V and downloader, then proves verified reuse without rewriting provenance. Only its Steam listing is an explicitly original fixture. No CS2 maps, screenshots, sounds or other game files are downloaded or bundled. This adds genuine first-use tool/runtime coverage beyond fixture-based asset conversion checks; publication depends on both CI jobs. Docker execution remains CI evidence when the local runtime is unavailable.

## Automatic native player and equipment presentation

On a fresh assets volume, the worker prepares the directional agent bank, equipment models and HUD artwork. Capsule players and labeled equipment stand in when those assets are unavailable. The isolated worker uses its validated official inventory manifest to prepare fixed CT/T agents and fixed HUD artwork. It checks map/removal work between tasks, prepares these core assets before decorative work, then prepares the landing preview and sound bank before individual equipment models. Each equipment model yields back to the map queue and has a fifteen-minute cap. CT/T preparation has the existing finite forty-five-minute conversion budget. No full-game acquisition, uploaded assets or client-selected source exists.

SVG resources are selected as exact fixed `.vsvg_c` entries, hash/CRC checked, decoded and rasterized inside required Landlock/seccomp conversion. Only bounded validated PNGs publish. Model export and offline packing also run confined, with private HOME/TMP and fresh unpublished output roots. The packing children skip metadata changes that seccomp forbids. The supervisor validates bounded geometry before decoding, checks content/manifest identities and normalizes final permissions. Whole actor/artwork banks and each subsequent fixed equipment ID publish through descriptor-anchored no-replace native modes. Existing operator banks are preserved without modification.

Worker-owned status records retain fixed category, stage, source manifest, counts, generation and safe failure code. A persisted three-attempt budget survives restart. Transient failures back off optional idle work for five minutes while map/removal work remains available, and explicit Steam rate limits retain the shared fifteen-minute cooldown. Failed categories permit an administrator retry after the displayed cooldown through an immutable-generation intent. The intent binds a canonical hash of the entire failure snapshot, including source, attempts, time, current model and coverage. Enqueue rechecks this evidence and current terminal/cooldown policy after asynchronous writes, immediately before administrator authorization and intent publication. The worker rechecks the same evidence before resetting the attempt budget. Stale valid intents are retired without changing a newer failure. Source-integrity failure stays terminal for the selected source. These controls are separate from map-job retry/ownership policy.

Each native category keeps its first selected official manifest across inventory refreshes, explicit retries and worker restarts. Continued equipment models use the same owned bank source and its matching private Steam cache. A changed current inventory neither resets an exhausted attempt budget nor silently mixes a newer model source into the bank. Contradictory owned-bank/status evidence persists a terminal source-integrity diagnostic and leaves installed bytes untouched. Idle acquisition still requires a successful inventory observation within twenty-four hours, including after prolonged map work. Maps and removals retain their independent queue policy.

If Steam permanently denies the pinned native source, an administrator retry preserves that source and may fail again. Pin changes require operator-managed preparation of an approved replacement bank and coordinated private status review while the assets worker is stopped. Do not change an active bank marker or erase private queue state to bypass source-integrity evidence.

Every output/control stage is registered in a private bounded crash journal before conversion can write large files. Startup and the next shared preparation remove only exact registered names with matching device/inode, ownership and safe no-link contents. The journal covers both sides of publishing-directory rename, leaving unknown/operator paths untouched. Read-only browser catalog discovery can observe assets prepared after the viewer opened, using a bounded forty-five-minute lease. Coarse `complete` flags stop polling a finished or consciously preserved partial bank. Detailed errors/generations stay administrator-only, and a later remount starts a fresh lease.

`presentation-assets.test.mjs` uses original synthetic geometry and SVGs to verify publication, retry generations, source-integrity refusal, per-item yielding, crash recovery and confinement. The hardened-image smoke exercises both fixed native publication modes, no-replace/link rejection and a crash between bank rename and final publication. These fixtures are not proof of downloading a fresh current CS2 asset set. Local low-disk stops retain the unchanged 512 MiB reserve, and actual Docker execution belongs to its successful exact-source CI run.

The first-person bank uses the same confined equipment conversion path. Its fixed registry names exact weapon models and authored clip resources, including shared default clips referenced by the silenced weapons' official graphs. A separate packing child assembles the hands, weapon, camera origin and actions. The worker alternates static and first-person items after the agent and icon banks. It uses fixed priorities, since the assets container has no replay or account mount.
