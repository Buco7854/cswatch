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

## Exact equipment silhouettes

The broadcast HUD can use the real, weapon-specific CS2 equipment artwork supplied by an operator. With no pack installed, recorded weapon labels and original schematic vectors remain available. cswatch does not bundle Valve's silhouettes. Community archives such as [counter-strike-icons](https://github.com/Juknum/counter-strike-icons) explicitly identify the artwork as Valve's; a repository or extractor license does not license that artwork.

Export the equipment folder from your local CS2 installation using the [S2V CLI](https://s2v.app/ValveResourceFormat/guides/command-line.html). S2V supports [byte-exact SVG export for Panorama vector graphics](https://s2v.app/ValveResourceFormat/guides/format-support.html):

```sh
Source2Viewer-CLI -i '/games/Counter-Strike Global Offensive/game/csgo/pak01_dir.vpk' \
  --vpk_filepath 'panorama/images/icons/equipment/' \
  --vpk_extensions vsvg_c --vpk_decompile --output /tmp/cswatch-equipment-export

node tools/assets/prepare-equipment.mjs \
  --input /tmp/cswatch-equipment-export/panorama/images/icons/equipment \
  --output /tmp/cswatch-equipment-pack \
  --version CS2_BUILD \
  --source 'Valve Corporation; local CS2 installation exported with S2V VERSION'
```

Point `--input` at the directory containing the exported `.svg` files if your S2V version uses a different output layout. The tool accepts only the 73 names in [the equipment registry](../../shared/equipment-icons.json), covering guns, silencers, knives, grenades and protective/objective equipment. It ignores unrelated files, rejects executable SVG elements/external references/symlinks, rasterizes drawing primitives to alpha PNGs of at most 256×64, and records source/output SHA-256 hashes in `provenance.json`. No SVG is served to browsers. The output directory must be new, and an error removes its temporary output.

After checking your rights and inspecting the prepared pack, install the complete directory as `DATA_DIR/maps/equipment/` and restart the server. Keep the provenance file beside the PNGs. The authenticated/private-instance access policy applies to `/api/assets/equipment`; it publishes only validated known PNGs. The browser loads this local manifest once per tab and applies each silhouette in the current theme color. Reload the tab after installing a new pack. No game CDN, external image URL or online icon service is used at runtime.

`npm --prefix tools/assets run test:equipment` checks preparation with original synthetic geometry, including SVG references, output limits, provenance, overwrite protection and symlink rejection. It does not fetch or commit game artwork.

## Optional agent models

The renderer discovers `DATA_DIR/maps/agents/ct.glb` and `t.glb`. Export chosen agents with S2V using `--gltf_mesh_list` to exclude first-person arms and optional meshes. Export only the idle/walk/run/crouch clips needed; full CS2 animation libraries are very large. Pack an export with:

```sh
node prepare-model.mjs --input /tmp/s2v-ct/agent.gltf --output /data/maps/agents/ct.glb
```

Each on-screen agent gets a cloned skeleton. The renderer selects clips by idle/move/crouch name and samples animation time from the demo clock, so scrubbing is deterministic. This is a generic animation approximation, not CS2's AnimGraph. The original player body remains the fallback when no model is installed. Player-specific skins, bone-exact poses, weapon attachments and first-person weapon animations are not implemented. Validate animation names in the emitted inventory and inspect the export in S2V before installation.
