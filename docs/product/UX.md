# Journeys and access contract

## Route families

| Route                               | Logged-out visitor                                                    | Signed-in member                           | Private-instance visitor |
| ----------------------------------- | --------------------------------------------------------------------- | ------------------------------------------ | ------------------------ |
| `/`                                 | One compact upload entry, subject to guest policy                     | Redirect to `/library`                     | Branded sign-in entry    |
| `/setup`                            | Operator-code enrollment only while no admin exists                   | Redirect after initialization              | Same initialization gate |
| `/watch/:id`                        | Own temporary guest capability or explicit shared link, otherwise 404 | Own or explicitly shared demo              | Sign-in gate             |
| `/watch/sample`                     | Labeled internal practice fixture, no public CTA                      | Same, separate from history                | Sign-in gate             |
| `/library`                          | Account gate with safe return intent                                  | Own demos, uploads, status and recovery    | Sign-in gate             |
| `/account`, `/account/connections`  | Sign-in with return intent                                            | Own identity/password and linked sources   | Sign-in gate             |
| `/connections`                      | Redirect to account connections                                       | Same                                       | Sign-in gate             |
| `/admin`                            | Sign-in then enforce role                                             | Admin policy only, other members forbidden | Sign-in then role check  |
| Old marketing and `/explore` routes | Redirect home                                                         | Redirect home, then library                | Sign-in entry            |

Private mode must protect APIs and game assets independently of SPA navigation. It may serve the generic frontend shell for routes so users receive a useful gate; it must not fetch or show gated content before authentication. Public registration is independent: private + registrations enabled permits account creation; private + registrations disabled offers sign-in and operator contact guidance only.

## Navigation

Public shell: wordmark, shared custom language dropdown, theme, Sign in, one upload action and GitHub. No marketing navigation, brand subtitle, sample CTA or community catalogue. The smaller headline introduces the actual task.

Member shell: brand and personal demo library. Account, Connections and Administration belong in the user menu. `/account/connections` is canonical. Mobile navigation is a bounded named sheet. The viewer has its own whole-tab shell and an accurate home/library back destination. Signed-in root always redirects to the library.

An uninitialized instance redirects to `/setup` before account or upload entry. Enrollment requires the operator-only setup code from the private volume. Environment credentials can provision the first admin, never reset one. A successful enrollment followed by a failed configuration refresh offers Continue without repeating account creation.

## Intent-preserving authentication

An account-required action records a **safe local return path** and, where relevant, an action intent (upload/import/notes). Authentication success returns to the intended route and exposes that action. Steam callback returns through a local completion route/state, not a user-controlled external URL. Never lose a selected file silently: explain if a file must be selected again after an external redirect. Keep registration-disabled and provider-disabled states consistent at entry and submit time.

## First-use member journey

Library opens with a real empty state and an obvious import action. Upload accepts drag/drop and file selection, states size/formats, and explains privacy. Submission goes to the queued/processing object with a return-to-library option. Ready demos open in the viewer. Failed demos show a useful explanation and deletion/retry path. Sample content lives in a separate practice entry, never as fabricated personal history.

## Guest viewer journey

When policy allows, a logged-out visitor uploads their own file directly from home. The temporary owner receives an expiring HttpOnly browser capability and separate CSRF. The queued object opens immediately, with a reminder to keep its URL in the same browser. Retention and quota limits are explicit. There is no public catalogue. A URL without that capability cannot read a private guest demo. Signing in never silently transfers temporary ownership.

Explicit shared demos remain readable under public/private instance policy. Personal notes require an account and never expose another user's notes. Sharing, renaming and account management remain account-owner actions. Original download URLs are never exposed.

## Viewer hierarchy

When the interface is visible: play/pause, scrub time, speed, round selection, camera/player selection, current context and fullscreen. Secondary: next round, skip dead time, event jumps, notes. Advanced options use Visuals, Crosshair, Playback, Camera and Performance categories. They cover x-ray shapes, radar, feed, trails, grenade paths/effects, recorded overlays, hide/skip/moment preferences, full custom crosshair geometry, vertical 3D field of view and rendering quality. Open these in a named, keyboard-safe surface rather than showing an undifferentiated wall of toggles.

