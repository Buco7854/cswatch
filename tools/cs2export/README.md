# CS2 native world exporter

The offline tool reads a map VPK and its compiled dependencies from a local game root and writes a native world pack for any official map. Run commands from this directory so the SDK resolver uses global.json.

## Build inputs

- Microsoft .NET SDK 11.0.100, Linux x64. [Official SDK archive](https://builds.dotnet.microsoft.com/dotnet/Sdk/11.0.100/dotnet-sdk-11.0.100-linux-x64.tar.gz). SHA-512 `1bec9cca2ec689b1e80245b84f2b53c9441d1aa6daccf2ceb27490768bffa95954fa585bd275def31069d874d543d9ba9e6591fe9ade2dbd9f34ec5c0fd0050c`.
- ValveResourceFormat 21.1. [Tagged source archive](https://codeload.github.com/ValveResourceFormat/ValveResourceFormat/tar.gz/refs/tags/21.1). SHA-256 `6700eb517c5969464d7867f240ecfe6c6ba57ceecf6ba0e82779ef5dbb7a9928`.
- Arm astc-encoder 5.7.1 (Apache-2.0). [Tagged source archive](https://codeload.github.com/ARM-software/astc-encoder/tar.gz/refs/tags/5.7.1). SHA-256 `37ff3928c4c156fb3ac0d1adb5df144ff9c5cdbc8a8e1ffeb20229cc7f35c767`. Build the `astcenc-sse4.1` CLI with CMake (`-DASTCENC_ISA_SSE41=ON -DASTCENC_CLI=ON`). The published 5.7.1 Linux binaries need glibc 2.38, which Debian bookworm does not have.

- Convection Texture Tools (MIT), commit `350416daa4e98f1c17ffc273b134d0120a2ef230`. [Source archive](https://codeload.github.com/elasota/ConvectionKernels/tar.gz/350416daa4e98f1c17ffc273b134d0120a2ef230). SHA-256 `955df000fff2480962509bfbea767bb1c53b5b29883aba94ad832ad42f075803`. Build the lightmap encoder with the exporter's C ABI wrapper: `g++ -O2 -fPIC -shared -std=c++11 -DCVTT_SINGLE_FILE -Wl,--no-undefined -I<src> -o libcs2bcenc.so <src>/ConvectionKernels_SingleFile.cpp native/bcenc.cpp`. The exporter loads `/opt/cs2bcenc/libcs2bcenc.so`, or `CS2EXPORT_BCENC`, which the asset worker forwards to its confined child.

Set DOTNET_ROOT to the extracted SDK directory, put it first on PATH and set DOTNET_CLI_TELEMETRY_OPTOUT=1. Verify each source archive before extracting it.

```sh
echo '6700eb517c5969464d7867f240ecfe6c6ba57ceecf6ba0e82779ef5dbb7a9928  vrf.tgz' | sha256sum -c - &&
  mkdir -p .vrf && tar xzf vrf.tgz -C .vrf
dotnet build -c Release
```

`dotnet bin/Release/net11.0/cs2export.dll --check-model-inputs --game <game-root> --map <map>` follows the world and 3D sky placements, entity models, LOD 0 meshes, draw materials and their texture slots, and checks each compiled resource against its package CRC.

## Export a map

Install the frontend lockfile with Node 24 (`npm ci --prefix frontend` from the repository root). The packer uses its pinned meshoptimizer encoder and Three.js matrix routines.

```sh
ASTCENC=/path/to/astcenc node export.mjs --game "$GAME_ROOT" --map de_mirage --manifest 8225060435969537482 --out "$NEW_MAP_DIR"
node lab-server.mjs "$NEW_MAP_DIR" 4198
```

Models start from their lowest set LOD level, as VRF draws them. Every entity with a model is drawn, as in VRF's entity system (an unimplemented class draws its model): brush entities such as `func_conveyor` carry world geometry (rush_001's train floors), and trigger and clip volumes use tool materials, which are not drawn.

The stages are the ones the assets worker runs as separate confined, networkless children (the lightmap encoder runs inside the extract child):

1. `cs2export.dll --extract` mounts the map VPK, the map's official community addon when present (`csgo_community_addons/<map>/<map>_dir.vpk`), then the `csgo` and `core` packages, and reads the world, the 3D sky named by the map's own enabled `skybox_reference`, entities, materials, textures and lighting. The installer fetches a sky from the map's prefab folder or a top-level companion named after the map (`de_poseidon_3dskybox`). A sky or material that the game files lack is skipped and listed in `unsupported`.
2. `pack.mjs` writes geometry and the desktop BC tier, and plans the phone tier. When the game files lack the radar overview it renders one from the world (below).
3. `cs2export.dll --astc-inputs` lays out the planned BC/BC6H blocks as stacked TGA groups and measures HDR ranges. The worker then removes extracted payloads the phone plan does not read.
4. For each group, `cs2export.dll --astc-group` decodes it and `astcenc` encodes it (`-medium`), so scratch holds one uncompressed group at a time.
5. `finish.mjs` pages the ASTC blocks, writes `map.json` and the Brotli siblings.

On a 3-CPU host, Vertigo took 9.0 s for desktop packing, 1.2 s for the layout, 7.4 s for group decoding, 7.1 s for astcenc and 2.9 s for finishing. The confined worker job for Mirage from a local game root took 41 s.

Material textures keep the smallest of 256, 512 or 1024 at which UV0 reaches `CS2EXPORT_TEXELS_PER_INCH` (default 1.25) over the material's placed surface. The UV scale (`g_vTexCoordScale`, or `g_vTexCoordScale1` for blend layers) is included. Materials without a UV footprint keep 256. Cubes are capped at 128. Lightmaps the shader does not sample (`debug_chart_color`) and unbound volume textures are not exported.

Each map has a 100 MB desktop and a 70 MB phone download budget. Geometry, shared by both tiers, may take 45% of the phone plan at 8.5 bytes per triangle. Above that, placed models with a coarser LOD switch to it, largest saving first, and large opaque ranges (not foliage cards) are then simplified with meshoptimizer within 2 inches of the source surface, borders locked, with vertex normals as attributes so thin welded shells (rails, trims, chair slats) are not folded flat. A range whose simplification removes more than 0.5% of its surface area is retried at half the error, twice, then keeps its source triangles. On de_inferno the positional bound alone had removed 2.6% of the simplified surface (up to 31% of an antenna); with normals and the area check it removes 0.03%. On de_train 2 inches was indistinguishable at the spawns while 8 inches bent window frames, so geometry that still exceeds the allowance stays over budget. The desktop tier then takes the first material-texture plan whose estimate fits 91 MiB (5% below 100 MB for paging): full detail, cap 512, 1.0 texel per inch at cap 512, cap 256, then 0.75 texels per inch. When none fits, the map keeps full detail rather than lose texture detail without reaching the budget, and `budget.desktop.overBudget` records it. The estimate deflates the encoded geometry and every candidate texture level with the writer's own packing. Geometry is planned in two streaming passes (measure, then simplify and encode one range at a time), so a world of any size packs in bounded memory: de_inferno peaked at 1.06 GB RSS. Baked lighting is never reduced for a budget on either tier: lightmaps, sun shadows and probe volumes keep their full shipped resolution, and cubemaps keep 128. A map that still exceeds a budget keeps its quality and the overage is reported. Valve ships most lightmaps with no or partial mip chains. The exporter keeps every shipped level's blocks and completes the chain down to 4×4 with box-filtered levels re-encoded in the shipped format (BC6H, BC7 or BC1) by the pinned Convection Texture Tools; sun shadows (BC7, BC4 or BC5) become a BC4 red chain. On de_inferno (8192² irradiance and shadows shipped with two levels) encoding added 7 s on this 3-CPU host. The shader samples a lightmap's top level, so the desktop tier ships only that level. A generated level averages neighbouring atlas charts: on cs_italy a 1024 level smeared walls (MAE 5.0–8.0, 24–33% of spawn pixels over 8 levels against Valve's 4096 level). The phone tier's ASTC encoder reads the full-resolution level. Probe volume atlases keep their single level: each atlas packs many independent volumes, so a 2D mip would average neighbouring volumes together. `budget` in `map.json` records the plan, the coarser models and the simplified triangle count. A material texture shipped without smaller mips keeps its 2048 level.

The phone tier reuses the geometry, materials and bank layout. Banks keep levels up to a cap as ASTC 6x6, in sRGB or linear like the desktop bank. The plan takes the largest cap (512, 256, then 128; `CS2EXPORT_PHONE_CAP` lowers the first) then the finest lightmap block (4x4, 5x5, 6x6) whose estimate fits 64.5 MiB of download (2.3 MiB below 70 MB for estimate error) and 100 MiB of textures; `phone.budget` records the choice. The lightmap atlas keeps the full irradiance resolution. Each world's irradiance, directional irradiance and sun shadow become layers 0-2 of one array at the irradiance extent; other sizes are box-reduced or repeated by whole factors. Each probe volume and its sun occlusion become one 6x6 array. HDR data (BC6H irradiance, cubemaps, sky, probe volumes) stores each channel as `log2(1 + 1023 v / range) / 10` with a per-texture range (peak, at most 64) in `phone.hdr`. On Vertigo's lightmaps this measured MAE 0.66 against desktop for baked lighting, where RGBM measured 4.2–11.5. `CS2EXPORT_PHONE_LIGHTMAP_BLOCK`, `_VOLUME_BLOCK` and `_NORMAL_BLOCK` override the block sizes for measurements.

Open the printed loopback URL. The map directory can also be served as static files and passed with `?map=/path/to/map/&pos=-820,-2300,-113&ang=-1,44&fov=73.74`. Add `&tier=phone` to force the ASTC tier. Positions are in Source inches and angles are Source pitch and yaw in degrees. FOV is vertical. Focus the canvas for WASD, use Shift to move faster, Q/E for height, and drag to look. The selector switches between final lighting, albedo, normals, baked lighting, reflections, unlit and no post-processing.

Without an official overview, `overview.mjs` rasterizes upward-facing surfaces below the highest spawn or objective plus 320 inches, shaded by height and slope, into a 1024-pixel PNG. Its calibration (`pos_x`, `pos_y`, `scale`, Valve's contract) squares the spawn, objective and buy-zone entities widened by 25% plus 512 inches. If only the radar image is missing it renders against the official calibration. On Mirage, rendered with the official calibration, it covered 98.5% of the official radar's pixels. Maps whose post-processing files are missing use VRF's default filmic curve without bloom or grading.

```sh
node --test format.test.mjs instances.test.mjs texture-tiers.test.mjs overview.test.mjs simplify.test.mjs coverage.test.mjs
node capture.mjs "$NEW_MAP_DIR" "$CAPTURE_DIR" poses.json
```

`node expand.mjs "$PACK" "$OUT"` rewrites an instanced pack with every instance expanded into its own placed range (the pre-instancing layout, same vertex streams) so captures of both paths can be compared. On Mirage the two instanced APCs differed from the expanded pack on at most 1,684 of 518,400 pixels (MAE 0.0012, none above 8 levels) on both tiers.

`node coverage.mjs "$NEW_MAP_DIR" "$OVERVIEW_DIR" "$OUT"` checks geometry against the official radar: it renders the pack top-down with an orthographic camera framing the overview calibration (3D sky and fog off, material-ID view) and reports the share of the radar's opaque (playable) pixels that carry a rendered material, with a `coverage.png` marking uncovered ones in magenta. Near-black radar pixels mark solid walls and closed blocks and are counted apart as `solid`: de_cbble's closed blocks have walls and furniture but neither render nor collision floors in Valve's compiled world (checked against `world_physics` with VRF), so counting them as playable had reported 89.27% instead of 99.70%. On manifest 5924479096069937098 de_inferno measured 99.96% and de_debris 99.99%. Areas outside the playable radar, such as building blocks that are open from above, are not counted; de_inferno's are open in Valve's compiled world as well.

Fog and the 3D prefab have independent per-frame switches. The lab accepts `&sky3d=0&fog=0` and the capture script reads boolean `skybox3D` and `fog` pose fields, an optional display-referred `background` colour drawn instead of the sky (tactical views use a neutral `[0.003, 0.003, 0.003]`, about #1e1e1e), an orthographic half-height `ortho` in inches and a `view` render mode (7 is material ID). `CS2_LAB_TIER=phone` captures the ASTC tier.

Capture builds the lab entry in a temporary directory, serves it on loopback and uses the frontend's Playwright Chromium with ANGLE/SwiftShader, which exposes both BC and ASTC. Install that lockfile's Chromium beforehand if needed. The default sizes are 720×480 and 1280×720. Two final integer arguments select a single size. Each screenshot has a matching record in the output `poses.json`. Draws count WebGL submissions, including sky and fullscreen passes. GPU texture bytes are logical texel/block allocations including HDR and grading targets. CPU submission and wall time to a signalled GL fence appear separately.

## Format version 4

The output directory is immutable. Staging and publication use a same-filesystem rename. The input root stays read-only. Each binary is named by its SHA-256 and listed with its byte count and category in `map.json`. The manifest is the root of the hashes. Its own SHA-256 is measured separately. Coordinates remain Z-up throughout, including camera projection. Environment records retain each world's own transform and lighting metadata. Geometry positions in the draw buffer include the placement. The sky is rendered behind the main scene using a separate depth clear.

- Repeated local geometry is stored once and drawn instanced, following VRF's `SceneAggregate`: world ranges (not entities) of the opaque and cutout families whose vertices, indices, material and draw state are identical apart from cubemap, probe volume and tint share one mesh. Each copy is a 64-byte record in `geometry.instances` (a 3×4 row-major transform, cubemap index, probe volume index << 16, RGBA8 tint, two zero words). An instanced mesh has one range per spatial cell with consecutive `instances: [first, count]` windows; its vertices and indices are stored at its first range and the other ranges reuse them. The renderer draws each with `drawElementsInstanced`, reading records in the vertex stage from an RGBA32UI texture; ray, floor and sound queries share one triangle tree per mesh with a leaf per instance. Lightmap coordinates stay with the shared vertices, as in VRF. The 12M vertex bound counts stored (resident) vertices, and the geometry budget counts resident triangles plus about 24 bytes per further copy.
- Geometry uses a meshoptimizer uint32 triangle index buffer and shared per-range vertex streams. Position and UV0 are unsigned 16-bit offsets on the stored binary grid. Normals and tangents use two signed octahedral components each. Constant material, tint and probe bindings live on the range. Optional light UV, paint, blend and secondary UV streams are present only when their material reads them. Stream mode 0 is meshoptimizer alone. Modes 1 and 2 add reversible triangle prediction on 8- and 16-bit lanes. Placements are column-major matrices. The reader expands once to the 60-byte GPU layout below.
- File hashes and sizes describe stored bytes. Optional `packing` indicates a deflate stream with an exact, bounded `decodedSize`. For packing 8 or 16, undo the byte-lane transpose within each 4,096-block page after inflate. The result is the original BC blocks or meshoptimizer data. HTTP negotiates content-hashed payloads' precomputed Brotli siblings independently of pack encoding. The manifest also has a Brotli sibling.
- Levels are whole source mips, capped as described above.
- `phone` holds the ASTC tier: `arrays` parallel to the desktop banks (same ids, roles and layers), `specials`, `hdr` ranges, `lightmaps` (world to packed atlas) and `volumes` (probe atlas to the first sun-occlusion layer). The client selects BC (desktop), else ASTC (phone), else the 2D map.
- `chunks` groups by world, spatial cell or placed entity, sidedness, render family and ordered array bindings. Ranges index triangles in the common buffer and include bounds, material, entity and original cube/volume handshakes. Ranges for entity models retain the entity table index. Entity records retain the source ID, class, model, transform and initial visibility.
- `materials` retains the source shader, features, scalars, vectors, attributes, vertex signature and named texture slots. Each ordinary texture reference is an array bank and layer. The renderer uploads its numeric material parameters as a floating-point lookup texture.
- `arrays` and `specials` describe raw texture blocks with explicit per-mip offsets and sizes, from smallest mip to largest. Array layers are contiguous within each mip. Level zero is the largest retained level. The shader's sampling role selects linear or sRGB storage for material arrays. Cubes use six sequential faces per cube in +X, −X, +Y, −Y, +Z, −Z order. BC volume atlases use array slices and explicit depth interpolation. The payload retains Valve's block encoding. The BRDF lookup uses VRF's half-float texture and the grading LUT is contiguous RGBA8.
- Streamed mip descriptors reference a page file and a decoded byte offset. Banks share pages by refinement size and format. Bootstrap loads geometry, baked lighting, grading and mips up to 16 pixels, then the first completed frame starts background refinement. Finer levels become sampleable after every block row and layer has arrived. Refinement uploads at most 256 KiB per call and 1 MiB per animation frame, yielding after 2 ms of submission. The worker verifies and unpacks each page before upload.
- Set `CS2_LAB_MBIT=50` when running the capture script for a cold loopback benchmark. The map server shares one bandwidth clock across all map responses including worker requests. `load.json` records completed response body sizes and both timestamps from navigation to the GL fence of the first and full-quality frames.
- `visibility` is optional. Its little-endian header contains four uint32 fields (cluster count, row size, sky and sun indices), a float32 grid size and two float32 XYZ bounds. Count-prefixed sections follow in order for pairs of node words, packed uint64 regions, int32 enclosed-list offset/count pairs, uint16 enclosed clusters, uint64 masks and PVS bytes. The lab uses frustum and range bounds for culling.
- `unsupported` records rendering limits for this pinned slice. `textureConversions` lists re-encodings. Unknown shaders render with the generic CS2 material path. New Valve shader versions need an audit of vertex semantics, precision, lighting versions and resource limits.

| Byte | Field                                    |
| ---: | ---------------------------------------- |
|    0 | Position, 3 × float32                    |
|   12 | Normal, 3 × snorm8                       |
|   16 | Tangent, 4 × snorm8 including handedness |
|   20 | UV0, 2 × float32                         |
|   28 | Lightmap UV, 2 × unorm16                 |
|   32 | Vertex paint, 4 × unorm8                 |
|   36 | Layer blend, 4 × unorm8                  |
|   40 | Secondary UV, 2 × float32                |
|   48 | Material ID, uint16                      |
|   50 | Object cubemap index, uint16             |
|   52 | Baked lightmap flag, uint8               |
|   54 | Object probe index, uint16               |
|   56 | Object/draw tint, 4 × unorm8             |

See the repository's [Mirage verification record](../../docs/VERIFICATION.md#native-worlds) for measurements and coverage. Ported logic carries VRF's [MIT notice](THIRD_PARTY_NOTICES.txt).
