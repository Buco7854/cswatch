# CS2 native world exporter

The offline tool reads the selected map VPK and its compiled dependencies from a local game root. Run commands from this directory so the SDK resolver uses global.json.

## Build inputs

- Microsoft .NET SDK 11.0.100, Linux x64. [Official SDK archive](https://builds.dotnet.microsoft.com/dotnet/Sdk/11.0.100/dotnet-sdk-11.0.100-linux-x64.tar.gz). SHA-512 `1bec9cca2ec689b1e80245b84f2b53c9441d1aa6daccf2ceb27490768bffa95954fa585bd275def31069d874d543d9ba9e6591fe9ade2dbd9f34ec5c0fd0050c`.
- ValveResourceFormat 21.1. [Tagged source archive](https://codeload.github.com/ValveResourceFormat/ValveResourceFormat/tar.gz/refs/tags/21.1). SHA-256 `6700eb517c5969464d7867f240ecfe6c6ba57ceecf6ba0e82779ef5dbb7a9928`.

Set DOTNET_ROOT to the extracted SDK directory, put it first on PATH and set DOTNET_CLI_TELEMETRY_OPTOUT=1. Verify the source archive before extracting it.

```sh
echo '6700eb517c5969464d7867f240ecfe6c6ba57ceecf6ba0e82779ef5dbb7a9928  vrf.tgz' | sha256sum -c - &&
  mkdir -p .vrf && tar xzf vrf.tgz -C .vrf
dotnet build
```

To verify model inputs before conversion, run `dotnet run --no-build -- --check-model-inputs --game <game-root> --map de_mirage`. This follows the main world and 3D sky model placements, entity models, LOD 0 meshes, draw materials and their texture slots. Each compiled resource is checked against the active package index CRC before VRF parses it.

## Export and inspect Mirage

Install the frontend lockfile with Node 24 (`npm ci --prefix frontend` from the repository root). The post-step uses its pinned meshoptimizer encoder and Three.js matrix routines. Run the exporter from this directory. The source identity for this version is Steam manifest `8225060435969537482`. It checks the map VPK's SHA-256 and each referenced entry's CRC, including the sky prefab, against the local archives.

```sh
dotnet run --no-build -- --game "$GAME_ROOT" --map de_mirage --out "$NEW_MAP_DIR"
node lab-server.mjs "$NEW_MAP_DIR" 4198
```

Open the printed loopback URL. The map directory can also be served as static files and passed with `?map=/path/to/map/&pos=-820,-2300,-113&ang=-1,44&fov=73.74`. Positions are in Source inches and angles are Source pitch and yaw in degrees. FOV is vertical. Focus the canvas for WASD, use Shift to move faster, Q/E for height, and drag to look. The selector switches between final lighting, albedo, normals, baked lighting, reflections, unlit and no post-processing.

```sh
node --test format.test.mjs
node capture.mjs "$NEW_MAP_DIR" "$CAPTURE_DIR" poses.json
```

Capture builds the lab entry in a temporary directory, serves it on loopback and uses the frontend's Playwright Chromium with ANGLE/SwiftShader. Install that lockfile's Chromium beforehand if needed. The default sizes are 720×480 and 1280×720. Two final integer arguments select a single size. Each screenshot has a matching record in the output `poses.json`. Draws count WebGL submissions, including sky and fullscreen passes. Triangles count submitted primitives. GPU texture bytes are logical texel/block allocations including HDR and grading targets. Depth renderbuffers, geometry buffers, the default framebuffer and driver overhead are separate. CPU submission and wall time to a signalled GL fence appear separately. The fence measurement includes queueing and polling.

## Format version 3

The output directory is immutable. Staging and publication use a same-filesystem rename. The input root stays read-only. Each binary is named by its SHA-256 and listed with its byte count and category in `map.json`. The manifest is the root of the hashes. Its own SHA-256 is measured separately. Coordinates remain Z-up throughout, including camera projection. Environment records retain each world's own transform and lighting metadata. Geometry positions in the draw buffer include the placement. The sky is rendered behind the main scene using a separate depth clear.

- Geometry uses a meshoptimizer uint32 triangle index buffer and shared per-range vertex streams. Position and UV0 are unsigned 16-bit offsets on the stored binary grid. Normals and tangents use two signed octahedral components each. Constant material, tint and probe bindings live on the range. Optional light UV, paint, blend and secondary UV streams are present only when their material reads them. Stream mode 0 is meshoptimizer alone. Modes 1 and 2 add reversible triangle prediction on 8- and 16-bit lanes. Placements are column-major matrices. The reader expands once to the 60-byte GPU layout below.
- File hashes and sizes describe stored bytes. Optional `packing` indicates a deflate stream with an exact, bounded `decodedSize`. For packing 8 or 16, undo the byte-lane transpose within each 4,096-block page after inflate. The result is the original BC blocks or meshoptimizer data. HTTP negotiates content-hashed payloads' precomputed Brotli siblings independently of pack encoding. The manifest also has a Brotli sibling.
- The default Mirage pack uses whole source mips. Material caps are 256, 512 or 1024 per the measured material list, cubes are capped at 128, irradiance at 4096. Preserve the 8192 shadow level sampled by the shader. Set `CS2EXPORT_MATERIAL_CAP=512` or `1024` to repeat uniform-cap trials.
- `chunks` groups by world, spatial cell or placed entity, sidedness, render family and ordered array bindings. Ranges index triangles in the common buffer and include bounds, material, entity and original cube/volume handshakes. Ranges for entity models retain the entity table index. Entity records retain the source ID, class, model, transform and initial visibility.
- `materials` retains the source shader, features, scalars, vectors, attributes, vertex signature and named texture slots. Each ordinary texture reference is an array bank and layer. The renderer uploads its numeric material parameters as a floating-point lookup texture.
- `arrays` and `specials` describe raw texture blocks with explicit per-mip offsets and sizes, from smallest mip to largest. Array layers are contiguous within each mip. Level zero is the largest retained level. The shader's sampling role selects linear or sRGB storage for material arrays. Cubes use six sequential faces per cube in +X, −X, +Y, −Y, +Z, −Z order. BC volume atlases use array slices and explicit depth interpolation. The payload retains Valve's block encoding. The BRDF lookup uses VRF's half-float texture and the grading LUT is contiguous RGBA8.
- Streamed mip descriptors reference a page file and a decoded byte offset. Banks share pages by refinement size and format. Bootstrap loads geometry, baked lighting, grading and mips up to 16 pixels, then the first completed frame starts background refinement. Finer levels become sampleable after every block row and layer has arrived. Refinement uploads at most 256 KiB per call and 1 MiB per animation frame, yielding after 2 ms of submission. The worker verifies and unpacks each page before upload.
- Set `CS2_LAB_MBIT=50` when running the capture script for a cold loopback benchmark. The map server shares one bandwidth clock across all map responses including worker requests. `load.json` records completed response body sizes and both timestamps from navigation to the GL fence of the first and full-quality frames.
- `visibility` is optional. Its little-endian header contains four uint32 fields (cluster count, row size, sky and sun indices), a float32 grid size and two float32 XYZ bounds. Count-prefixed sections follow in order for pairs of node words, packed uint64 regions, int32 enclosed-list offset/count pairs, uint16 enclosed clusters, uint64 masks and PVS bytes. The lab uses frustum and range bounds for culling.
- `unsupported` records rendering limits for this pinned slice. `textureConversions` lists re-encodings. The source check and the native renderer target this Mirage revision. Changing revisions requires a new audit of shaders, vertex semantics, precision, lighting versions and resource limits.

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

See the repository's [Mirage verification record](../../docs/VERIFICATION.md#native-mirage-world-lab) for measurements and coverage. Ported logic carries VRF's [MIT notice](THIRD_PARTY_NOTICES.txt).
