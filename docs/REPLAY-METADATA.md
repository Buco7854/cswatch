# Recorded match and throw metadata

The version 3 manifest carries recorded metadata and coverage. Frames and their media slices have their own version 3 chunk envelope. Missing evidence remains unknown.

## Replay fields

| Field                                             | Contract                                                                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Map identity                                      | Optional. The recording can omit the required header evidence.                                                      |
| Round live tick, end tick and winner              | Optional. Parsed round events may not establish them.                                                               |
| Smoke tracks                                      | Optional. Native journal evidence can be absent, unsupported or over budget.                                        |
| Infernos                                          | Optional. Native burning-point data can be absent, unsupported or over budget.                                      |
| Agent deaths                                      | Optional. A death needs a nearby living pose, and the anchor bank has size limits.                                  |
| Gait history                                      | Optional. Valid movement data may be unavailable or exceed step or manifest bounds. Its inner record revision is 2. |
| Chunk descriptor stride                           | Optional. The manifest budget can omit the distance anchors.                                                        |
| Chunk aim                                         | Optional. Living angle evidence can be missing, and extraction and publication use bounded budgets.                 |
| Dead time, warnings and chat                      | Always arrays. With no corresponding observations or warnings they are empty.                                       |
| Communication and gameplay sound coverage         | Always present. Current producers report availability even when the timed arrays are empty.                         |
| Objectives, match state and crosshairs            | Always present. The producers supply samples and completeness, including for unsupported or interrupted reads.      |
| Item state and category coverage                  | Always present. Each item's transform and coverage category remain evidence-driven.                                 |
| Event availability, throw inputs and capabilities | Always present. Negative capability flags and empty arrays represent unavailable or absent evidence.                |
| World bounds                                      | Always present. The writer computes them from the validated frame domain.                                           |
| Chunk voice, sounds and item samples              | Always arrays. Lack of evidence or optional sound budget exhaustion produces an empty array.                        |
| Inline captions                                   | Practice sample only. Uploaded replay captions use the separate, authorized caption artifact.                       |

Gait history supplies each player’s directional clip phase from movement above the near-idle threshold. If the replay lacks that player’s gait history, the third-person renderer uses cumulative distance from the chunk stride anchor divided by an authored reference stride. With neither optional field, it samples the native cycle at demo time while the player is observed moving. The stride anchor also drives first-person weapon motion. Its horizontal centimeter totals include accepted slow movement.

## Recorded aim

Chunks may carry an `aim` field containing wire version 1 and sorted player-ID/base64 pairs. Each stream stores the gap from the previous recorded tick and a continuity bit, followed by zigzag-coded yaw and pitch as canonical unsigned LEB128. A break starts from absolute angles. Angular deltas take the shortest path around a turn. The 1/128° step bounds per-axis quantization error to 1/256° (0.00391°). The wire indexes source demo ticks directly, independently of the playback clock's rate.

The confined parser queries only yaw, pitch, liveness, position and pawn handle, alongside the native identity columns. It reads up to 16,384 requested ticks and 262,144 requested player-tick pairs per batch, then retains at most 32 MiB of projected samples. Dead or missing rows and ambiguous duplicate IDs leave holes. Missing position evidence, unknown or changed pawn handles, gaps, round starts and jumps over 128 Source inches break interpolation. The writer caps binary aim at 256 KiB and 128 players per chunk. It accounts for base64 and JSON bytes in the existing output limits. Optional aim can be dropped across the replay if extraction or output budgets prevent publication.

The browser checks version, actor identity, tick range, canonical encoding and byte limits before binding the track to primary frame positions. Trail context carries no aim. The pose sampler interpolates angles between contiguous recorded ticks, holds the previous angle up to a marked break and uses the original sparse pose where evidence is missing. The same quantized sample is present on both sides of a shared primary boundary when recorded. Positions and categorical state still come from the sparse frames, and the current replay clock still uses the existing nominal 64 Hz default for imported demos.

## Locomotion and C4 presentation

The optional per-chunk `stride` field is a list of immutable actor IDs and cumulative horizontal centimeters at the first primary frame. The confined writer skips round changes, dead/changed pawns, discontinuities and gaps above 250 ms. The same displacement and centimeter rounding run in the browser. The byte-adaptive writer computes anchors at the exact retained boundaries. Publication checks at most 128 unique known actor IDs per chunk and bounded monotonic totals. If the optional field would exceed the manifest allowance, the writer omits it. The same manifest byte bounds apply with or without anchors.

