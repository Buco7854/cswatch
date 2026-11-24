# Offline map graphics captures

Run this from a CSWatch checkout on a Linux QA host with Node 24, util-linux `flock`, the locked frontend and asset-tool dependencies, and the corresponding local Playwright Chromium already installed. The operator supplies an approved prepared tier and an existing private parent directory. No account, demo, running site or Steam connection is needed. The runner streams one verified self-contained GLB over a one-use loopback route and restricts browser requests to its three local resources.

```sh
node scripts/capture-graphics.mjs \
  --audit /srv/private/packs/maps/de_example/desktop/visual-audit.json \
  --out /srv/private/captures/run-1 --device-id qa-workstation

node scripts/capture-graphics.mjs \
  --audit /srv/private/packs/maps/de_example/desktop/visual-audit.json \
  --out /srv/private/captures/run-2 --device-id qa-workstation \
  --reference /srv/private/captures/run-1/capture.json \
  --max-mae 1 --max-p95-ratio 1.15
```

The two thresholds above are example operator budgets. Each path resolves relative to the caller's working directory unless absolute. Output requires a new directory outside the tier. Its `capture.json` and `frame-NNN.png` files are private artifacts. The runner acquires the shared native-viewer benchmark lock itself. Use `--software` for a repeatable SwiftShader backend and check `renderer.gpu` for the actual device. By default the runner uses Chromium's selected device. For timing gates use a stable, nonsensitive device label identifying the same host, GPU and power configuration.

## What a frame measures

Each audit view supplies the exact glTF metre/Y-up eye and target. The camera and production map root receive the viewer's same +90° Y rotation. The default perspective is 60° vertical, 720 × 480 at DPR 1, with near/far 0.05/3000 metres. The up vector is glTF +Y, changing to +Z when the absolute vertical component of the unit look direction exceeds 0.999999. Set `--width`, `--height` and `--fov` to reproduce a known projection.

The harness uses the viewer's baked lighting, material layers and glass hooks, packed-material sampling, desktop texture detail, model placement and draw-range culling. It renders only the prepared main world under a fixed directional and hemisphere light, with ACES filmic tone mapping and sRGB output. Settings in each report identify the light colors, energies, direction and clear color. Full-game sky, environment maps, grade LUT, transient effects, moving entities, replay cameras, shadows and HUD are outside this capture scope.

A material probe matches the named VMAT or glTF material and its available shader. It temporarily hides all main-world instances of the unique identity and counts changed framebuffer pixels at that exact camera. A visible result measures the material's contribution under these settings. Zero changed pixels can arise from occlusion, culling or matching background pixels. Ambiguous definitions, omission policies and missing identities carry separate reasons. Submission counters alone cannot establish material visibility. An intentional omission remains reportable even with zero coverage.

Four untimed renders warm each pose. Each of 20 measured renders includes JavaScript submission and a synchronous one-pixel framebuffer readback. The nearest-rank p50 and p95 therefore include GPU completion and readback. They measure isolated static draw work. Replay frame pacing, cold loading and interactive FPS require separate viewer measurements. Visibility probes and PNG encoding run outside the measured interval. The last measured render reports actual calls, triangles, lines and points, plus renderer-resident texture, geometry and program counts.

## Local reference manifests

A previous `capture.json` identifies a viewer baseline. Another supported input is a local `external-graphics-reference` manifest beside privately obtained opaque HUD-free CS2 or reference PNGs. The following template shows the external fields. Replace each placeholder with measured provenance. Preserve the actual camera and revision when a match is uncertain.

```json
{
  "schemaVersion": 1,
  "kind": "external-graphics-reference",
  "map": "de_example",
  "assetVersion": "<verified map revision>",
  "sourceSha256": "<matching source export fingerprint>",
  "coordinateSystem": "gltf-meters-y-up",
  "projection": {
    "type": "perspective",
    "width": 720,
    "height": 480,
    "verticalFovDegrees": 60,
    "near": 0.05,
    "far": 3000,
    "upRule": "gltf-positive-y-or-positive-z-at-poles",
    "dpr": 1
  },
  "colorSpace": "srgb",
  "hudFree": true,
  "provenance": {
    "producer": "CS2",
    "version": "<build identifier>",
    "captureSource": "<local capture method and revision evidence>",
    "renderSettings": "<graphics, lighting, exposure and output settings>"
  },
  "views": [
    {
      "index": 0,
      "eye": [1, 2, 3],
      "target": [4, 5, 6],
      "png": "reference-000.png",
      "sha256": "<reference PNG fingerprint>"
    }
  ]
}
```

`producer` accepts `CS2` or `reference`. Reference PNGs require plain local filenames and matching SHA-256. Compare the actual rendered area at identical dimensions, with no HUD, scaling, or alignment step. The external operator attests to HUD removal, map revision, source binding, pose and projection. A supplied matching manifest establishes a declared camera/revision match. It cannot authenticate how an external image was produced.

For matched frames, metrics report mean absolute error (MAE), root mean square error (RMSE) and maximum error across all three sRGB 8-bit channels, plus exact changed-pixel and total-pixel counts. Baselines additionally match tier, QA settings, scope and per-view identity. A different model fingerprint can measure a changed conversion of the same source. A different source revision, pose, projection, or missing evidence yields `unverified` with reasons and null metrics. Static external comparisons describe the declared frame only. They do not establish full-game parity.

## Result and limits

The inventory join keys are `map`, `tier`, `assetVersion`, `sourceSha256`, `modelSha256` and `auditSha256`. `auditBinding` is `tier-manifest` after verification of the published `visualAuditSha256`. The report also fingerprints the bundled renderer. Each `views[]` entry includes its index, input view and material identity, image name/hash, visibility, performance, comparison and requested checks.

