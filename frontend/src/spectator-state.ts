import type { GameEvent, Playback, Position } from './types';
import { frameAt } from './playback';
import { eventPlayer } from './review-events';
import { playerPose } from './player-pose';

type ParticipantEvents = Map<string, GameEvent[]>;
export type SpectatorEvents = { damage: ParticipantEvents; deaths: ParticipantEvents };
export function indexSpectatorEvents(data: Playback): SpectatorEvents {
  const index: SpectatorEvents = { damage: new Map(), deaths: new Map() };
  for (const event of data.events) {
    if (!Number.isSafeInteger(event.tick)) continue;
    const destination =
      event.type === 'player_hurt'
        ? index.damage
        : event.type === 'player_death'
          ? index.deaths
          : undefined;
    if (!destination) continue;
    const player = eventPlayer(data, event, 'user');
    if (!player) continue;
    const events = destination.get(player.id) || [];
    events.push(event);
    destination.set(player.id, events);
  }
  for (const events of [...index.damage.values(), ...index.deaths.values()])
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
function at(data: Playback, id: string, tick: number) {
  if (!data.frames.length || tick < data.frames[0].tick || tick > data.frames.at(-1)!.tick) return;
  const { frame, next, alpha } = frameAt(data, tick);
  const player = frame.players.find((value) => value.id === id);
  if (!player) return;
  return playerPose(
    player,
    next.players.find((value) => value.id === id),
    alpha,
    {
      fromTick: frame.tick,
      nextTick: next.tick,
      tickRate: data.tickRate,
      roundBoundary: data.rounds.some(
        (round) => round.tick > frame.tick && round.tick <= next.tick,
      ),
    },
  );
}
const recordedDamage = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 1_000_000
    ? value
    : 0;
export type DamageFeedbackState = { opacity: number; direction?: number };

/** A deliberately approximate spectator cue derived only from recorded hurt
 * events. Demo-time decay makes pause, speed and backward seek deterministic. */
export function damageFeedbackAt(
  data: Playback,
  timeline: SpectatorEvents,
  selected: string,
  tick: number,
): DamageFeedbackState | undefined {
  const events = timeline.damage.get(selected);
  if (!events || !Number.isFinite(data.tickRate) || data.tickRate <= 0) return;
  const duration = data.tickRate * 0.65;
  let opacity = 0,
    direction: number | undefined;
  // A bounded number of simultaneous hits can strengthen the cue, not add
  // flashing animations or allocate an effect for every event in the match.
  for (let index = preceding(events, tick), read = 0; index >= 0 && read++ < 8; index--) {
    const event = events[index];
    const age = tick - event.tick;
    if (age >= duration) break;
    const amount = recordedDamage(event.dmg_health) + recordedDamage(event.dmg_armor);
    if (!amount) continue;
    const decay = 1 - age / duration;
    opacity = Math.min(0.7, opacity + Math.min(0.55, 0.24 + amount / 280) * decay * decay);
    if (direction !== undefined) continue;
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
  return opacity > 0 ? { opacity, direction } : undefined;
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