The C4 wave uses the recorded `bomb_exploded` tick and a complete event origin or the unique planted entity still present immediately before that tick. Existing item overlap covers the 0.85-second presentation window across chunk boundaries. Ambiguous or absent origins leave no wave. The radius and opacity are analytical rendering parameters. The Utilities setting and reduced-motion preference control the draw. Objective state, audio and damage derive from their existing recorded evidence.

## Smoke journals and scope projection

`smoke-state.ts` observes contiguous modern `CSmokeGrenadeProjectile.m_VoxelFrameData` records in the existing confined stream. The optional global `smokeTracks` bank stores entity index/serial, first/last observed interval, recorded detonation origin/color, the final byte journal and timestamped prefix boundaries. A projectile can outlive its current volume. The track therefore retires at the observed deletion or half a demo second after the last journal update, whichever arrives first. Shared validation caps 192 segments, 512 KiB of raw journal data and 20,000 timestamped updates before decoding. The viewer reconstructs supported density in a bundled local worker using the browser export of `cs2parser` 2.8.0, licensed MPL-2.0. [cs2parser source and license](https://github.com/osztenkurden/cs2parser)

The 3D viewer uses one smoke volume pass. It samples an analytic cloud when recorded density is unavailable, using the event location and estimated duration or the observed track interval when present. If the volume targets fail, the viewer reports that smoke rendering is unavailable. A restored WebGL context revalidates the targets.

An optional `Position.scopeFov` comes from the exact player camera-service field and appears only on recorded living scoped samples. The first-person scene consumes the discrete selected sample for supported sniper rifles and returns to the configured FOV on unscope. Without recorded scope FOV, the viewer uses the configured camera.

An optional `Position.eyeOffset` records `CCSPlayerPawn.m_vecViewOffset` on the existing sampled tick. The streaming solver requires a living pawn with the same Steam controller ID and a world position within one Source inch of the primary parser sample. Offsets quantize to 1/128 Source inch. The wire tuple stores `[height]` when both horizontal components are zero and `[x, y, height]` otherwise. Position and offset share the ordinary identity, round and teleport discontinuity checks. Missing eye offsets use the duck-based camera estimate.

## Recorded inferno footprint

The confined media pass reads `CInferno.m_firePositions`, `m_bFireIsBurning` and `m_fireCount`. Both native arrays have 64 slots. The version 1 `infernos` bank in the replay manifest identifies track lifecycles by entity index, serial and first update tick. Full snapshot repeats of a live entity preserve its state. An update encodes only a newly burning or moved point, in world-space units of 1/32 Source inch, or a slot removal when the burning flag clears. The exclusive end closes any remaining slots. Manifest storage carries state through chunk seeks without copying track history into each chunk.

Producer, publication and browser checks bound the bank to 256 tracks, 32 concurrent lifecycles, 8,192 updates and 768 KiB of accounted JSON. Each lifecycle has a 256-update and 12 KiB limit. The browser converts Source inches/Z-up to metres/Y-up and samples ignition and fade on the absolute replay clock. Optional data that is missing or rejected in the browser leaves the procedural fire patch at the recorded event. [Fixture evidence](VERIFICATION.md#local-utility-effects-2026-11-22)

## Match state

`shared/match-state.d.ts` defines complete snapshots, not patches. Each snapshot replaces the previous state at its recorded demo tick. The collector reuses the existing streaming `cs2parser` entity world and retains only changed state, up to 10,000 snapshots. `complete: false` identifies parser failure or a metadata bound; consumers must not extrapolate that state past its final recorded snapshot.

Scores come from raw `CCSTeam.m_iScore` with its current recorded `m_iTeamNum`. Side changes and overtime follow those values. The collector does not sum round winners, follow display names or assume a fixed half length. Missing/conflicting side entities do not become a zero score.

The current round uses an actual round-start counter when available. Otherwise, a recorded completed-round counter and recorded win status establish the current number: an active round is the completed count plus one; a completed round retains the completed count. Warmup, intermission, missing flags and ambiguous game-over state do not establish that fallback. `roundNumberSource` records the method. Local timeline ordinals are separate and are not evidence of a match round number.

Round/freeze/warmup clocks use recorded game-rule times. Absolute server seconds map to demo ticks through the actual `net_Tick` and server tick interval:

`demoTick + (absoluteSeconds - serverTick * tickInterval) * replayTickRate`

A tactical timeout uses its recorded remaining duration. Paused clocks retain a recorded pause origin, when available. Missing pause timing removes the countdown instead of freezing it at an unrelated later sample. Zero time never synthesizes a round result, phase transition or bomb outcome. A partial or absent native property never becomes a default 115-second round, freeze duration or timeout length.

The raw property references are the [CS2 schema dump](https://github.com/SteamDatabase/GameTracking-CS2/blob/master/DumpSource2/schemas/client/C_CSGameRules.h) and the installed reader’s entity definitions. Native field names may differ across game versions; unsupported fields remain optional.

## Event/stat coverage

`eventAvailability.player_death` and `.player_hurt` indicate successful native event queries, including a successful empty result. Failed queries retain `false`. Coverage concerns the recorded segment; it does not establish that a demo includes the start of a match or that a player began with zero kills. Death/hurt events request recorded player-side fields so explicitly labeled segment statistics can exclude friendly actions without using a player’s final side. Optional extra-field failures cannot erase the underlying events.

The match scoreboard uses optional `Position.stats` controller counters at the recorded frame tick: kills, deaths, assists, headshot kills and damage. These preserve actual pre-recording totals and native resets. Counter fields are queried independently from economy/input groups; unsupported, null, non-integer or out-of-range values remain absent individually. Successful event queries cannot fill missing match counters with segment-derived zeroes. Every numeric counter is bounded to a nonnegative safe integer; JSON coercion is not accepted.

Individual headshot, assister and damage fields still need their own recorded evidence. Query coverage does not promise that every optional event property exists. Identity joins use immutable IDs, never nicknames.

## Throw inputs

Each entry identifies the exact sorted global event by `eventIndex`, `tick` and `actorId`. Both `grenade_thrown` and utility `weapon_fire` events are supported. The native fixture records utility fires but no `grenade_thrown` events.

Input extras are requested at the event, independently from the 16 Hz rendering frames. Available unsigned masks remain decimal strings. `event-usercmd` identifies available command fields; `event-network` identifies a network snapshot read at that event. `unavailable` carries no input or sample tick. The transport also permits explicitly labeled, bounded `nearby-network` snapshots, but the current parser does not manufacture that fallback.

The native `buttons` alias maps to the previous network button mask, as documented in the [native parser mapping](https://github.com/LaihoE/demoparser/blob/main/src/parser/src/maps.rs). An event-network snapshot is not proof of the launch/release command. It must not become an unqualified claim about left/right mouse launch technique, physical key bindings or an inferred jump throw. Released/pressed commands appear only when those fields were actually recorded. Missing commands never come from velocity, view-angle changes, throw strength or a neighboring rendered frame.

The index is bounded to 10,000 entries; truncation adds a warning. Artifact validation rejects unknown actors, non-throw events, mismatched ticks, duplicate event bindings, invalid 64-bit masks, inconsistent provenance and unbounded sample offsets. Event input extras are removed from individual bullet events after the global index is built.

These additions inherit the manifest’s 16 MiB decoded limit, bounded total replay output, private demo access rules and disposable parser confinement. No provider credentials, network access, new filesystem grants or native execution paths are introduced.

## Recorded crosshairs and spatial context

`CrosshairData` is a bounded global timeline of exact controller share-code changes by string Steam ID. A `null` code clears evidence. Publication validates declared actors, nondecreasing ticks, code syntax and the 10,000-snapshot limit. Static geometry is decoded locally. Missing or incomplete evidence never becomes a copied player setting, and unsupported native dynamic styles remain unavailable.

Byte-adaptive chunks keep full recorded player metadata from `startTick` through their shared final boundary. The preceding five-second context contains only spatial position/pose/status fields for trails. A review tool seeking historical equipment, inputs or statistics must request the chunk whose descriptor owns that tick. It must not treat an optional field absent from trail context as proof of an unknown canonical state. This removes repeated HUD data while preserving every authoritative sample and the 4 MiB/512 MiB/160 MiB bounds.

Native unfinished rounds can have no winner. Only actual numeric CT/T team IDs become an optional round winner. Null, strings and other values remain unknown, and no winner establishes cumulative match scores.

## Recorded world equipment

The manifest requires `itemState` coverage for `dropped`, `planted` and `projectile` entities. `complete` is the conjunction of those category flags. A category with unavailable evidence is marked incomplete. The existing streaming entity pass supplies changed `itemSamples` rather than another native whole-match object graph.

Entity identities include the recorded index, 17-bit serial and creation tick. Item definition indices supply equipment identity. Explicit owner and root-parent handles, complete cell/offset origins and recorded angle tuples supply placement. Parent-local coordinates are not interpreted as world coordinates. Molotov versus incendiary uses the recorded native flag, never the thrower's team. Unknown required fields hide the item and mark its category incomplete.

The collector bounds 128 tracked entities and 250,000 changed samples, reserving space for final removals. Per-tick coalescing removes states that were born and deleted within the same tick. Each streamed chunk carries the last live state into its start and includes subsequent changes/removals under the existing 4 MiB decoded limit. Seeking never resurrects a removed serial or interpolates through a tombstone. There is no inference of a dropped weapon from a death, inventory change or nickname.

The renderer uses authoritative projectile bodies only when projectile coverage is complete. When projectile coverage is incomplete, it uses the independently recorded grenade paths to place projectile bodies. It avoids duplicates by withholding incomplete native projectile samples. Recorded world transforms are distinct from the explicitly approximate static hold/POV model presets. Native hand poses, recoil and first-person animation are not implied.

## Gameplay sound evidence

`shared/gameplay-sounds.d.ts` defines the manifest’s `gameplaySounds` coverage and per-chunk `sounds` cues. They are independent of voice packets, chat and captions. Unavailable sound evidence produces the corresponding coverage flag and no cues. The global manifest keeps six category coverage values and a truncation flag, rather than retaining every footstep or reload cue.

A cue has a stable `id`, recorded demo `tick`, fixed-registry `soundId` and category. `evidence` distinguishes native `network-sound` messages from `game-event` fallbacks. `selection` identifies representative native sample selection separately from recorded occurrence. Optional `eventName` retains the exact resolved native name. `actor`, when present, is an immutable string Steam ID from the manifest. Optional positions use Source inches and Z-up. Authored bounded volume/pitch may accompany a native event. `endTick` comes only from its explicit recorded stop and never establishes an inferred loop or duration.

The existing streaming parser observes `GE_SosStartSoundEvent` and `CS_UM_WeaponSound` inside the disposable parser boundary. Sound-event names use case-folded MurmurHash2 with seed `0x53524332`, distinct from the `0x31415926` parameter-token seed. The fixed registry binds supported names to native samples, and ambiguous hashes fail validation. Bounded packed parameters retain only the known `public.position` vector, rejecting duplicate, malformed or out-of-range positions. The collector does not guess unknown parameter meanings, sound resources or surfaces. Footsteps use actual surface event names, and reload foley uses actual weapon-sound tokens. Neither comes from movement, input buttons, ammunition or animation.

Recorded `weapon_fire`, grenade detonation/fire, bomb and numeric round-winner events can select representative native one-shots when there is no equivalent native cue. Plant completion specifically prefers native `c4.plantquiet` over the redundant `bomb_planted` fallback within two ticks. Explicitly different positions remain distinct. This is not category-wide deduplication: a grenade bounce and explosion at the same time are different recorded actions. Primary combat and objective events remain unchanged.

The collector retains at most 100,000 cues and 256 cues per 64-tick bucket. Each chunk carries at most 4,096 cues within its recorded span. Stable IDs allow shared-boundary/trail copies to be deduplicated without replaying old audio. Publication verifies registry/category bindings, actor membership, sorted times, stop bounds and consistent repeated identities. Sound remains under the existing 4 MiB chunk and total replay limits. If optional audio prevents otherwise valid replay output, preparation retries primary output without those cues and marks sound unavailable/truncated, preserving all primary frames, events and state.

Current coverage is explicitly partial: native first-variation samples and approximate listener/distance processing do not establish Source 2 randomization, layered/distant mixing, occlusion, reverb or complete persistent-loop behavior. Unknown or unprepared events remain silent. The browser shares one gesture-unlocked audio context with voice but uses independent gains, category controls and bounded caches. It follows demo time and playback speed, resets scheduled work on seeks/pauses/identity changes, and honors explicit stop ticks. Preparing or losing the optional native sound bank cannot change replay readiness or recorded voice availability.

## Private library match details

The final sampled player frame can supply cumulative kills, deaths, assists and headshot kills. A missing counter stays unknown. The controller rank and rank type associate the recorded rank with an exact Steam identity. Supported CS2 rank types are 7 (Wingman), 11 (Premier) and 12 (Competitive). A server rank update containing a matching account ID, rank type and new rank can establish an update. The change requires valid old and new ranks of the same type. [Rank types](https://github.com/markus-wa/demoinfocs-golang/blob/master/pkg/demoinfocs/common/player.go)

A private scratch file capped at 64 KiB carries these values from the networkless parser to the worker. The worker validates the file and its actor identities before storing the values with the demo. The three library tabs select the current member’s Steam identity at read time. Replays keep their existing version 3 wire format. A FACEIT participant level comes from the linked player’s match roster when that response provides it. [FACEIT Data API](https://docs.faceit.com/api/data/)
