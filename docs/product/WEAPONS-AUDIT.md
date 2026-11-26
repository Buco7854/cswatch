# Weapons, grenades and effects audit

Evidence: pinned official manifest 5924479096069937098, a normal install prepared by the real worker with default settings, and the Mirage fixture (`var/fixture/input.dem`). Recorded item names map to registry IDs through `shared/equipment-key.mjs`; every name the fixture records (27 held items, 26 fired weapons) maps to its exact official resource (`shared/equipment-models.json`), including knife skins by name (Bowie → `knife_survival_bowie` model `knife_bowie`, Huntsman → `knife_tactical`, M9 → `knife_m9`) and the T default knife.

## Models and first person

| Family                              | World model                              | Viewmodel rig (arms + weapon)             | Clips before                          | Gaps found                                                                                                                                                                       |
| ----------------------------------- | ---------------------------------------- | ----------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rifles, SMGs, heavies, pistols (35) | 35/35 prepared, native muzzle attachment | 35/35 prepared, root-motion camera origin | draw, fire, reload (Zeus: draw, fire) | No inspect; one fire variant (no alternate/burst/silencer-off clips); no shell-eject attachment; M4A1-S/USP-S use the default rifle/pistol clips their official graphs reference |
| Knives (23 item IDs)                | 23/23                                    | 23/23                                     | draw, slash                           | No inspect, no secondary (heavy) attack                                                                                                                                          |
| Grenades (6)                        | 6/6                                      | 6/6                                       | draw, throw, underhand                | No inspect, no pin pull                                                                                                                                                          |
| C4                                  | 1/1 (shared with planted C4)             | 1/1                                       | draw                                  | No plant, no inspect                                                                                                                                                             |
| Defuse kit, planted C4              | 2/2                                      | none (not held in first person)           | —                                     | —                                                                                                                                                                                |

All 67 world models and 65 rigs prepare in a normal install (`presentation.item_ready` for every ID). World models keep the native `muzzle_flash` attachment only; shell ejection and grip attachments are not exported. The recorded player's own glove/arm model is not recorded per player in this demo, so rigs use the official default arms.

Recorded evidence available for first-person actions in the fixture: the inspect key (input bit `IN_LOOK_AT_WEAPON`, 1,000+ presses over 23 items; the pawn's `m_bIsLookingAtWeapon` is never set in this recording), attack/attack2 presses on held grenades (154), knife attacks with secondary-only input (0 in this demo), recorded C4 arming (4 plants), `is_in_reload`, scope state and scope FOV.

## Sounds

| Recorded source                                | Before                                        | Gap                                                                                                   |
| ---------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `weapon_fire` events (26 weapons, 1,590 shots) | Near-field fire sample per weapon             | No distant layer (`Weapon_*.SingleDistant`)                                                           |
| Reload parts (`Weapon_*.Clip*`, bolts, slides) | 51 aliases, 252 cues                          | —                                                                                                     |
| Knife slash / wall hit                         | Mapped                                        | —                                                                                                     |
| Grenade throw and bounce                       | Flashbang, HE bounce, molotov                 | Smoke bounce (400) and throw (40), HE throw (34), incendiary throw/bounce/start, decoy throw unplayed |
| HE and flashbang detonation                    | Game-event fallback samples                   | Recorded `BaseGrenade.Explode` / `Flashbang.Explode` unplayed                                         |
| Smoke                                          | —                                             | `BaseSmokeEffect.Sound` (40) unplayed                                                                 |
| Molotov / incendiary fire                      | Ignite, extinguish                            | `Inferno.Loop`, `Molotov.Loop`/`IdleLoop`/`Start`, `Inferno.FadeOut` unplayed; no looping             |
| Scope, R8                                      | —                                             | AWP/SSG zoom (72), R8 prepare (6) unplayed                                                            |
| Dropped weapons, pickups                       | —                                             | Weapon/C4/defuser floor impacts (~650) and pickups unplayed                                           |
| C4                                             | Initiate, plant, defuse, explode              | No beep (client-side in CS2, not in the recording)                                                    |
| Bullets on world surfaces                      | Representative wall contact from recorded aim | Native impact events are rarely networked (2 in the fixture)                                          |

## Effects

| Effect               | Before                                                                                                                                                                                              |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Smoke                | Ray-marched recorded voxel journal with an analytic fallback, but tinted by the recorded team colour (blue/orange) and lit by an analytic sun sweep: read as a flat blue-grey block with hard edges |
| Muzzle flash         | Analytic flash at the native muzzle attachment, recorded shots only                                                                                                                                 |
| Tracers              | Recorded aim with prepared-map occlusion                                                                                                                                                            |
| Shell ejection       | Missing                                                                                                                                                                                             |
| World impacts        | Audio only; no puffs, sparks or decals                                                                                                                                                              |
| Grenade projectiles  | Recorded trajectories with native models                                                                                                                                                            |
| HE, flashbang        | Analytic burst and light, recorded detonation                                                                                                                                                       |
| Molotov / incendiary | Analytic flame sprites over recorded fire positions                                                                                                                                                 |
| Smoke vs HE          | Small (2.4 m, 1.1 s) hole                                                                                                                                                                           |
| C4                   | Native model, recorded shockwave                                                                                                                                                                    |

## Fix order

Smoke (port the CS2 smoke shader); first-person evidence clips (inspect, pin pull, heavy, plant); unplayed recorded sound events, loops and C4 beeps; distant fire layer; shell ejection and world impact visuals.
