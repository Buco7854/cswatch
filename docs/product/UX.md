# Journeys and access contract

## Route families

| Route                  | Public guest                                         | Signed-in member                          | Private-instance guest                 |
| ---------------------- | ---------------------------------------------------- | ----------------------------------------- | -------------------------------------- |
| `/`                    | Public product landing                               | Landing with Open workspace CTA           | Branded private-instance sign-in entry |
| `/features/viewer`     | Viewer feature page + real sample link               | Same plus library/upload shortcut         | Sign-in gate                           |
| `/features/imports`    | Accurate upload/Steam/FACEIT explanation             | Same plus connections/import shortcut     | Sign-in gate                           |
| `/self-host`           | Hosting/control page with real docs/repository links | Same                                      | Sign-in gate                           |
| `/explore`             | Explicitly shared demos only                         | Same, with ownership-aware actions        | Sign-in gate                           |
| `/watch/sample`        | Synthetic practice demo, no account needed           | Same; sample notes remain local/temporary | Sign-in gate                           |
| `/watch/:id`           | Public demo only, otherwise indistinguishable 404    | Public or own demo                        | Sign-in gate                           |
| `/library`             | Explain account requirement, sign-in returns here    | Own demos, upload, status, recovery       | Sign-in gate                           |
| `/connections`         | Sign-in with return intent                           | Verified links/history/imports            | Sign-in gate                           |
| `/account/connections` | Sign-in with return intent                           | Canonical connected-services account tab  | Sign-in gate                           |
| `/account`             | Sign-in with return intent                           | Own identity/password                     | Sign-in gate                           |
| `/admin`               | Sign-in then enforce role                            | Admin only; members see forbidden state   | Sign-in gate then role check           |

Private mode must protect APIs and game assets independently of SPA navigation. It may serve the generic frontend shell for routes so users receive a useful gate; it must not fetch or show gated content before authentication. Public registration is independent: private + registrations enabled permits account creation; private + registrations disabled offers sign-in and operator contact guidance only.

## Navigation

Public shell: cswatch wordmark/home, Viewer, Imports, Self-host, Explore (public only), language/theme, Sign in or Open workspace. No personal-library sidebar for an anonymous marketing visitor. No disabled provider badges in the hero.

Member shell: brand, Demo library, Explore/Shared demos. Account settings, Connections and Administration belong in the user dropdown; account security/connected services are tabs in Account. `/connections` preserves old links by redirecting to `/account/connections`. Mobile navigation opens a bounded named sheet. Viewer has its own whole-tab shell, a clear back destination and a compact user menu.

The public site remains accessible to members when the instance is public. Do not forcibly redirect every signed-in visit to `/`; the Open workspace action is explicit. Brand in the workspace links to the library; a secondary public-site link leads back to `/`.

## Intent-preserving authentication

An account-required action records a **safe local return path** and, where relevant, an action intent (upload/import/notes). Authentication success returns to the intended route and exposes that action. Steam callback returns through a local completion route/state, not a user-controlled external URL. Never lose a selected file silently: explain if a file must be selected again after an external redirect. Keep registration-disabled and provider-disabled states consistent at entry and submit time.

## First-use member journey

Library opens with a real empty state and an obvious import action. Upload accepts drag/drop and file selection, states size/formats, and explains privacy. Submission goes to the queued/processing object with a return-to-library option. Ready demos open in the viewer. Failed demos show a useful explanation and deletion/retry path. Sample content lives in a separate practice entry, never as fabricated personal history.

## Guest viewer journey

A public demo opens without forcing account creation. Read-only review controls work. Saving a personal note explains the account requirement and offers sign-in at that moment. Public/private visibility is clear; only owners can change it or delete/rename. A public viewer does not expose private notes or download URLs for originals.

## Viewer hierarchy

When the interface is visible: play/pause, scrub time, speed, round selection, camera/player selection, current context and fullscreen. Secondary: next round, skip dead time, event jumps, notes. Advanced options: x-ray shapes, crosshair, radar, elimination feed, trails, grenade paths, utility approximations, quality. Open these in a named, keyboard-safe surface rather than showing an undifferentiated wall of toggles.

Mobile: prioritize match/camera/playback, then a compact player/round/event region. TV: readable labels, focus-visible actions and directional navigation; do not depend on hover or tiny pointer targets. Low-power/2D remains a real selectable mode.

At phone widths and short landscape, the visible transport row prioritizes Play/Speed and Players/Review/More. More controls contains rewind/forward, note, fullscreen and advanced moment jumps. Round controls remain available, with 44 px primary touch targets. Menus/selects support keyboard selection, typeahead, Escape and collision-aware scrolling; their portals stay inside native dialogs/fullscreen. Escape dismisses the top floating control before its underlying panel. Chunk failures preserve the timeline and expose retry while playback waits.

