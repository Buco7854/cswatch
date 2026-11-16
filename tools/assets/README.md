# S2V map preparation

This is an **operator-only, CPU pipeline**, separate from the public app. It requires a local CS2 installation and [Source2Viewer-CLI](https://s2v.app/ValveResourceFormat/guides/command-line.html). The runtime does not require .NET or a GPU on the server.

```sh
cd tools/assets
npm ci
npm run prepare-map -- --s2v /opt/s2v/Source2Viewer-CLI \
  --game '/games/Counter-Strike Global Offensive/game/csgo' \
  --map de_mirage --output /tmp/cswatch-assets --asset-version CS2_BUILD
```

You can also use `--input /path/to/S2V-export.gltf` instead of `--s2v` and `--game`. Keep external textures and buffers next to that source export. The tool embeds them in self-contained GLBs. It generates separate desktop/mobile files, compressed WebP textures, simplified mobile geometry, and provenance manifests. It refuses to overwrite an existing tier. Prepare offline, validate, then copy the complete map directory into the app's `DATA_DIR/maps/`. Never replace files while clients are watching.

S2V already converts Source inches/Z-up into glTF meters/Y-up. The viewer rotates exported assets +90° about Y to match its `(Source X, Source Z, -Source Y)` frame; it **does not scale them again**. Pin your S2V release and check coordinate alignment using known spawn points after upgrades. The documented CLI arguments can change between S2V versions.

See [S2V map export documentation](https://s2v.app/ValveResourceFormat/guides/exporting-maps.html): exported maps omit baked lighting, point/spot lights, and skyboxes, and reduce some blended materials. This pipeline does not reconstruct those. Maps can remain large even after optimization; validate transfer size and GPU memory on target phones. The generated tiers are a starting point, not a mobile performance certification.

Agent/weapon exports can be prepared using S2V's [model export guide](https://s2v.app/ValveResourceFormat/guides/exporting-models.html). This release renders simple player bodies; loading character rigs, selecting mesh groups, blending animation clips, attaching weapons, and reproducing Source 2 effects remain renderer work. Do not describe those as complete.

No Valve assets are bundled. Operators provide assets and determine whether their intended hosting/distribution is permitted. S2V's own open-source license does not grant rights to game content. Don't put proprietary exports into this repository or its public container image.

## Optional agent models

The renderer discovers `DATA_DIR/maps/agents/ct.glb` and `t.glb`. Export chosen agents with S2V using `--gltf_mesh_list` to exclude first-person arms and optional meshes. Export only the idle/walk/run/crouch clips needed; full CS2 animation libraries are very large. Pack an export with:

```sh
node prepare-model.mjs --input /tmp/s2v-ct/agent.gltf --output /data/maps/agents/ct.glb
```

Each on-screen agent gets a cloned skeleton. The renderer selects clips by idle/move/crouch name and samples animation time from the demo clock, so scrubbing is deterministic. This is a generic animation approximation, not CS2's AnimGraph. The original player body remains the fallback when no model is installed. Player-specific skins, bone-exact poses, weapon attachments and first-person weapon animations are not implemented. Validate animation names in the emitted inventory and inspect the export in S2V before installation.
