import type { Frame, GameEvent, Playback, Position } from './types';
import { frameAt, poseTimingAt } from './playback';
import { eventPlayer } from './review-events';
import { playerPose, shortestAngle } from './player-pose';
import { firstPersonView, recordedEyePosition } from './pov-camera';

type ParticipantEvents = Map<string, GameEvent[]>;
type SpectatorEvents = {
  damage: ParticipantEvents;
  deaths: ParticipantEvents;
  killfeed: GameEvent[];
};
export function indexSpectatorEvents(data: Playback): SpectatorEvents {
  const index: SpectatorEvents = { damage: new Map(), deaths: new Map(), killfeed: [] };
  for (const event of data.events) {
    if (!Number.isSafeInteger(event.tick)) continue;
    if (event.type === 'player_death') index.killfeed.push(event);
    const destination =
      event.type === 'player_hurt'
        ? index.damage
        : event.type === 'player_death'
          ? index.deaths
          : undefined;
    if (!destination || (destination === index.damage && recordedAmount(event) === undefined))
      continue;
    const player = eventPlayer(data, event, 'user');
    if (!player) continue;
    const events = destination.get(player.id) || [];
    events.push(event);
    destination.set(player.id, events);
  }
  for (const events of [index.killfeed, ...index.damage.values(), ...index.deaths.values()])
    events.sort((a, b) => a.tick - b.tick);
  return index;
}
function preceding(events: GameEvent[], tick: number) {
  let low = 0,
    high = events.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (events[middle].tick <= tick) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}
/** Most recent four eliminations, including world kills with an unidentified victim. */
export function killfeedAt(index: SpectatorEvents, tick: number, rate: number) {
  const events = index.killfeed;
  const end = preceding(events, tick) + 1;
  let start = end;
  while (start > 0 && end - start < 4 && events[start - 1].tick > tick - rate * 6) start--;
  return events.slice(start, end);
}
function at(data: Playback, id: string, tick: number) {
  if (!data.frames.length || tick < data.frames[0].tick || tick > data.frames.at(-1)!.tick) return;
  const span = frameAt(data, tick);
  const player = span.frame.players.find((value) => value.id === id);
  if (!player) return;
  return playerPose(
    player,
    span.next.players.find((value) => value.id === id),
    span.alpha,
    poseTimingAt(data, span, id),
  );
}
function recordedAmount(event: GameEvent) {
  const damage = (value: unknown) =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000
      ? value
      : undefined;
  const health = damage(event.dmg_health),
    armor = damage(event.dmg_armor);
  return health === undefined && armor === undefined ? undefined : (health ?? 0) + (armor ?? 0);
}
export type DamageFeedbackState = { opacity: number; direction?: number };

export function watchedDeath(
  data: Playback,
  deaths: GameEvent[] | undefined,
  selected: string,
  tick: number,
  seconds: number,
  frame?: Frame,
) {
  if (!deaths?.length || !data.frames.length || !(data.tickRate > 0)) return;
  const death = deaths[preceding(deaths, tick)];
  if (!death || tick - death.tick >= data.tickRate * seconds) return;
  const current = frame ?? frameAt(data, tick).frame;
  if (current.tick > death.tick && current.players.some((p) => p.id === selected && p.alive))
    return;
  if (data.rounds.some((r) => r.tick > death.tick && r.tick <= tick)) return;
  return death;
}

/** Anchor the spectator turn to both players at the elimination, even if the
 * attacker moves or the victim's pawn vanishes before the next camera frame. */
export function deathCameraEvidence(data: Playback, death: GameEvent, selected: string) {
  const attacker = eventPlayer(data, death, 'attacker');
  if (!attacker || attacker.id === selected || death.noreplay === true) return;
  if (
    !data.frames.length ||
    death.tick < data.frames[0].tick ||
    death.tick > data.frames.at(-1)!.tick
  )
    return;
  const { frame, previous } = frameAt(data, death.tick);
  const recent = (sample: Frame) =>
    death.tick - sample.tick <= data.tickRate * 0.25 &&
    !data.rounds.some((r) => r.tick > sample.tick && r.tick <= death.tick);
  if (!recent(frame)) return;
  const killer = at(data, attacker.id, death.tick);
  let victim = at(data, selected, death.tick);
  if (!victim?.alive && previous && recent(previous))
    victim = previous.players.find((p) => p.id === selected);
  if (!killer?.alive || !victim?.alive) return;
  const eye = recordedEyePosition(victim),
    target = recordedEyePosition(killer);
  const dx = target[0] - eye[0],
    dy = target[1] - eye[1],
    dz = target[2] - eye[2];
  if (Math.hypot(dx, dy, dz) < 0.0254) return;
  return {
    victim,
    yaw: (Math.atan2(-dz, dx) * 180) / Math.PI,
    pitch: (-Math.atan2(dy, Math.hypot(dx, dz)) * 180) / Math.PI,
  };
}

export function deathCameraView(
  evidence: NonNullable<ReturnType<typeof deathCameraEvidence>>,
  ageSeconds: number,
  reducedMotion: boolean,
) {
  const t = reducedMotion ? 0 : Math.min(1, Math.max(0, ageSeconds / 0.45));
  const blend = t * t * (3 - 2 * t);
  return firstPersonView({
    ...evidence.victim,
    yaw: evidence.victim.yaw + shortestAngle(evidence.victim.yaw, evidence.yaw) * blend,
    pitch: evidence.victim.pitch + (evidence.pitch - evidence.victim.pitch) * blend,
  });
}

