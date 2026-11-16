# Native review event artwork

The optional operator pack contains exact CS2 artwork. No Valve artwork is committed to cswatch or its Docker image. Original semantic vectors remain the fallback when a pack is absent, identified by `data-artwork="original-fallback"`; loaded local rasters use `data-artwork="operator"` and their fixed `data-asset-key`.

The native demo controller's **kill** is a circled crosshair, while **death** is the skull named `kill.svg`. These are different meanings, not interchangeable weapon icons. The mapping was checked against Valve's extracted UI source in GameTracking-CS2 revision `82e2b9d62cc97f1358c68a220a4a392c9e41c509`:

- [Demo controller CSS](https://github.com/SteamTracking/GameTracking-CS2/blob/82e2b9d62cc97f1358c68a220a4a392c9e41c509/game/csgo/pak01_dir/panorama/styles/hud/huddemocontroller.css), `#HighlightIcons .highlight-icon.kill`, `.death`, and `.tick`.
- [Demo controller script](https://github.com/SteamTracking/GameTracking-CS2/blob/82e2b9d62cc97f1358c68a220a4a392c9e41c509/game/csgo/pak01_dir/panorama/scripts/hud/huddemocontroller.js), `DemoTimelineEvent` and `TimelineEventToLabel`.
- [Team-counter HUD layout](https://github.com/SteamTracking/GameTracking-CS2/blob/82e2b9d62cc97f1358c68a220a4a392c9e41c509/game/csgo/pak01_dir/panorama/layout/hud/hudteamcounter.xml), `BombPlanted`, `BombDefused`, blast damage, and kill flags.

The native demo event enum contains kill, death, damage and tick markers. **Bomb objectives are additional cswatch review events using the corresponding native HUD artwork, not native demo-controller event types.** Plant, defuse and explosion stay distinct. Neutral eliminations use the death symbol; they do not claim a kill by the selected player. Recorded round winners use CT/T emblems; an unknown winner uses a round marker. Utility throws retain their actual recorded utility icon, and headshots use the kill-notice headshot symbol.

All paths below are relative to `panorama/images/`. Game resources use `.vsvg_c`; S2V exports them as `.svg`.

| Pack key       | Exported source path                                   | Meaning                                                        |
| -------------- | ------------------------------------------------------ | -------------------------------------------------------------- |
| `demokill`     | `icons/ui/crosshair_circle.svg`                        | Selected player's kill, native demo controller                 |
| `demodeath`    | `icons/ui/kill.svg`                                    | Death, native demo controller                                  |
| `demotick`     | `icons/ui/bullet.svg`                                  | Native tick-marker artwork, reserved for explicit tick markers |
| `bombplanted`  | `hud/teamcounter/teamcounter_bomb-planted.svg`         | Native planted-bomb HUD                                        |
| `bombdefused`  | `hud/teamcounter/teamcounter_bomb-planted-defused.svg` | Native defused-bomb HUD                                        |
| `bombexploded` | `hud/teamcounter/killtype_blast.svg`                   | Native blast artwork for a recorded explosion                  |
| `roundmarker`  | `icons/ui/round_hash.svg`                              | Round marker when winner is unknown                            |
| `teamct`       | `icons/ui/ct_logo_1c.svg`                              | Native one-color CT emblem                                     |
| `teamt`        | `icons/ui/t_logo_1c.svg`                               | Native one-color T emblem                                      |
| `headshot`     | `hud/deathnotice/icon_headshot.svg`                    | Recorded headshot detail                                       |

Export the listed files with S2V while preserving their folders beneath an images directory. Include `icons/equipment/` for the existing weapon/utility pack. Then prepare one combined pack:

```sh
node tools/assets/prepare-equipment.mjs \
  --input /tmp/s2v-export/panorama/images \
  --output /tmp/cswatch-native-ui-pack \
  --version CS2_BUILD \
  --source 'Valve Corporation; local CS2 export with S2V VERSION'
```

Flat equipment-only export directories remain supported. Nested UI paths must match the fixed registry; no arbitrary path, URL or upload is accepted. Every nested source ancestor is checked for symlinks. The preparation tool accepts drawing primitives and a closed set of Adobe presentation declarations (`fill`, `fill-rule`, `clip-rule`, numeric `enable-background`); it rejects encoded references, CSS escapes, paint URLs, scripts, stylesheets and unsupported declarations. Only bounded alpha PNGs are published, with source/output hashes and read permissions independent of the operator's umask.

The development visual reference is an ignored contact sheet of these native assets, `.design/references/cs2-native-review-artwork.png`, generated from the operator preview pack. It is an artwork inspection reference, not evidence of running CS2 or a real-device playback test. Local preview sources were pinned to `Juknum/counter-strike-icons` revision `57a08657e1c2f1e6875c8b79575c23d4b6eb285a`; the files remain Valve artwork, and the archive does not grant redistribution rights.