Mobile: prioritize match/camera/playback, then a compact player/round/event region. TV: readable labels, focus-visible actions and directional navigation; do not depend on hover or tiny pointer targets. Low-power/2D remains a real selectable mode.

The Play/skip group stays centered on the viewport. Desktop decks shrink to leave a separate bottom-left input lane; phones prioritize centered Play, Speed and Replay tools. Players and round navigation remain in Replay tools where direct triggers are progressively omitted. Replay tools contains navigation/actions, notes and fullscreen, without duplicate speed, next-kill/death or display toggles. Display preferences live in Options. The round strip is controlled by a switch in Timeline options. Match/current-round timeline range stays directly in the transport row. Round controls remain available, with 44 px primary touch targets. Menus/selects support keyboard selection, typeahead, Escape and collision-aware scrolling; their portals stay inside native dialogs/fullscreen. Escape dismisses the top floating control before its underlying panel. Chunk failures preserve the timeline and expose retry while playback waits.

## Policy-aware calls to action

- Public + guest uploads enabled: upload without an account, private temporary ownership and clear expiry.
- Public + guest uploads disabled: sign-in upload action. Registrations policy independently controls account creation.
- Public + registrations off: existing members can sign in, and enabled guest uploads remain available without creating members. New social accounts remain blocked.
- Private: branded sign-in entry, with account creation only when registrations policy permits. Anonymous demo/assets remain gated and guest uploads are ineffective.
- Provider disabled/missing approval: explain on Connections/import help. Never promise automatic Steam demo access or unapproved FACEIT downloads.

## Localization and themes

English/French apply to public content, app navigation, viewer options/status/errors, authentication, admin and accessibility names. Locale controls date/number formatting and plural forms. User-entered names, actual map/weapon identifiers and protocol codes are not translated. Language and theme persist locally. All four EN/FR × light/dark variants must preserve hierarchy and reflow.

## Full-tab viewer and quieter workspace

Viewer routes use their own shell. The canvas fills the entire viewport beneath small floating identity and action groups, with a centered recorded score/clock strip. The duplicate local round label is omitted when that strip is shown. Tapping the scene fades the menus and player HUD together; camera drags, long presses and pinches never toggle them. Mouse movement and H/Tab recover controls on desktop. Optional automatic hiding occurs after three seconds of playback, with guards for dialogs, keyboard focus and gestures. Captions remain visible when chrome fades. Language/theme/account/demo actions move into Viewer menu. The in-view bottom dock contains play/seek/speed, round selection/jumps, overlays/panel entry points and browser fullscreen. The optional round rail starts collapsed at every size. Map loading covers the replay until the view has settled. Failed and unavailable assets restore the controls. Only one player/review side panel is open at a time; it scrolls internally and closes with Escape, restoring focus to its trigger. The collapsed deck has one 44 px time/event/scrub row and one 44 px transport row, totaling 100 px with padding (96 px short landscape). Advanced timeline filters and round navigation stay in Replay tools. Optional CT/T rosters split across both edges on wide/tall screens; narrow/short views use one right stack. A saved right-only layout remains available. Equipment and health/armor occupy separate rows. Options use a left-edge native modal on desktop and a bounded phone sheet, five horizontal keyboard tabs, one scrolling active panel and a reachable close/communications footer. No viewing control requires scrolling the document.

The member library is a single working list with a confirmed delete action on each owned demo. Upload opens a focused modal instead of occupying a permanent right-hand column. No community or sample CTA competes with the private list. Existing upload/auth return intent opens that dialog after authentication; dismissing it clears the transient upload query flag.

## Spectator overlays

The replay studio uses neutral graphite/paper planes and an inset playback deck. Desktop controls gain readable labels and spacing; phone controls remain progressive with 44 px primary targets. Short landscape moves timecodes into the transport row and captions beside optional inputs. The mouse keeps enough physical width for LMB/RMB instead of scaling its text down. Movement keys stay above modifiers, and phones omit the redundant input-player caption. Roster viewports end at measured complete-row boundaries; all players remain internally scrollable. Closing Options with Escape or its close button restores focus after native-dialog teardown.