/** A deliberately approximate spectator cue derived from recorded damage and deaths. Demo-time decay makes pause, speed and backward seek deterministic. */
export function damageFeedbackAt(
  data: Playback,
  timeline: SpectatorEvents,
  selected: string,
  tick: number,
): DamageFeedbackState | undefined {
  const fatalSeconds = 1.15;
  const death = watchedDeath(data, timeline.deaths.get(selected), selected, tick, fatalSeconds);
  if (death) return { opacity: 0.96 * (1 - (tick - death.tick) / (data.tickRate * fatalSeconds)) };
  const events = timeline.damage.get(selected);
  if (!events || !Number.isFinite(data.tickRate) || data.tickRate <= 0) return;
  const current = preceding(events, tick);
  if (current < 0) return;
  const duration = data.tickRate * 0.65;
  const mergeWindow = data.tickRate * 0.34;
  const newest = events[current];
  const next = events[current + 1];
  const age = tick - newest.tick;
  if (age >= duration) return;
  // Keep closely spaced hits lit as one burst, then release from the last hit.
  const decay = next && next.tick - newest.tick <= mergeWindow ? 1 : 1 - age / duration;
  let peak = 0,
    direction: number | undefined;
  for (let index = current; index >= 0 && current - index < 8; index--) {
    const event = events[index];
    if (index < current && events[index + 1].tick - event.tick > mergeWindow) break;
    peak = Math.min(0.96, peak + Math.min(0.94, 0.64 + (recordedAmount(event) ?? 0) / 270));
    if (direction !== undefined || tick - event.tick >= duration) continue;
    const attacker = eventPlayer(data, event, 'attacker');
    if (!attacker || attacker.id === selected) continue;
    const origin = at(data, attacker.id, event.tick),
      victim = at(data, selected, event.tick);
    if (!origin || !victim) continue;
    const x = origin.x - victim.x,
      y = origin.y - victim.y;
    if (!Number.isFinite(x) || !Number.isFinite(y) || x * x + y * y < 1) continue;
    // Source yaw is counterclockwise; CSS/SVG rotation is clockwise.
    const facing = at(data, selected, tick)?.yaw ?? victim.yaw;
    direction = -((((Math.atan2(y, x) * 180) / Math.PI - facing + 540) % 360) - 180);
  }
  return { opacity: peak * decay, direction };
}

type FollowObservation = {
  identity: string;
  selected: string;
  mode: string;
  tick: number;
  playing: boolean;
  enabled: boolean;
  buffering?: boolean;
};
/** No wall-clock timers: manual transport/camera actions reset this controller,
 * and only a death actually crossed in continuous forward playback arms it. */
export class DeathFollowController {
  private previous?: FollowObservation;
  private death?: GameEvent;
  private lastVictim?: Position;
  reset() {
    this.previous = undefined;
    this.death = undefined;
    this.lastVictim = undefined;
  }
  advance(data: Playback, timeline: SpectatorEvents, observation: FollowObservation) {
    const previous = this.previous;
    // Automatic chunk stalls freeze demo time without discarding a death that
    // was already watched. Explicit pause/selection/identity changes still cancel.
    if (observation.buffering && observation.playing && observation.enabled) {
      if (
        previous?.identity !== observation.identity ||
        previous.selected !== observation.selected ||
        previous.mode !== observation.mode
      )
        this.reset();
      return;
    }
    this.previous = observation;
    const { selected, tick, mode, playing, enabled, identity } = observation;
    const frame = data.frames.length ? frameAt(data, tick).frame : undefined;
    const victim = frame?.players.find((player) => player.id === selected);
    if (
      !enabled ||
      !playing ||
      !['pov', 'follow'].includes(mode) ||
      !previous?.playing ||
      previous.identity !== identity ||
      previous.selected !== selected ||
      previous.mode !== mode ||
      tick < previous.tick ||
      !data.frames.length
    ) {
      this.death = undefined;
      this.lastVictim = victim;
      return;
    }
    const deaths = timeline.deaths.get(selected) || [];
    const latest = deaths[preceding(deaths, tick)];
    if (latest && latest.tick > previous.tick) this.death = latest;
    if (victim && (victim.alive || !this.lastVictim)) this.lastVictim = victim;
    if (victim?.alive) {
      // A death can occur between recorded position samples. The pre-death
      // sample's alive flag must not erase that event before the next sample.
      if (this.death && frame!.tick > this.death.tick) {
        this.death = undefined;
        this.lastVictim = undefined;
      }
      return;
    }
    if (!this.death || tick - this.death.tick < data.tickRate * 3) return;
    const observedVictim = this.lastVictim || victim;
    const alive = frame!.players.filter((player) => player.id !== selected && player.alive);
    if (!alive.length) return;
    const distance = (player: Position) =>
      observedVictim
        ? (player.x - observedVictim.x) ** 2 +
          (player.y - observedVictim.y) ** 2 +
          (player.z - observedVictim.z) ** 2
        : 0;
    alive.sort((a, b) => distance(a) - distance(b) || a.id.localeCompare(b.id));
    const killer = eventPlayer(data, this.death, 'attacker');
    const next =
      alive.find((player) => observedVictim && player.team === observedVictim.team) ||
      alive.find((player) => player.id === killer?.id) ||
      alive[0];
    this.reset();
    return next.id;
  }
}
