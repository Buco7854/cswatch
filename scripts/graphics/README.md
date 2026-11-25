# Recorded production frame captures

`scripts/capture-viewer.mjs` opens the production watch route at an exact live-player POV and writes a private `frame.json` and PNG. Build the backend, native sandbox and frontend first. The demo is copied into a disposable local instance on loopback (default port 4672), parsed under the required Linux sandbox and removed afterwards.

```sh
npm run build
node scripts/capture-viewer.mjs \
  --demo /private/match.dem --assets /private/map-assets \
  --tick 52080 --player "$PLAYER_STEAM_ID" --quality high \
  --width 960 --height 640 --fov 73.74 --out /private/frames/first

node scripts/capture-viewer.mjs \
  --demo /private/match.dem --assets /private/map-assets \
  --tick 52080 --player "$PLAYER_STEAM_ID" --quality high \
  --width 960 --height 640 --fov 73.74 --out /private/frames/repeat \
  --reference /private/frames/first/frame.json --max-mae 0
```

- `--assets` is the server's map-asset root. A manual map is `MAP/map.json` with its payloads and `overviews/MAP`. For a worker installation add `--jobs MAP_JOBS_DIR` and, when configured, `--catalog MAP_CATALOG_FILE`. The selected pack must be ready, unremoved and current.
- The report binds the delivered `map.json` SHA-256 to the published pack, the texture tier (`desktop` or `phone`) and the Steam source manifest. It also records the replay, chunk and bundle digests, the actual player, tick, settings, viewport, framebuffer and camera matrices.
- The image is Chromium's composited canvas after the final screen pass, without the DOM HUD. X-ray, trajectories, tracers and labels are disabled. Recorded breakable and door tracks at the tick are listed. The probe reads tagged three.js scene instances, which native worlds do not have, so their map instances report as unmatched.
- `--quality auto|low|high` selects the preset. `--device-scale 2` exercises a dense display.
- `--play-seconds 12 --play-camera pov|follow|free` adds a moving-playback timing run. `--max-p95-ms 33.3` gates the p95 frame interval and the time-weighted p95. A breached budget exits 2; unverifiable movement or fewer than `--min-intervals` (default 20) exits 3. `--min-display-scale 0.75` also requires the render target to reach that fraction of the displayed size.

## References

`--reference` accepts a previous `frame.json` or a local `external-replay-frame-reference` manifest beside an opaque HUD-free CS2 PNG. The external manifest supplies `replaySha256`, `tick`, string `player`, `cameraMode: "pov"`, `map`, `sourceManifest`, `textureTier`, `coordinateSystem: "viewer-meters-y-up"`, column-major `camera.worldMatrix` and `camera.projectionMatrix`, `equipmentProjection`, `viewport`, `buffer`, `colorSpace: "srgb"`, `hudFree: true`, `png`, its `sha256` and `provenance` (`producer: "CS2"`, `version`, `captureSource`, `renderSettings`, `mapRevisionEvidence`).

A mismatched recording, actor, source, camera or missing evidence yields `unverified` without metrics. A verified reference reports full-frame RGB error. `--max-mae` gates it (exit 2). An unverifiable requested comparison exits 3.

Run the helper tests with `npm run test:graphics`.