## Policy-aware calls to action

- Public + registrations on: Try viewer is account-free; Upload routes through account creation/sign-in; Sign in always available.
- Public + registrations off: guest sample/explore remain available; account actions say Sign in, not Create account. Existing Steam-linked accounts can authenticate if Steam is enabled; new social account creation stays blocked.
- Private + registrations on: branded gate says this is a private instance and permits sign-in/create account under its explicit policy.
- Private + registrations off: branded sign-in only; no sample, explore, asset previews, or signup loophole.
- Provider disabled/missing approval: explain in Connections/import page; never promise automatic Steam demo access or FACEIT downloads without approval.

## Localization and themes

English/French apply to public content, app navigation, viewer options/status/errors, authentication, admin and accessibility names. Locale controls date/number formatting and plural forms. User-entered names, actual map/weapon identifiers and protocol codes are not translated. Language and theme persist locally. All four EN/FR × light/dark variants must preserve hierarchy and reflow.

## Full-tab viewer and quieter workspace

Viewer routes use their own shell. The canvas fills the entire viewport beneath a single 48 px overlay toolbar. Tapping the scene fades the menus and player HUD together; camera drags, long presses and pinches never toggle them. Mouse movement and H/Tab recover controls on desktop. Optional automatic hiding occurs after three seconds of playback, with guards for dialogs, keyboard focus and gestures. Captions remain visible when chrome fades. Language/theme/account/demo actions move into Viewer menu. The in-view bottom dock contains play/seek/speed, round selection/jumps, overlays/panel entry points and browser fullscreen. The optional round rail starts collapsed at every size. Only one player/review side panel is open at a time; it scrolls internally and closes with Escape, restoring focus to its trigger. Options remain a named modal with bounded vertical scrolling. No viewing control requires scrolling the document.

The member library is a single working list. Upload opens a focused modal instead of occupying a permanent right-hand column. A compact practice link replaces the repeated scene preview and feature checklist. Existing upload/auth return intent opens that dialog after authentication; dismissing it clears the transient upload query flag.

## Spectator overlays

The replay studio uses neutral graphite/paper planes and an inset playback deck. Desktop controls gain readable labels and spacing; phone controls remain progressive with 44 px primary targets. Short landscape moves timecodes into the transport row and captions beside optional inputs. The mouse keeps enough physical width for LMB/RMB instead of scaling its text down. Movement keys stay above modifiers, and phones omit the redundant input-player caption. Roster viewports end at measured complete-row boundaries; all players remain internally scrollable. Closing Options with Escape or its close button restores focus after native-dialog teardown.

Keep the camera center clear. A compact CT/T roster sits on the right without role banners; physical mouse/key actions occupy a small lower-corner instrument. There is no centered equipment toolbar or duplicate selected-player card. Viewer controls and data overlays share one palette per theme, with selection only as the roster row highlight. Options alone control equipment, input visibility and raw input details; no inline Lineups/input display or collapse controls remain. Enabled compact rosters scroll internally. Full inventory remains in Players. Inputs and mouse default off independently. Timeline options and phone round actions are progressive in More; metadata and native event glyphs stay near the seek line. Scene taps/H fade the whole interface with inert hidden controls and focus recovery, while playback idleness is optional. Practice communications offer a silent, clearly labeled synthetic subtitle example; real communication controls retain their availability/provenance.

Timeline event positions share the seek thumb axis. Dense markers expose named, exact events; they are never evenly spaced chips. Match and current-round ranges are explicit. Objective progress shows recorded actor/site/kit and server deadlines, with elapsed/unavailable fallback. Missing map status belongs in round context instead of a central banner. Neutral surfaces and spacing replace decorative frames; focus indicators and form affordances remain visible.

## Moment shortcuts and low quality

After a recorded throw or observed-player kill, small optional edge actions offer View grenade landing / Replay kill. They remain reachable while viewing chrome is hidden and reserve space above captions and away from inputs/rosters. Each suggestion is independently disabled in Options. Landing means the recorded detonation point, including an airborne flash; it does not imply simulated ground contact. Ambiguous or absent identities/positions produce no invented action.

Replay is an ordinary seek back with the current camera and speed. Grenade viewing seeks back and changes the ordinary free-camera target to the recorded detonation. Both continue normal playback; no temporary clip, saved return state or back button exists. Users in 2D keep 2D. Group the actions in one compact filled card with native icons and touch-sized rows. Quality choices affect visual cost while preserving recorded projectiles; flight-path lines and analytical utility zones are separate choices. The compact input display puts Shift/Ctrl/Space/E/R below ZQSD/WASD and the optional mouse beside it.
