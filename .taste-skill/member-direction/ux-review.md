# Member workspace and viewer refinement

2026-11-16. Continues the recorded **True-black flat** app direction, seed **1155974105**. No redraw: the user accepted its general feeling and asked for stronger product structure. The established charcoal/light palette and IBM Plex Sans remain; Barlow Condensed is reserved for the cswatch wordmark. Public landing components and styling were not changed.

## Product decisions

- Library: “Which of my matches can I review?” The actual match list owns the canvas; upload is the primary action. Full-collection server search replaces filtering only the first loaded page. Refreshing preserves the loaded range. Counts come from the authorized query, and mobile round counts carry their unit.
- Account: “How do I manage my identity and security?” Account settings and Connections now live in the user dropdown and account tabs. They are no longer primary work destinations. `/connections` remains a redirect for existing links.
- Viewer: “What happened at this moment?” The match occupies the tab. Permanent playback and contextual controls stay inside it; one player/review panel opens at a time. Mobile uses 44px Play, Speed, Players, Review and More controls. Secondary transport, notes, fullscreen and advanced navigation remain available in the named action menu. Tablet retains direct controls with larger targets; short landscape uses one horizontal control row.
- A reusable headless select/menu layer supplies keyboard behavior, focus restoration, dismissal and viewport collision handling. Portals remain inside native dialogs or fullscreen elements when necessary. The light-theme play button uses a small neutral raised surface instead of the heavy black disc.

The face is the established near-black control room and cswatch mark. Its signature object is the real round strip and recorded review state, rather than invented personal statistics. The synthetic training courtyard remains explicitly labeled.

## Render critique

1. The largest block answers the screen's question: real match rows in the library and the actual rendered scene in the viewer. No vanity figures compete with the job.
2. Lists and panels share the canvas gutters. Mobile data becomes readable two-line rows. Viewer panels and hints follow the measured playback dock height, avoiding fixed-offset overlap when controls grow or rounds are collapsed.
3. Surfaces are neutral. The small brand signal marks focus, playback position and the active round; failure color is confined to the failed state. The viewer's team colors describe players.
4. Library totals use the authorized server query, and loaded counts describe the visible range. Round number/context and timeline use the same replay state. There are no invented deltas or totals.
5. Missing metadata uses a dash; actual zero remains zero. Empty search, first use, processing, failed parsing, unavailable credentials and replay buffering have explicit states.
6. There are no charts or unrelated legends. Recorded grenade trajectories and utility approximations remain labeled by the existing viewer contract.
7. Mobile navigation folds into a modal sheet; account actions stay in the user menu. Narrow and short screens use progressive viewer actions with keyboard/touch access rather than compressed controls.

## Evidence and limits

- Production screenshots in ignored `.design/ux-rebuild/`: library, account, connections, viewer and camera/action/account menus at 1440, 768 and 390 in dark/light; additional French guest320 and viewer landscape captures. Disposable local QA rows and a long username exercise actual layouts; these are never shipped as personal history.
- App inspector `.taste-skill/ux-inspection/` reported 0 FAIL and 1 WARN. All six fold/page screenshots were opened. The text-size warning is accepted for timecodes, round IDs and compact metadata in the closed spectator view; menu choices and working panels use 13–14px, and no measured text was below 11px.
- Focused browser regressions cover account navigation/legacy redirect, search beyond the first50 rows, pagination refresh, full-tab bounds/panels/notes, custom select keyboard and directional focus, menu bounds and Escape, 44px compact controls, and select portals inside fullscreen/native dialogs.
- Root integration owns the final full locale/theme/device/policy matrix and consolidated verification record. Viewport checks are not physical S24/TV performance tests or user design approval.
