# Viewer maintenance

Use the [UX contract](product/UX.md) for the spectator layout and the [replay contract](ARCHITECTURE.md#replay-contract) for transport. [Replay metadata](REPLAY-METADATA.md) explains recorded evidence and availability.

## Playback and review

- `Viewer.tsx` owns transport and selection. Keep `playback.ts`, `playback-clock.ts` and `player-pose.ts` independent of Three.js. Bound the clock by contiguous decoded chunks and rebase seeks, speed, visibility and buffering without clamping elapsed demo time. Keep categorical fields on their recorded sample. Share wrap-safe angle and duck interpolation between actors, camera and equipment.
- `replay-cache.ts` and `useReplay.ts` own bounded, identity-scoped streaming. Whole-match navigation uses manifest bounds. Shared primary boundaries retain complete metadata. Spatial trail context is suitable for movement, while historical HUD queries require the authoritative chunk.
- `spectator-state.ts` preserves a pending recorded death through buffering and between sampled frames. Explicit transport resets it. A missing pawn needs a recorded death and the player's last observed side. Free-camera gestures respect visible focus and dialogs. Near-camera body/equipment filtering must leave other actors and recorded poses intact.
- `review-prompts.ts` owns throw/detonation association. A trajectory's last available sample supplies no landing claim. Use exact recorded ticks and immutable player IDs for review. Moment actions use normal seeks and camera changes at the chosen speed. Recorded projectiles remain visible independently of quality and path preferences.
- Keep recorded shot and objective cues seek-safe. Attack input supplies no shot evidence. C4 uses recorded deadlines and outcomes, with elapsed fallback for unavailable duration. Preserve seek-safe item removals and independent coverage by category. [Recorded world equipment](REPLAY-METADATA.md#recorded-world-equipment) [Gameplay audio](REPLAY-METADATA.md#gameplay-sound-evidence)

## Rendering and resource ownership

- `Scene.tsx` renders 3D and `TacticalPlot.tsx` supplies the 2D fallback. Uploaded demos use `useDemoMapAssets.ts` with demo-authorized, immutable pack URLs. Actual decode gates map readiness. Radar and 2D share overview calibration. Omit the radar without its decoded image and report unavailable or preparing maps without floating actor dots.
- Replay world placement is `(X, Z, -Y) * 0.0254`. S2V glTF is already metres/Y-up and rotates +90° around Y. Keep equipment's offline rotation and agent rigs' runtime rotation distinct. Main world and sky share the authored sunlight decision, with the shadow camera's projection matrix updated after fitting.
- `model-cache.ts` and `scoped-gltf-loader.ts` own separate bounded leases. Cancel network transfers promptly. Let in-flight embedded blob decoding settle before revoking URLs or closing bitmaps. Retired generations clean up their own late results. Keep shared cache resources and global loading managers intact. Demand rendering must invalidate on tick, camera, asset and held-key changes.
- Keep world, sky and POV depth ordering and restore renderer state. Native x-ray owns its stencil mask and shares the posed skeleton. Optional LDR sky filtering needs renderable half-float and complete output/blur targets. It preserves the full sky, viewport/scissor state and ordinary lighting fallback. Preserve named material identities, calibrated units and texture channels.
- Late native equipment/artwork discovery preserves valid partial catalogs and stops on completion, 401/403 or identity retirement. Use fixed local routes. Missing artwork falls back to the recorded equipment name. Dispose instance-owned clones and effects without touching active cache resources.

## Viewer interface

- `viewer-layout.css` owns responsive geometry and `viewer-presentation.css` owns shared palette and visibility. Keep instrument geometry with the instrument. Use `useReviewLayout` to keep radar, score, objective, feed and roster footprints apart.
- `useViewerChrome.ts` owns tap, keyboard and idle visibility. Separate taps from camera gestures. Hidden controls stay inert and recoverable. Captions and optional recorded-moment actions remain independent of faded chrome.
- Deferred dialog focus restoration retains the closing context and yields to a newer visible focus choice. Preserve removed-element and inert fallbacks. Reuse confirmation and control components and keep identity-aware mutations scoped across asynchronous work.
