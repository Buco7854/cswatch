# Broadcast refinement

The later [immersive follow-up](immersive-viewer.md) supersedes this pass's permanent reveal/Lineups/input-widget interactions following new user feedback. The palette, roster hierarchy and native artwork decisions remain.

Continue True-black flat, seed1155974105. The user rejected merely tidy app cards for the spectator HUD. Preserve the approved public/member brand. The viewer has one theme-specific presentation plane shared by the toolbar, rosters, objective, inputs and full-width playback deck. The user explicitly rejected mixed dark/light surfaces and a separate selected-player strip. Both teams share a single right-edge roster; selection appears only as the row highlight, with no role banners.

The question remains: what is this player doing, with what equipment, now? Inventory: two current sides, normally five live sampled states each; immutable identities; actual HP/ammo/utility; missing versus zero; a selected observer; physical recorded actions; bomb deadlines; exact kill/death/objective ticks. Never invent team branding, portraits, official scores, native game countdowns or absent inputs.

References inspected as actual images: official ESL broadcast still (https://www.twitch.tv/eslcsb/clip/HeadstrongShortHippoPhilosoraptor-Ce0k-NTjn68_8867), plus PGL and BLAST official broadcast stills. Their useful structure is names and HP given first-glance hierarchy, recognizable equipment silhouettes and one compact inventory line. The final composition follows the user’s single right-edge roster rather than mirroring teams or duplicating the selected player. Take that hierarchy without copying tournament branding.

Barlow Condensed700 carries names and critical figures; IBM Plex Sans remains the working app type. CT blue and T orange/red encode recorded side identity. The shared viewer palette supplies every surface in each theme; only the selected row gets a team tint. Mouse/keys remain at the left edge. Both team groups stack on the right without role headers, avatars or a selected-player card. Complete inventory expands in the Players drawer on request. Phones start with one Lineups toggle and open the bounded roster explicitly. The bottom playback deck is flush to the frame, with no floating rounded tray. Objectives use one compact ribbon, with a main clock and secondary fuse.

Native timeline symbols were verified against the game's demoui implementation, with its actual crosshair-circle kill and skull death mapping; objective marks use native game HUD artwork where demoui has no native objective type. Operator artwork remains ignored and unbundled. The marker axis, hit targets, clustering, filters and seeking semantics must not change.

Rendered review: the first pass’s full-width HP rules read as table outlines. The final roster uses one team rail, short HP meters and one primary name/weapon/HP line. Complete inventory moved to the explicit Players drawer, and no selected-player strip/card or visible role heading remains. Tablet width was increased to avoid truncating short player names. The phone timeline labels were inset after the inspector’s edge-text finding.

The final production captures in `.design/broadcast-final/` cover EN/FR, both themes, desktop/tablet/phone/short landscape, native glyphs, objective ribbons, open phone lineups, hidden playback and explicitly enabled mouse diagrams. The 312-state member matrix reported no layout/runtime findings. The app inspector `.taste-skill/broadcast-inspect/` reported zero failures; its six captures were opened. One warning is accepted: 11–12 px spectator metadata/timecodes while working menus use larger text. The redundant phone Round selector is now in More. These are rendered checks, not user approval or real-device performance evidence.

The final user correction reduces occupied height further: player rows are 44 px, mouse diagrams default off separately from keyboard actions, and the playback deck has a single phone transport row. Timeline configuration moves into a native modal in More, leaving compact metadata and near-track native symbols. Secondary event targets are 32 px, independent of 44 px scrub targets. The bar hides through its preference or H, with a persistent 44 px reveal button; typing, native/ARIA dialogs, key repeat and hidden tab order are covered. Short-landscape optional input tools use a side header so the physical diagram fits. These changes preserve player selection solely as the right-roster highlight.

ROUND 3 — final app-screen review

Seen in one second: the replay scene, with information at its edges.
Idea (one sentence): one spectator surface with broadcast hierarchy and progressive review controls.
Live thing: exact seeking, recorded equipment/actions and objective deadlines.
Layout words by section: scene=canvas / roster=stack / inputs=instrument / timeline=axis / transport=row.
Scores: design 8 · usability 8 · creativity 7 · content 8 → overall 7.8.
Caps applied: known broadcast approach limits creativity; marketing photograph/scroll requirements do not apply to this app screen.
Top three problems addressed, with rendered evidence:

1. Portrait control occupancy: `mobile-fold.jpg` and `objective-fr-dark-390.png` now show one transport row, nearby event glyphs and a 129/161 px deck; `hidden-fr-dark-390.png` shows recovery without the deck.
2. Optional mouse instrument in short landscape: `mouse-enabled-fr-{dark,light}-844.png` shows the complete physical diagram beside its compact side controls. It remains absent in the default captures.
3. Mixed surfaces and duplicate player emphasis: `en-{dark,light}-1440.png` and the tablet captures show one matching palette and only the right roster's selected-row highlight. Remaining small metadata is secondary to readable working controls.