| Field               | Values                                                                               |
| ------------------- | ------------------------------------------------------------------------------------ |
| `visibility.status` | `visible`, `no-pixel-change`, `unavailable`, `ambiguous`                             |
| `comparison.status` | `no-reference`, `missing-view`, `unverified`, `matched-baseline`, `matched-external` |
| `checks[].status`   | `pass`, `fail`, `unverified`                                                         |
| `verdict`           | `not-evaluated`, `pass`, `fail`, `unverified`                                        |

A matched comparison has no automatic quality threshold. Explicit `--max-mae` gates the full-frame RGB error. Explicit `--max-p95-ratio` gates the candidate/baseline ratio only when device label, browser, renderer, timing method, warmup and sample count agree. The process preserves the report and exits 2 on a breached budget or 3 on an unverifiable requested check. Ordinary successful captures exit 0. Input or rendering failures produce a nonzero error and remove the new partial output directory.

The runner accepts a 128 KiB audit with up to 24 views, 64–1920 pixels wide by 64–1080 high, a 10–150° vertical FOV and 5–60 measured samples per view. It verifies the detailed tier's prepared GLB and decoded texture plan and reserves at least 512 MiB beyond its estimated output. The browser run is bounded to four minutes after launch. Run the focused original-geometry and reference tests with `node --test scripts/graphics/capture.test.mjs`.

## Capture a recorded production POV

`scripts/capture-viewer.mjs` opens the production watch route at an exact live-player POV. Build the backend, native sandbox and frontend first. Supply a local uncompressed demo, installed map/presentation assets, a numeric recorded tick and a player Steam ID as a string. The input demo is copied to a new private temporary data directory, hashed, and parsed under the required Linux sandbox. The CLI signs into a disposable local instance on loopback (default port 4672). The password stays in memory. The temporary database, session and staged replay are removed when the run finishes.

```sh
npm run build
node scripts/capture-viewer.mjs \
  --demo /private/match.dem --assets /private/prepared-maps \
  --tick 52080 --player "$PLAYER_STEAM_ID" --quality high \
  --width 960 --height 640 --fov 73.74 --out /private/frames/first

node scripts/capture-viewer.mjs \
  --demo /private/match.dem --assets /private/prepared-maps \
  --tick 52080 --player "$PLAYER_STEAM_ID" --quality high \
  --width 960 --height 640 --fov 73.74 --out /private/frames/repeat \
  --reference /private/frames/first/frame.json --max-mae 0
```

`--assets` uses the server's normal map-asset root. For a manually installed map it contains `MAP/desktop` and/or `MAP/mobile` with the model and tier manifest, plus available environment and presentation assets. Acquisition is disabled. The run requires an available detailed model. Its freshly proven delivery ETag must agree with the selected tier manifest's SHA-256. Missing actor/equipment artwork can use the normal production fallback and is reported in the frame. Use the same `--software` option on both runs to compare software-rendered captures. The captured GPU label identifies the actual renderer.

The probe observes the production Three renderer inside the capture browser. It reads the committed Scene props, verifies the selected actor, tick and settings, and requests a normal demand frame. It compares the actual world camera with the recorded eye and interpolated aim from the delivered primary chunk. It captures Chromium’s composited canvas rectangle after the final screen pass, preserving the scene background beneath transparent fragments. The frame includes native lighting, available rigged actors, first-person equipment, sky and postprocessing. The output excludes the DOM HUD, CSS scope mask and HTML feedback overlays. Review-only X-ray, trajectories, tracers and labels are disabled. The probe requires the paused image and asset status to repeat before writing it.

`frame.json` records the demo, decoded manifest and chunk digests, map and source revision, visual resource and application bundle fingerprints, actual player/tick, effective settings, viewport, framebuffer size, camera transforms and equipment projection. The eye-position source distinguishes a recorded eye offset from the viewer’s standing or duck-height fallback. The map verification field carries the application's historical-source verdict. A manually installed model can reproduce an exact rendered frame while its correspondence to the map revision on match day remains unknown. Treat reports as private match metadata. Timing measurements belong to the isolated capture command.

### External recorded-frame references

Use `--reference /private/reference.json` for a local CS2 or reference PNG. The manifest uses `schemaVersion: 1` and `kind: "external-replay-frame-reference"`. Supply the following from verifiable capture records.

- `replaySha256`, exact `tick` and string `player`, `cameraMode: "pov"`, `map`, `assetVersion` and `sourceSha256` bind the recording, actor and map revision to the supplied source export.
- `coordinateSystem: "viewer-meters-y-up"`, `camera.worldMatrix` and `camera.projectionMatrix` declare the world camera. Both matrices have 16 column-major elements in the Three/WebGL convention. `equipmentProjection` supplies the corresponding separate POV lens matrix, or null when the pass was absent. The matrix tolerances are 0.00001 for world pose and 0.000001 for projection.
- `viewport: {"width": W, "height": H}`, `buffer: [W, H]`, `colorSpace: "srgb"` and `hudFree: true` describe the unscaled RGB frame. `png` names an opaque local file alongside the manifest. `sha256` binds its bytes.
- `provenance` supplies `producer` (CS2 or reference), `version`, `captureSource`, `renderSettings` and `mapRevisionEvidence`. These are operator attestations. Only supply camera or revision values established for the external image.

Missing HUD/projection evidence, an inferred tick, a mismatched source, or a different actor yields `unverified` and no metrics. Matching external provenance permits a pixel comparison of that one declared view. A genuine game reference remains necessary for a game-parity claim. Local viewer baselines additionally require matching parsed evidence, model, settings and asset states. A requested comparison that cannot be verified exits 3. A breached explicit MAE budget exits 2. Both preserve the frame and result.