Keep the camera center clear. CT/T banks split across both edges on wide/tall screens, with a right-only preference and combined compact fallback, without role banners; physical mouse/key actions occupy a small lower-corner instrument. There is no centered equipment toolbar or duplicate selected-player card. Viewer controls and data overlays share one palette per theme, with selection only as the roster row highlight. Options alone control equipment, input visibility and raw input details; no inline Lineups/input display or collapse controls remain. Enabled compact rosters scroll internally. Full inventory remains in Players. Inputs and mouse default off independently. Timeline options and phone round actions are progressive in Replay tools; metadata and native event glyphs stay near the seek line. Scene taps/H fade the whole interface with inert hidden controls and focus recovery, while playback idleness is optional. Practice communications offer a silent, clearly labeled synthetic subtitle example; real communication controls retain their availability/provenance.

Timeline event positions share the seek thumb axis. Dense markers expose named, exact events; they are never evenly spaced chips. Match and current-round ranges are explicit. Objective progress shows recorded actor/site/kit and server deadlines, with elapsed/unavailable fallback. Missing map status belongs in round context instead of a central banner. Neutral surfaces and spacing replace decorative frames; focus indicators and form affordances remain visible.

The latest broadcast refinement keeps only official side artwork and scores, with accessible side names and a clock centered on the viewport independently of score widths. During a bomb lifecycle, the score centre instead shows the native bomb/defuse emblem, recorded circular progress and countdown; a shared full-width caption retains actor/site/kit. It replaces the separate objective card. Scores can be disabled without losing the standalone objective instrument. The visual reference is the [BLAST broadcast defuse example](https://blast.tv/article/learn-how-to-play-cs2); source imagery is inspection-only and never shipped.

## Moment shortcuts and low quality

After a recorded throw or elimination involving the observed player, one compact optional toast offers the relevant recorded perspectives. Combat has distinct Killer POV / Victim POV actions; utility has Replay / Landing and small input marks when the exact event has evidence. Missing landing coordinates disable landing only. One newest enabled moment occupies the card; every recorded moment remains available in the Kills/Utility round list. The utility and combat prompt switches are independent.

Moment appearance must not resize the player banks. Desktop gives the prompt a bottom-right lane alongside the deck and keeps the bottom-left lane for inputs; the centered deck clears both player columns. Compact layouts reserve a stable prompt lane from the enabled preferences, never the current event's height. Player rows remain internally scrollable without dropping identities.

Replays select the corresponding immutable player and POV, rewind, and continue normally at the current speed. Landing jumps near the recorded detonation in the ordinary free camera; it may be an airborne flash, not simulated ground contact. 2D remains 2D. There is no temporary clip, end stop or return button. Network input snapshots are identified as such and never claim physical key bindings or a verified launch command. Inputs remain a compact ZQSD/WASD block with modifiers beneath and an independently optional mouse alongside.

The centered score strip opens the native scoreboard, also available in Replay tools and by holding plain Tab outside typing, menus and dialogs when replay data is ready. Keyup/Escape/blur dismiss safely. Shift+Tab preserves backward navigation. Native counters supply current match totals, including those before the recording began; missing fields show a dash. Compact stats keep readable columns in a horizontal viewport with sticky player/header cells and a scrolling hint. A requested compact Kills/Utility panel replaces background instruments while open, exposes complete touch-sized actions and restores them/focus on Close. Desktop review stays inline. Quality choices preserve recorded projectiles independently of paths and analytical zones.

## Latest review refinements

Player selection switches to POV and briefly emphasizes the top-right camera control, respecting reduced motion. Free camera accepts WASD and ZQSD plus E/C vertical movement, with typing/dialog guards and cleared held input after focus changes. Phone preferences do not inherit desktop overlay opt-ins. Inputs/mouse and the full Kills/Utility panel default off on mobile, while compact recorded death recaps remain enabled.

Crosshair options choose your device-local custom shape or supported recorded static geometry from the current player's controller share code. Missing/invalid/unsupported evidence remains unavailable. Native dynamic spread/recoil/scope rendering is not claimed.

Destructive or sharing confirmation uses the reusable native modal with a safe Cancel focus target, named heading/body, fullscreen support and route/unmount cancellation. Late mutation responses cannot overwrite a new demo. Global scrollbars are quiet, button presses do not shift geometry, and restrained keyboard focus outlines remain visible. UI copy avoids em dashes and semicolons.
