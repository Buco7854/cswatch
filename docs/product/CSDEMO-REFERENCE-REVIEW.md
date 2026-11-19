# CSDEMO reference review

Observed 2026-11-19 against [csdemo.tv](https://csdemo.tv/). This is a browser and public-client study, with proposed work for cswatch. It does not implement the changes below or establish Source 2 parity.

## Actual review

Opened the site's public Spirit vs FURIA Ancient recording from BLAST Rivals 2026 Season 2, match 2400208. Watched its loading flow, sought through the recording, selected player perspectives, opened the five settings categories, inspected kills and utility, and activated a utility landing action. Reviewed fourteen captured images, including 1440 × 900, 768 × 1024 and 390 × 844 in both themes, plus a 1024 × 640 diagnostic view. The browser used a fresh unauthenticated context.

The match uses a prepared `.csda` artifact of 20,102,272 bytes. Its performance panel identifies 64 Hz data and a duration of 55:33. This observation concerns that catalogue example. Personal file parsing and the site's backend are not verified by it.

Local, ignored evidence is under `.design/csdemo-study/`. `client-evidence.json` records the client hash, public resources, counts and limitations. `network-metadata.json` contains bounded request metadata without query strings, request bodies, cookies or headers. Screenshots contain third-party game artwork and remain outside Git.

## Visible differences that matter

The map has convincing shadowed interiors, outdoor light, surface detail, fog and grading. First-person arms and weapons are a major part of its game appearance. The tablet captures at replay second 443.109375 show an actual muzzle flash, with a nearby player model and the world behind it. The damage capture near 443.29375 shows strong red edge feedback and the death recap. The neutral capture at second 400 shows that the effect clears when seeking away from combat.

The red feedback is a recorded-hurt overlay. It is not evidence of native engine postprocessing. The shipped client ties its fade to demo ticks and the selected victim. cswatch already has recorded hurt feedback, so its coverage and visual strength need direct comparison rather than being described as wholly missing.

Weapons have moving first-person rigs, hands and shot handling. The client uses native muzzle attachments, short recent-fire timing, shot variants and a light contribution. This is materially different from cswatch's current static spectator weapon attachment. Game-derived particle definitions/textures and separate native sound banks also load.

The main review job is to watch the current round from a useful perspective. At desktop size, the world remains the dominant region. The score stays at the top, teams sit at the edges and kills/utility share one corner. On phones, the reference removes most desktop instruments and retains player selection, compact score and transport. This supports cswatch's existing progressive mobile policy.

There are details to avoid reproducing. At 768 px the reference's speed controls collide, several feed names become too short, and inputs can cover the left roster. Its phone moment panel clips information in the captured state. Dead roster rows also shrink horizontally, which the user already rejected for cswatch. Retain our keyboard access, focus handling, independent phone preferences, stable roster bounds and restrained surfaces. There was no new style draw or redesign in this review.

## Client architecture verified from public resources

The public entry loads Three.js plus a dedicated CS2 map/material, character, viewmodel and effects path. Its current native assets are described by the [CS2 asset index](https://maps.csdemo.tv/cs2/index.json). The reviewed [Ancient package](https://maps.csdemo.tv/cs2/maps/de_ancient/91c2e06c7492edf1ad6e/map.json) identifies format `cs2render`, version 5 and Source-inch coordinates.

| Area              | Observed evidence                                                                                                                             | Meaning for cswatch                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Lighting          | Irradiance, directional and shadow lightmaps, 82 reflection-probe volumes, a light grid, authored sun/fog, LUT, tone curve and bloom settings | A generic glTF/PBR conversion cannot be assumed to reproduce this appearance                        |
| Visibility        | Separate visibility metadata, cells/clusters and a client culling path                                                                        | Avoid submitting large hidden parts of the map                                                      |
| Geometry          | 323 material-family/spatial chunks, 272 with additional LOD data, decoded in a worker                                                         | Reduce geometry and submission work according to the current view                                   |
| Textures          | Ten size classes of texture arrays, 303 material entries, mipmapped BC-family GPU-compressed resources                                        | Reduce material switches, texture memory and bandwidth rather than only compressing download bytes  |
| Hardware fallback | Explicit compression-extension checks and a classified-map fallback                                                                           | Desktop BC compression must not become an unsupported requirement for phones                        |
| First person      | Arms/weapon rigs, native muzzle positions, shot variants and light-aware rendering                                                            | Build a dedicated first-person presentation path                                                    |
| Playback          | A prepared 64 Hz binary artifact, separate map and shared asset packages                                                                      | Keep map preparation separate from private recordings and benchmark playback decoding independently |

The native index listed eight maps at the time of review. A separate classified/coloured map release listed sixteen. This does not establish support for every map or exact historical geometry. Current asset-build metadata is not proof of the recording's original map revision. Keep cswatch's approved-source policy and disclosed latest fallback.

The classified Ancient GLB and the native CS2 package are different rendering paths. The native package advertises 152,454,994 bytes across 55 files. Do not compare its small classified GLB with cswatch's textured map as if they contained equivalent material data.

## cswatch gap

Our retained Ancient desktop GLB is 321,164,268 bytes, with 495,507,204 decoded geometry bytes and 704,293,388 estimated RGBA GPU mip bytes. These are existing operator-pack metadata, not a new production conversion. They come from a different source snapshot and renderer than the reference, so they are footprint clues rather than an equal-content FPS benchmark.

Current cswatch has calibrated maps/radar, authored sky and scenery, native default actors, limited native locomotion, static held/POV equipment, optional event-driven hurt feedback and review navigation. Automatic preparation closes deployment gaps but does not add native material shading, first-person arms, firing/reload action presentation, muzzle flashes, spatial visibility packages or view-dependent map LOD. The existing map mesh batching experiments also do not establish FPS gains. Through-wall bodies still use simplified proxies.

The largest remaining work is therefore rendering and asset preparation. Further control restyling alone cannot close these gaps.

## Follow-up status, 2026-11-19

The gap paragraph above describes the original review state. Released runtime `795c056` subsequently adds analytical recorded-event muzzle flash/kick/light, stronger hurt feedback, native posed-body x-ray and independent POV depth. A matched retained Ancient scene reduces draw submissions 52.2% through static transform/shadow reuse, without an FPS claim.

The current unreleased lighting follow-up retains authored sun direction and linear colour, corrects map-wide shadow projection and adds bounded, approximate local-sky irradiance/reflections to the world, landscape and POV. It reuses installed assets. It does not recover Source lightmaps, native layered materials or local reflection probes. Actual Ancient exports have primary UVs and custom four-component `_TEXCOORD_4` layer-blend data, but no standard secondary lightmap UV channel or lightmap binding. Never reinterpret that custom attribute or reuse UV0 as an invented lightmap layout. The [official export limitations](https://s2v.app/ValveResourceFormat/guides/format-support.html#gltf-export) confirm single-layer PBR conversion and missing baked lighting. At the pinned exporter commit, [layer-blend inputs](https://github.com/ValveResourceFormat/ValveResourceFormat/blob/942df5b37ebbde6153f6c488880b91d4bed003e6/Renderer/Shaders/common/surface_height_layers_vs.slang) and [baked-lighting inputs](https://github.com/ValveResourceFormat/ValveResourceFormat/blob/942df5b37ebbde6153f6c488880b91d4bed003e6/Renderer/Shaders/common/baked_lighting_vs.slang) are separate.

A read-only, fixed AK/arms/idle/fire/reload source diagnostic now reports indexed/CRC-verified/missing entries, exact selected source labels and lower-bound headroom without acquisition or conversion. The five indexed seed payloads total 1,163,745 bytes in the retained indexes, but their verified payloads are missing. Their transitive dependencies, Steam transfer chunks and converter scratch are unknown. Directory names do not prove source provenance, and these seed bytes are not an arms-preparation estimate. The existing reserve and source isolation remain unchanged.

## Next implementation priorities

1. Establish a repeatable Ancient scene benchmark before changing the renderer. Record the exact source pack, replay tick, camera, viewport/DPR, quality, warm/cold state and device. Measure frame-time distribution, draw calls, submitted/visible triangles, CPU work, decoded geometry, texture residency and transfer bytes. Compare matching conditions and retain pixel evidence. Include a real supported phone before making device claims.
2. Prototype an independently prepared native map path using official, verified Steam inputs. Preserve required converter confinement, CPU-only hosting, bounds and immutable publication. Extract baked material/lighting data and prepare spatial chunks, LOD and hardware-compatible compressed textures. Keep the existing map/2D fallback while the candidate is measured. Do not overwrite active/operator packs, recolour geometry heuristically or silently change Source units.
3. Build bounded first-person arms/weapon assets and native action clips with explicit attachment metadata. Drive firing, muzzle flashes, local flash lighting and impacts from recorded events and demo time. Include pause, arbitrary seek, speed, chunk-boundary and missing-asset behavior. Retain honest limits where the recording does not contain native bone poses, recoil or physical bullet/smoke simulation. Do not expand complete animation graphs.
4. Revisit damage feedback against the captured reference, including intensity, timing, selected-player coverage and death transitions. Preserve its option, reduced-motion behavior and event-based evidence. Test current published code before treating a deployment mismatch as absent functionality.
5. Tune the remaining HUD around the improved world. Keep compact top-level navigation, predictable scene space, stable player rows and phone defaults. Improve in-world labels and native silhouettes where evidenced. Preserve exact event timing, independent settings, recorded scoreboard values and accessibility.

The most visible changes should be the native map appearance, first-person combat presentation and measured rendering efficiency. Any new asset or replay contract needs its own version, validation and security tests. No third-party CDN becomes an app dependency, and no client bundle, game artwork or hosted reference pack is vendored. Our fixed official acquisition remains the source. No HLTV catalogue is reintroduced.

## Verification limits

The available browser host was disconnected, so this review used the installed lockfile Chromium through Playwright. It rendered through ANGLE/Vulkan SwiftShader. Initial desktop rendering was slow enough that several automation screenshots/clicks timed out. Later captures used the reference's normal 50% render-resolution, Basic upscaling and Low distant-detail settings. A performance-overlay capture showed 147 draws and about 1.09 million triangles for one pose, but its FPS is a software-rendering result, not a physical-device benchmark or a comparison with cswatch.

A later utility-landing action changed time from 400 to 392.54375 and selected the fly camera. Chromium then crashed during that screenshot while the cgroup OOM counter increased from 16 to 17 and OOM kills from 11 to 12. No completed landing-view image or stable memory result is claimed. The browser was closed and memory released. No real production account, current-source game acquisition or physical S24/TV validation was used.

This was a manual browser/public-client inspection, not an automated style-lint pass on their source or a production release. Fourteen successful screenshots were opened. cswatch runtime code, tests and published images were unchanged by the study.

Primary sources: [public viewer](https://csdemo.tv/), [observed client bundle](https://csdemo.tv/assets/index-CrZV_Syc.js), [observed UI stylesheet](https://csdemo.tv/assets/index-cHdcj5tJ.css), [native asset index](https://maps.csdemo.tv/cs2/index.json), [Ancient native package](https://maps.csdemo.tv/cs2/maps/de_ancient/91c2e06c7492edf1ad6e/map.json), [classified release](https://maps.csdemo.tv/v1/release-2000943-26598758-29692f92a98c.json), [Source 2 Viewer capabilities](https://s2v.app/).
