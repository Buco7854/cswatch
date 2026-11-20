# Native rendering follow-up

This is an implementation plan, not a capability claim. The released sunlight/sky correction improves the existing PBR path. It does not close the reference viewer's native material, baked-lighting, first-person animation or visibility gaps. Keep cswatch's interface and CPU-only hosting.

## Evidence and immediate blocker

The [reference review](REFERENCE-REFERENCE-REVIEW.md) identifies native irradiance/directional/shadow lightmaps, local probes, layered materials, visibility/LOD and native viewmodels. The [S2V export limitations](https://s2v.app/ValveResourceFormat/guides/format-support.html#gltf-export) explain why standard glTF cannot supply all of these automatically. Retained Ancient exports have primary UVs and four-component layer/paint attributes, but no usable secondary lightmap channel or binding. Never substitute UV0 or the blend attribute for native lightmap coordinates.

The fixed arms/AK/idle/fire/reload diagnostic finds 1,163,745 indexed seed bytes without verified cached payload. Dependency closure, Steam transfer chunks and conversion scratch remain unknown. Indexed bytes are not a complete preparation estimate. The workspace filesystem is full and acquisition retains its 512 MiB reserve. Continue read-only evidence/design work while blocked. Resume source acquisition only after verifying actual free space and an explicit fixed official source, not merely a directory name or elapsed time.

## First bounded map prototype

1. Use one exact official Ancient source and a fresh private conversion stage. Extract native world/instance transforms, material feature/parameter evidence, lightmap UV/layout/scale, baked texture encoding, probes and visibility references from their verified resources. Keep S2V as the pinned resource reader and geometry fallback. Treat unsupported/missing fields explicitly. Do not infer atlas transforms, lighting energy, recorded revisions or dependency identity.
2. Define a separately versioned native presentation contract only after the source spike proves those fields. Share validators between preparation and browser consumption. Bound encoded and decoded geometry, texture dimensions, shader features, entries, cells, LODs and per-resource allocations before expansion. Use fixed local names and hash-bound descriptors. Never accept arbitrary material programs or URLs from a demo.
3. Implement the smallest evidenced material family with baked diffuse, normal/roughness, directional shadowing and appropriate colour-space/tone mapping. Add layered ground and foliage only with their real inputs. Preserve exact Source transforms once. Local probes and interior visibility must come from source evidence, not a global artistic tint or guessed occlusion. Missing native presentation can retain the existing genuine PBR/2D path with honest status.
4. Prepare spatial chunks, authored LODs and device-compatible compressed textures in isolated CPU children. Inspect compression support in the browser. Do not require desktop BC textures on phones or silently exceed decoded-memory budgets. Pin local codecs/tools and preserve CSP restrictions. A converter may not spawn a tool to evade its sandbox. Each required tool runs under its own supervisor-owned stage boundary.
5. Integrate acquisition, generation-aware publication, discovery, serving, removal and retirement as one change. Extend exact descriptor/file allowlists and worker ownership journals for the new contract. Web remains read-only. Retain old active immutable URLs, in-flight descriptors, operator packs and removed-map suppression. The existing three-attempt/cooldown and explicit-retry rules remain.

Do not vendor the competitor's renderer or hosted packs. Independently prepare official Steam resources and follow applicable S2V/code licences. Proprietary artwork remains outside Git and images. Existing cache/source proofs are preserved.

## First-person prototype

Start with one source-pinned AK and default arms prototype in a separate presentation category. Verify the actual skeleton, rest transforms, skin weights, muzzle and hand attachments before publishing a runtime descriptor. Keep world weapons and first-person rigs separate. Do not attach static arms heuristically and call them native animation.

Prepare a bounded idle/fire/reload clip set without expanding the full animation graph. Drive action selection by exact recorded player/weapon/events and demo time. Arbitrary seek, pause, speed, chunk replacement, weapon switching, death follow and missing clips require deterministic behavior. Keep current analytical flash/kick and explicit unavailable states until their replacements have native evidence. The recording still does not establish exact runtime bones, spread, recoil, collision or smoke simulation.

## Acceptance gates

- Prove actual native decoded pixels for a sunlit exterior, a shaded exterior and a genuine interior. Record exact source/content hashes, camera/projection, replay tick, viewport/DPR and quality. Model-ready metadata is not paint evidence. Keep themes independent of map colour and test the production CSP.
- Compare matching retained content and capture original-game/reference conditions where possible. Do not treat different source revisions or unequal content as a controlled FPS benchmark. Preserve native source and material identities in measurements.
- Measure frame-time distribution, draws, visible/submitted triangles, CPU work, transfer, decoded geometry and texture residency, plus loading/seek cancellation and retained-resource cleanup. Cover cold/warm and low/high modes. Physical Galaxy S24/TV behavior requires actual devices before a certification claim.
- Check actor/x-ray visibility, native viewmodel depth, projectiles, utilities, audio listener and free/POV/follow cameras together. Preserve recorded identity and timeline semantics while changing presentation.
- Run original bounded parser/contract/publication/confinement tests, actual native conversion, EN/FR and both themes, public/private/setup browser suites, required hardened application/assets checks and exact-commit image verification. Do not promote a new pack or change defaults solely because it has fewer draws.

## Additional presentation review

The retained close Ancient QA camera places name/health labels noticeably above the native head. Revisit anchoring against the posed native head and a small screen-space gap, while preserving generic fallback, crouch interpolation and immutable player identity. Static screenshots do not prove animation smoothness. Keep that issue separate from the lighting correction.

## Maintenance limits

Fresh fixed-depot inventory can discover official maps and select disclosed latest sources. It cannot promise that a future shader/resource format is already implemented. Record unsupported native features and retain an explicit usable fallback instead of producing broken geometry or fabricated lighting. Source and tool upgrades must not reset integrity failures, exhausted budgets or existing category pins. Preserve truthful feature status and attach actual evidence to each promoted capability.
