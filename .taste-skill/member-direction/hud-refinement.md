# Viewer instrument refinement

Continue True-black flat, seed 1155974105; no redraw. The approved typography, neutral palette and public landing stay in place. The user's correction is structural: physical input visualization, time-positioned events, broadcast equipment and live objective context, and fewer enclosing lines.

The viewer's question is: what did this player do, with what equipment, at this exact moment?

- A match has two teams, normally five players each, whose live affiliation can change at halftime.
- Player identity uses immutable strings; names may be duplicated or long.
- HP, armor, money, weapon and ammo come from the sampled replay frame.
- Inventory can contain two flashbangs; unavailable inventory differs from an empty one.
- Input masks record game actions rather than the physical keyboard layout.
- Mouse buttons have distinct recorded primary/secondary attacks; delta counts can be unavailable.
- Kills, deaths, utility releases and objectives retain their exact recorded ticks.
- Long matches need event clustering; a cluster represents a range/list, never an invented event time.
- Native game review supplies a whole-match timeline and round zoom; esports supplies live side lineups and objective status.
- Small screens progressively choose an overlay; desktop can show independent overlays together.

The signature element is the recorded event stem ending on the shared playback axis. The keyboard/mouse silhouette and live team banks carry the game's objects as themselves. Team hue encodes actual team data. Neutral planes and spacing replace nested outer borders; keyboard focus and form affordances remain explicit.

Verification must cover both themes and languages, match/round axes, exact cluster seeking, recorded zero/unknown states, input buttons, live equipment updates, objective cancellation and arbitrary seeks. Inspect production screenshots at desktop/tablet/phone; record actual findings after the look-and-fix loop.

## Rendered critique and evidence

The first HUD composition was rejected for using the middle of the camera. The final composition removes the floating equipment toolbar and centers the mouse only inside its small edge instrument. Desktop banks share their top edge; the left bank reserves the measured input height. Phone equipment starts with one compact player card and expands only by request. At 320 px the input ends at x158 and the equipment starts at x166, preserving the center gap. Missing-map status is round context, not a floating central banner. The optional round strip starts closed at every size.

Actual CS2 weapon/utility/knife/kit PNGs were installed only in ignored local QA data. Production screenshots in `.design/final-hud/` show the real masks in both themes, including distinct AK/AWP silhouettes, actor/kit/fuse state and the physical input visual. Other fixtures are explicitly labeled, never personal history. Source/output provenance remains beside the local pack; no game art belongs in Git/images.

All 312 member screen/state checks passed for EN/FR and both themes at desktop/tablet/phone/landscape widths. The app inspector `.taste-skill/hud-inspect/` reported zero failures and one compact-text warning; all six fold/page captures were opened. The warning is accepted for spectator timecodes, axes and compact noninteractive metadata; working menus use larger labels and touch controls keep their required targets. This is rendered verification, not user design approval or physical-device certification.
