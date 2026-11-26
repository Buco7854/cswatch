# Player model audit

Fixture: the pinned Mirage recording (`var/fixture/input.dem`), parsed with the sandboxed parser. Captures use production Chromium with ANGLE SwiftShader at 960 × 540 against the same native Mirage pack and the agent bank from a normal install (depot 2347770, manifest `5924479096069937098`). [Verification](../VERIFICATION.md#player-models-2026-11-26)

## What the recording holds per player

| Evidence                                          | Recorded      | Source                                                                             | Used for                                                             |
| ------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Position, yaw, pitch                              | Every 4 ticks | Pawn                                                                               | Placement, aim, gait                                                 |
| Velocity                                          | Derived       | Positions                                                                          | Gait direction and speed                                             |
| Duck amount                                       | Every 4 ticks | Pawn                                                                               | Crouch blend                                                         |
| On ground                                         | Every 4 ticks | `m_fFlags` FL_ONGROUND                                                             | Airborne legs, take-off, landing                                     |
| Ladder                                            | Every 4 ticks | Move type 10                                                                       | Ladder climbing                                                      |
| Shift-walk                                        | Every 4 ticks | `m_bIsWalking`                                                                     | Recorded only; audible steps come from the server's own sound events |
| Agent model                                       | Every 4 ticks | Model handle (MurmurHash64B of the path)                                           | Identified: CT `ctm_sas`, T `tm_phoenix` for all ten players         |
| Agent skin item                                   | Every 4 ticks | `agent_skin`                                                                       | `customplayer_*_map_based` for every player                          |
| Gloves                                            | Not recorded  | `m_EconGloves` absent                                                              | Unknown                                                              |
| Active weapon, reload start, scope, defuse, flash | Every 4 ticks | Pawn                                                                               | Carry pose, actions                                                  |
| Fire                                              | Exact tick    | `weapon_fire`                                                                      | Fire layer                                                           |
| Hits                                              | Exact tick    | `player_hurt`: hitgroup, attacker, weapon, armor damage                            | Flinch, blood, body sounds                                           |
| Deaths                                            | Exact tick    | `player_death`: hitgroup, headshot, weapon, attacker, penetration                  | Death clip and fall direction                                        |
| Jumps                                             | Exact tick    | `player_jump` (493)                                                                | Recorded only; the ground flag drives the pose                       |
| Footsteps and landings                            | Exact tick    | Server sound events with the surface (4,286 concrete steps, 1,079 tile, 518 sand…) | Footstep sounds by surface                                           |

## Rendered before and after this work

| Area           | Before                                                                             | After                                                                                                  |
| -------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Weapon hold    | Every rifle, SMG, sniper and heavy used the M4A4 arms; every pistol used the Glock | Each of 34 firearms uses its own Valve carry pose, fire, reload and draw                               |
| Hands          | Right palm fitted to the grip; support hand wherever the class clip left it        | Two-bone IK puts both hands at the weapon's authored grip after aim and blending                       |
| Airborne       | Vertical path curvature only                                                       | Recorded ground flag: Valve airborne legs, jump start and land layers                                  |
| Ladder         | Walking clips on a vertical path                                                   | Valve ladder climb, cycle locked to height                                                             |
| Hits           | Sounds only                                                                        | Valve flinch by hitgroup and side, blood at the hit point                                              |
| Deaths         | Two chest clips, the victim's own yaw                                              | Seven Valve deaths chosen by hitgroup, falling away from the attacker                                  |
| Footsteps      | One sample per surface, generic rolloff audible across the map                     | Every authored variation picked by the recorded seed, Valve's distance curve (silent past 1,100 units) |
| Actor lighting | Probe light in the diffuse term only                                               | Probe light also feeds specular and cloth sheen                                                        |
| Standing turns | The whole body, feet included, spun with every recorded aim change                 | Feet hold their yaw inside a 50° cone while the spine follows the aim                                  |

## Gaps

- The recording names only the map-based default agents, which the bank already prepares. On-demand preparation of other agents from their recorded model handle is not built; such players would use the team default.
- Deaths play Valve's authored clips with floor support, not a simulated ragdoll.
- Characters take sun visibility from the baked probe shadow. The world has no live sun shadow map for actors, so a player at the 24-unit probe resolution can read as shaded where CS2's cascaded shadows would light them (for example the T on the window-room stairs at tick 43193).
- Standing feet hold their yaw within a 50° aim cone; beyond it they rotate to the aim without Valve's turn-in-place step clips.
- Blood leaves no surface decal, and exit wounds are not modelled separately.
- Weapon pickups, drops and world impacts (124 sound hashes, 2,615 cues) belong to the weapon sound bank.
