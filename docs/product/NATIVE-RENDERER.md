# Native rendering

Maps are native world packs written by [tools/cs2export](../../tools/cs2export/README.md) from Valve's compiled resources, and drawn by `frontend/src/world/`, a WebGL2 port of ValveResourceFormat 21.1's CS2 shaders (MIT). cswatch keeps its interface, CPU-only hosting and replay-access model.

## World renderer

- `renderer.ts` streams geometry and textures, compiles one program per material role set and draws the sky, then each world (main and 3D sky prefab) with its own depth clear, opaque and cutout ranges, then sorted translucent ranges. Ranges outside the frustum or hidden by recorded entity state are skipped.
- `world.frag.glsl` covers the CS2 families in the exported maps: complex/generic, environment and environment blend (two layers by blend modulation or vertex paint, including the `g_tColor2`/`g_tNormal2` layer; a third layer and height blending are not ported), vertex-lit generic, glass, foliage (transmission), static overlay and decal modulate, effects (masks, fresnel and distance fade), water (column fog and decay over the copied opaque depth, cubemap reflection by Fresnel, blended rather than refracted), unlit and black unlit, and sky. Unknown shaders use the generic path. Lighting uses the baked irradiance, directional irradiance and sun-shadow lightmaps, or probe volumes for unlit-mapped draws, box-projected cubemaps, the authored sun, cubemap and gradient fog, and the map's tonemap with a fixed exposure.
- `compositor.ts` composes the native world, three.js actors and equipment, smoke and the first-person rig into one HDR frame and grades it once. Actors sample the same probe volumes (`actor-lighting.ts`) and receive a player sun shadow on native receivers.
- Repeated world geometry is drawn instanced: an instanced range reads its transform, cubemap, probe volume and tint per instance from an RGBA32UI table in the vertex stage, one `drawElementsInstanced` per range and spatial cell, as VRF's `SceneAggregate` does. Lightmap coordinates belong to the shared mesh.
- `queries.ts` builds a triangle BVH from opaque ranges for the follow camera, feet, labels, tracers and wall-impact sounds; an instanced mesh has one tree shared by a leaf per instance. `entity-playback.ts` applies recorded doors, breakables and visibility to ranges and BVHs on play, seek and rewind.
- Texture tiers: desktop uses Valve's BC blocks as stored. Phones use ASTC with lightmaps and probe volumes packed into single arrays and HDR data log-encoded per channel, so the phone tier needs 13 texture units and the desktop tier 16 (Chrome reports 16 on ANGLE/D3D11 and Metal). Materials with more texture roles than a device has units drop their least important roles (secondary AO, detail masks, detail) first. Without BC or ASTC the viewer shows the 2D map with an explanation.
- Each pack's `unsupported` list states the current limits, for example frustum-only culling, static vertex animation and wind, static effect time, and no dynamic local lights.

## First-person rendering

The asset worker prepares source-authored hands, gloves and held models. Each rig uses its own depth pass and projection, composited into the graded frame. Authored draw, fire and reload clips sample demo time where those actions are recorded. Shots drive firing and a muzzle flash. A same-handle false-to-true observation drives reload (at most 256 ticks). A static held model is the fallback while a rig is unavailable. Scoped AWP, SSG 08, G3SG1 and SCAR-20 views use the recorded FOV and a lens mask. POV uses the sampled eye offset. POV equipment sways with recorded locomotion; reduced motion suppresses that layer.

## Third-person rendering

Static equipment is packed in the weapon skeleton frame and mounted on the sampled weapon and finger joints. The shared action bank (`agents/actions.glb`) gives every firearm its own carry pose, fire, reload and draw; two-bone IK then returns both hands to that weapon's authored grip on the `wpn` bone, released during reload and draw. Airborne legs, jump start and land, ladder climbing, hit flinches and deaths come from the same bank and the recorded pawn state. Grenades, Dual Berettas and defusing use dedicated upper-body overlays. Rapid shots blend from the outgoing fire pose at the new shot tick. Boot planting resolves against the native BVH with a bounded two-bone correction and fades during ballistic movement. Labels use the posed `head_0` bone when present.

## Recorded smoke

The replay journal supplies the voxel field, color and origin. A worker builds a bounded density grid and the compositor ray marches it against scene depth, with openings at nearby recorded HE detonations. Event-only recordings use a procedural cloud. Native noise and bullet trails through smoke are approximations.

## Release gates

- Measure cold and warm loads, mip-upload stalls, peak texture memory, draws and pass times on discrete and integrated desktop GPUs, a phone and a TV. SwiftShader results are valid for correctness and counts, not for FPS.
- Exercise depth intersections, smoke, x-ray, viewmodel grading, camera collision, seeks and context restoration on both texture tiers.
- Run the parser, publication and confinement tests, a real conversion, EN/FR and both themes, the public, private and setup browser suites, and the exact-revision image checks.
