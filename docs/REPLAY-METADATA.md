# Recorded match and throw metadata

The optional `matchState`, `eventAvailability` and `throwInputs` fields extend the existing playback domain and version 2 manifest. They stay global while frame, grenade and voice slices are evicted or changed. Older prepared replays remain readable; they do not gain metadata without being processed again. Missing values remain unknown.

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

`CrosshairData` is an optional, bounded global timeline of exact controller share-code changes by string Steam ID. A `null` code clears evidence. Publication validates declared actors, nondecreasing ticks, code syntax and the 10,000-snapshot limit. Static geometry is decoded locally. Missing or incomplete evidence never becomes a copied player setting, and unsupported native dynamic styles remain unavailable.

Byte-adaptive chunks keep full recorded player metadata from `startTick` through their shared final boundary. The preceding five-second context contains only spatial position/pose/status fields for trails. A review tool seeking historical equipment, inputs or statistics must request the chunk whose descriptor owns that tick. It must not treat an optional field absent from trail context as proof of an unknown canonical state. This removes repeated HUD data while preserving every authoritative sample and the 4 MiB/512 MiB/160 MiB bounds.

Native unfinished rounds can have no winner. Only actual numeric CT/T team IDs become an optional round winner. Null, strings and other values remain unknown, and no winner establishes cumulative match scores.

## Recorded world equipment

Optional `itemState` metadata describes coverage independently for `dropped`, `planted` and `projectile` entities. `complete` is the conjunction of those category flags. Legacy metadata without category flags retains its earlier global meaning. Missing metadata remains unavailable. The existing streaming entity pass supplies changed `itemSamples` rather than another native whole-match object graph.

Entity identities include the recorded index, 17-bit serial and creation tick. Item definition indices supply equipment identity. Explicit owner and root-parent handles, complete cell/offset origins and recorded angle tuples supply placement. Parent-local coordinates are not interpreted as world coordinates. Molotov versus incendiary uses the recorded native flag, never the thrower's team. Unknown required fields hide the item and mark its category incomplete.

The collector bounds 128 tracked entities and 250,000 changed samples, reserving space for final removals. Per-tick coalescing removes states that were born and deleted within the same tick. Each streamed chunk carries the last live state into its start and includes subsequent changes/removals under the existing 4 MiB decoded limit. Seeking never resurrects a removed serial or interpolates through a tombstone. There is no inference of a dropped weapon from a death, inventory change or nickname.

The renderer uses authoritative projectile bodies only when projectile coverage is complete. Otherwise it preserves legacy recorded trajectories and bodies without attempting a positional identity match. This avoids duplicates while retaining low-quality and older-replay visibility. Recorded world transforms are distinct from the explicitly approximate static hold/POV model presets. Native hand poses, recoil and first-person animation are not implied.
