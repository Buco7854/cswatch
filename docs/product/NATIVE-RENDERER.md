# Native rendering follow-up

The released sunlight/sky correction improves the existing PBR path. The local follow-up prepares first-person rigs in the automatic worker and uses an initial set of native map shaders. Keep cswatch's interface, CPU-only hosting and the existing replay-access model.

Compact 3D is a separate optional tier for responsive playback. The offline converter keeps placed opaque world surfaces and samples their base colors, while simplifying geometry and omitting textured materials, blended and masked surfaces, and the separate sky landscape. The full tier retains detailed materials and native lighting work. Both paths use the same cameras, timeline, radar and recorded actors. [Matched verification](../VERIFICATION.md#compact-3d-2026-11-22)

## Source evidence

The [S2V export limitations](https://s2v.app/ValveResourceFormat/guides/format-support.html#gltf-export) explain why standard glTF cannot supply all of these automatically. Retained Ancient exports have primary UVs and four-component layer/paint attributes, but no usable secondary lightmap channel or binding. Never substitute UV0 or the blend attribute for native lightmap coordinates.

The earlier AK/arms diagnostic established 1,163,745 seed bytes while the workspace was below its 512 MiB reserve. The local worker later verified one fixed official Mirage manifest and completed the map and AK/arms packs. The ordinary viewer admits those packs in the isolated test instance. [Viewer checkpoints](VIEWER-COMPARISON.md) records the authored actions and the failed pixel gate for derived visibility.

## Local baked world renderer

The pinned map-level S2V export retains the authored normalized secondary UV channel with the map scale applied once. The local packer binds it for supported opaque lightmapped surfaces and stores log-encoded linear irradiance, sun shadow channel zero and a separate directional atlas. Mirage's prepared mobile and desktop tiers bind 1,990 surfaces. Two-way source color painting uses the separate four-component blend attribute with the original red/green modulation texture. The selected eleven materials cover 354 surfaces and retain authored detail where supported. The remaining layered normal/roughness channels, local probes, foliage, tonemapping and atmosphere work require separate source and visual evidence. [Verification](../VERIFICATION.md#local-native-mirage-lighting-and-layers-2026-11-20)

## First bounded map prototype

1. Continue from the one verified official Mirage source and a fresh private conversion stage. Bind native world/instance transforms, material parameters, lightmap UV/layout/scale, baked texture encoding and probes from their verified resources. Keep S2V as the pinned resource reader and geometry fallback. The observed visibility grid is decodable. Its corresponding world node has empty cluster assignments and absent LOD setup references, so the decoder alone cannot authorize culling. Treat unsupported fields explicitly. Preserve source identity and camera transforms.
2. Define a separately versioned native presentation contract only after the source spike proves those fields. Share validators between preparation and browser consumption. Bound encoded and decoded geometry, texture dimensions, shader features, entries, cells, LODs and per-resource allocations before expansion. Use fixed local names and hash-bound descriptors. Never accept arbitrary material programs or URLs from a demo.
3. Implement the smallest evidenced material family with baked diffuse, normal/roughness, directional shadowing and appropriate colour-space/tone mapping. Add layered ground and foliage only with their real inputs. Preserve exact Source transforms once. Local probes and interior visibility must come from source evidence, not a global artistic tint or guessed occlusion. Missing native presentation can retain the existing genuine PBR/2D path with honest status.
4. Prepare spatial chunks, authored LODs and device-compatible compressed textures in isolated CPU children. Inspect compression support in the browser. Do not require desktop BC textures on phones or silently exceed decoded-memory budgets. Pin local codecs/tools and preserve CSP restrictions. A converter may not spawn a tool to evade its sandbox. Each required tool runs under its own supervisor-owned stage boundary.
5. Integrate acquisition, generation-aware publication, discovery, serving, removal and retirement as one change. Extend exact descriptor/file allowlists and worker ownership journals for the new contract. Web remains read-only. Preserve immutable content URLs, in-flight descriptors, operator packs and removed-map suppression. The existing three-attempt/cooldown and explicit-retry rules remain.

Do not vendor the competitor's renderer or hosted packs. Independently prepare official Steam resources and follow applicable S2V/code licences. Proprietary artwork remains outside Git and images. Existing cache/source proofs are preserved.

## First-person rendering

The asset worker prepares source-authored hands, gloves and held models for first-person playback. Each rig uses the first-person depth pass and portrait framing. Authored draw, fire and reload clips sample demo time where those actions are available. Recorded shots drive firing and an analytical flash on the source muzzle joint. A contiguous false-to-true observation on the same active-weapon handle drives reload, with a ceiling of 256 replay ticks. Missing reload evidence leaves the idle pose. Firing uses the recorded shot events independently of reload evidence. [Automatic first-person rigs](../MAP-ASSETS.md#automatic-first-person-rigs)

A static held model remains the fallback while its first-person rig is unavailable. The AWP, SSG 08, G3SG1 and SCAR-20 can use recorded camera-service FOV in scoped POV. The lens masks the viewport and suppresses the held model during a recorded scope. Native movement sway, per-player skins, recoil, lens transitions and other game-engine effects remain open.

POV uses the sampled native pawn eye offset when available. A bounded shoulder-arm trace clips against supported opaque static render surfaces in follow mode and uses the same camera pose for spatial audio. Native collision hulls, invisible clip volumes and dynamic obstacles are outside this trace.

POV weapon and arm placement now samples a bounded stride from contiguous recorded locomotion. The same motion applies to installed authored rigs and static equipment. Reduced motion suppresses that layer. Authored fire and reload actions still use their recorded event or active-weapon evidence.

## Third-person rendering

Static equipment is packed in the authored weapon skeleton frame. The viewer samples the character’s weapon and finger joints for the mount. Grenades, Dual Berettas and defusing use their dedicated upper-body overlays in the directional bank. Grenade throws align the observed release to the corresponding clip’s hand-IK marker. The compact renderer uses a floor-traced contact shadow. Live sun shadows add a player-only depth pass and modulate the map’s existing direct sun term, including its baked sun mask.

The renderer still uses class locomotion for the lower body and class poses for many individual firearms. Replay evidence and continuous authored terrain contacts remain incomplete for airborne states, ladders, planting and corpse placement on uneven surfaces.

## Recorded smoke

The optional replay journal supplies recorded seed/rejection changes, color and origin. The browser simulates a bounded density grid off-thread and depth-tests individual instanced cells against world geometry. Event-only recordings render a bounded soft cloud around the detonation, with replay-time growth and fade. The simulated density and shading are approximations. Native noise, bullet cuts and explosive dispersal remain outside supported evidence. [Verification](../VERIFICATION.md#local-viewer-usability-and-presentation-follow-up-2026-11-21)

## Renderer and replay roadmap

1. **Texture clarity and frame pacing.** Keep a detailed path with authored textures and an explicit Compact 3D path. Measure visibility, draw calls, texture residency and compressed transfer independently. Prove authored visibility/LOD or conservative spatial culling on fixed native viewpoints before enabling it. Profile adaptive quality on physical desktop and mobile GPUs at matched output resolution, with p50/p95 frame time, time to first painted map, and cached and uncached seek latency.
2. **WebGPU renderer trial.** Keep WebGL and the calibrated 2D fallback available. Gate an optional renderer on successful adapter creation, formats, renderer self-test and context/device recovery. Test actual iPhones and representative desktop GPUs before device defaults change. Match native materials, x-ray stencil, sky placement, shadows, smoke, skinning and first-person depth before comparing speed.
3. **FSR 3 temporal upscaling.** The current Three.js WebGL path has spatial resolution scaling. AMD's SDK targets DirectX 12 and Vulkan. A browser implementation needs a verified shader port and temporally jittered scene color, depth, motion vectors for static and skinned geometry, transparency/reactivity masks and separate native-resolution UI. Reset history on seeks, cuts, scope transitions, chunk discontinuities, buffer changes and device loss. Verify ghosting on fast turns, moving players, smoke and the C4 wave, then measure GPU time and memory against native-resolution output. [AMD upscaler integration](https://gpuopen.com/manuals/fidelityfx_sdk/techniques/super-resolution-upscaler/)
4. **FSR 3 frame generation.** Treat presentation pacing as a separate experiment after trustworthy temporal inputs and stable real frames. The native SDK integrates with DX12/Vulkan swapchains. A browser implementation must schedule interpolation through the browser-managed canvas, present the HUD at its true update cadence, and keep generated frames out of the replay and audio clocks. Benchmark stable high-rate input, latency, scene-cut behavior and unsupported-device recovery before offering it as a setting. [AMD frame generation integration](https://gpuopen.com/manuals/fidelityfx_sdk/techniques/super-resolution-interpolation/) [WebGPU canvas presentation](https://www.w3.org/TR/webgpu/#canvas-context)
5. **Round-by-round ingestion.** Today the user can seek streamed playback chunks after the confined server parser finishes. Prototype a first-round checkpoint with message ordering, string tables, entity baselines and recording-global event identities. Compare time to the first usable round, total parse time, peak memory and output parity with the current worker. An optional client-side WASM trial would need an independently bounded worker, memory and cancellation measurements on phones, and explicit reconciliation with server-owned uploads and ACLs. Preserve the TypeScript service, parser confinement and CPU-only hosting.
6. **Recorded combat and utility detail.** Drive inferno footprints from evidenced fire coordinates and lifetime updates where exposed. Improve HE and C4 light/fade and smoke response only where timing, positions and event identity are recorded. Keep projectile and grenade effects independent of replay navigation, and retain reduced-motion controls. Recorded button displays require native command evidence and remain absent where the demo omits it.

## Acceptance gates

- Prove actual native decoded pixels for a sunlit exterior, a shaded exterior and a genuine interior. Record exact source/content hashes, camera/projection, replay tick, viewport/DPR and quality. Model-ready metadata is not paint evidence. Keep themes independent of map colour and test the production CSP.
- Compare matching retained content and capture original-game/reference conditions where possible. Do not treat different source revisions or unequal content as a controlled FPS benchmark. Preserve native source and material identities in measurements.
- Measure frame-time distribution, draws, visible/submitted triangles, CPU work, transfer, decoded geometry and texture residency, plus loading/seek cancellation and retained-resource cleanup. Cover cold/warm and low/high modes. Physical Galaxy S24/TV behavior requires actual devices before a certification claim.
- Check actor/x-ray visibility, native viewmodel depth, projectiles, utilities, audio listener and free/POV/follow cameras together. Preserve recorded identity and timeline semantics while changing presentation.
- Run original bounded parser/contract/publication/confinement tests, actual native conversion, EN/FR and both themes, public/private/setup browser suites, required hardened application/assets checks and exact-commit image verification. Do not promote a new pack or change defaults solely because it has fewer draws.

## Additional presentation review

The local viewer uses the posed `head_0` bone for player name and health labels when the prepared actor supplies that exact joint. A bounded offset clears the head and uses a bounded fallback height when the joint is unavailable. The browser checks follow the prepared crouch pose and reproduce the original label placement after a backward seek.

## Maintenance limits

Fresh fixed-depot inventory can discover official maps and select disclosed latest sources. It cannot promise that a future shader/resource format is already implemented. Record unsupported native features and retain an explicit usable fallback instead of producing broken geometry or fabricated lighting. Source and tool upgrades must not reset integrity failures, exhausted budgets or existing category pins. Preserve truthful feature status and attach actual evidence to each promoted capability.
