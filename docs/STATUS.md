# Feature status

## Access and replay

- Public mode offers guest upload and a private temporary viewing capability. Members manage their own demo library, sharing and private notes. Private mode gates viewers and assets independently. Sign-in supports local accounts and configured Steam identity. Optional French and English local speech transcription is available.
- The version 3 transport serves authorized manifests and bounded chunks. Timeline indexes are global, with a three-chunk browser cache and prefetch. Parser and speech work run in networkless Linux sandboxes. Unknown game fields stay unavailable.
- Members can link Steam, sync match sharing codes with their own game authentication code, open each match in CS2 and pair its recording with a private upload. FACEIT lists the CS2 matches of the linked Steam ID and imports approved recordings per map. Each provider is off until its operator key is configured. Live provider flows still need credentialed verification. [Provider setup](ACCESS-SETUP.md#steam-and-faceit)
- SQLite is initialized in an empty data directory. Startup checks the current schema and refuses incompatible data stores. Keep existing data and operator-managed assets under operator control.

## Viewer

- Finished demos open in a living player’s POV at the first recorded live round when available. Explicit links and saved tab positions override this starting tick. Wide screens show live team cards, a larger radar and round review by default.
- The whole-tab viewer supports POV, follow, free, overhead and tactical 2D cameras. Map loading exposes progress and 2D recovery. The playback controls, scoreboard, review, captions and input overlays support keyboard and touch, responsive layouts, and English and French in light and dark themes.
- Recorded events and sampled state drive economy, objectives, recorded player input, crosshairs, combat recap, native sound and grenade paths. Flash and damage feedback follow demo time. Tracers use recorded aim and bounded prepared-map occlusion. Reduced motion keeps steady feedback and disables tracers.
- The directional CT/T bank uses 101 native clips with recorded movement, aim and available action evidence. Missing rigs use capsule bodies. The dedicated first-person pass discovers automatically prepared, hash-bound weapon and hand rigs. Static equipment, movement inference and recorded event cues cover missing assets or evidence.
- Third-person equipment packs use the authored weapon root and the recorded animation’s weapon axes. Held items follow the posed grip, including independent left and right grips for Dual Berettas. The agent bank adds grenade and dual-pistol upper-body poses and weapon-class defuse loops. Live sun shadows render player and equipment depth separately from the cached map shadow. Compact 3D uses a floor-traced contact shadow.
- The directional player renderer uses demo-time foot plants and nearby rendered floor support. Corpse support uses bounded skin samples. Compact devices scale world equipment textures before resident-budget checks. The POV pass applies source weapon-metal parameters and its own highlight response inside the shared grade.

## Assets and rendering

- The separate assets service handles pinned official preparation, pending jobs and operator-authorized removal. Automatic acquisition defaults off. Latest snapshots are disclosed, manual map-name assets remain version-unverified, and publication requires complete validated packs with bound models and texture plans. Invalid worker-owned map packs enter preparation again.
- Detailed and optional Compact 3D share the replay cameras and calibrated overview. The graded output pass uses authored lighting data where available. One smoke volume pass uses journal or analytic density and reports an unavailable renderer.
- Local map evidence covers Mirage, Dust2 and Ancient in 3D and Cache in 2D. Native animation graphs, exact Source 2 materials and mixing, Workshop acquisition, and physical-device performance remain outside the verified feature set.

See [verification](VERIFICATION.md), [active work](product/WORK.md), [acceptance](product/ACCEPTANCE.md) and [security](../SECURITY.md).
