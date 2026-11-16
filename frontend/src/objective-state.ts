import type { GameEvent, Playback } from './types';
import type { ObjectiveSample } from '../../shared/objectives';

type Actor = { actor?: string; name?: string };
type Action = Actor & {
  start: number;
  end?: number;
  duration?: number;
  kit?: boolean;
  entity?: string;
};
type Bomb = { start?: number; end?: number; duration?: number; site?: 0 | 1; entity?: string };
type ObjectiveState = {
  tick: number;
  phase: 'idle' | 'planting' | 'planted' | 'defusing' | 'defused' | 'exploded';
  action?: Action;
  bomb?: Bomb;
  actor?: Actor;
  notice?: Actor & { kind: 'plant-aborted' | 'defuse-aborted'; tick: number };
};
export type ObjectiveTimeline = {
  tickRate: number;
  states: ObjectiveState[];
  complete: boolean;
  lastSampleTick: number;
};
export type ObjectiveMeter = { remaining?: number; elapsed?: number; progress?: number };
export type ObjectiveView = {
  phase: Exclude<ObjectiveState['phase'], 'idle'> | 'plant-aborted' | 'defuse-aborted';
  actor?: string;
  name?: string;
  site?: 0 | 1;
  kit?: boolean;
  meter: ObjectiveMeter;
  fuse?: ObjectiveMeter;
};

const actor = (event: GameEvent): Actor => ({
  actor:
    typeof event.user_steamid === 'string' && event.user_steamid !== '0'
      ? event.user_steamid
      : undefined,
  name: typeof event.user_name === 'string' ? event.user_name : undefined,
});
const kit = (event: GameEvent) =>
  typeof event.haskit === 'boolean'
    ? event.haskit
    : typeof event.user_has_defuser === 'boolean'
      ? event.user_has_defuser
      : undefined;
const lifecycle = new Set([
  'bomb_beginplant',
  'bomb_abortplant',
  'bomb_planted',
  'bomb_begindefuse',
  'bomb_abortdefuse',
  'bomb_defused',
  'bomb_exploded',
  'round_start',
  'player_death',
]);

/** Compile global recorded metadata once. Frames/chunks are deliberately not consulted.
 * Each query below is independent, so seeking backwards cannot retain future state. */
export function buildObjectiveTimeline(
  data: Pick<Playback, 'events' | 'objectives' | 'rounds' | 'players' | 'tickRate'>,
): ObjectiveTimeline {
  type Entry = {
    tick: number;
    priority: number;
    sample?: ObjectiveSample;
    event?: GameEvent;
    reset?: boolean;
  };
  const entries: Entry[] = data.rounds.map((round) => ({
    tick: round.tick,
    priority: 0,
    reset: true,
  }));
  for (const sample of data.objectives?.samples || [])
    entries.push({ tick: sample.tick, priority: 1, sample });
  for (const event of data.events) {
    if (!lifecycle.has(event.type)) continue;
    const priority =
      event.type === 'round_start'
        ? 0
        : ['bomb_planted', 'bomb_defused', 'bomb_exploded'].includes(event.type)
          ? 4
          : ['player_death', 'bomb_abortplant', 'bomb_abortdefuse'].includes(event.type)
            ? 3
            : 2;
    entries.push({ tick: event.tick, priority, event });
  }
  entries.sort((a, b) => a.tick - b.tick || a.priority - b.priority);
  const names = new Map(data.players.map((player) => [player.id, player.name]));
  const previous = new Map<string, ObjectiveSample>();
  const states: ObjectiveState[] = [];
  let state: ObjectiveState = { tick: 0, phase: 'idle' };
  const abort = (kind: 'plant-aborted' | 'defuse-aborted', tick: number) => {
    state = {
      ...state,
      phase: kind === 'plant-aborted' ? 'idle' : 'planted',
      action: undefined,
      notice: { kind, tick, actor: state.action?.actor, name: state.action?.name },
    };
  };
  const terminal = (phase: 'defused' | 'exploded', who?: Actor) => {
    state = { ...state, phase, action: undefined, notice: undefined, actor: who };
  };
  for (const entry of entries) {
    const { tick, sample, event } = entry;
    if (entry.reset || event?.type === 'round_start') {
      state = { tick, phase: 'idle' };
    } else if (sample) {
      const before = previous.get(sample.entity);
      previous.set(sample.entity, sample);
      if (sample.kind === 'plant') {
        const started =
          sample.present &&
          sample.arming === true &&
          (before?.kind !== 'plant' ||
            !before.present ||
            before.arming !== true ||
            sample.actor !== before.actor);
        if (started && state.phase !== 'planted' && state.phase !== 'defusing') {
          state = {
            tick,
            phase: 'planting',
            action: {
              start: tick,
              end: sample.endTick,
              actor: sample.actor,
              name: sample.actor ? names.get(sample.actor) : undefined,
              entity: sample.entity,
            },
          };
        } else if (state.phase === 'planting' && state.action?.entity === sample.entity) {
          if (!sample.present || sample.arming === false) abort('plant-aborted', tick);
          else
            state = {
              ...state,
              action: {
                ...state.action,
                end: sample.endTick ?? state.action.end,
                actor: sample.actor ?? state.action.actor,
              },
            };
        }
      } else if (!sample.present) {
        // Entity disappearance is not proof of an explosion or defuse.
        if (state.bomb?.entity === sample.entity)
          state = {
            ...state,
            bomb: { start: state.bomb.start },
            action:
              state.phase === 'defusing'
                ? { ...state.action!, end: undefined, duration: undefined }
                : state.action,
          };
      } else if (
        sample.defused &&
        (state.bomb?.entity === sample.entity || before?.kind !== 'bomb' || !before.defused)
      )
        terminal(
          'defused',
          sample.actor ? { actor: sample.actor, name: names.get(sample.actor) } : state.actor,
        );
      else if (
        sample.exploded &&
        (state.bomb?.entity === sample.entity || before?.kind !== 'bomb' || !before.exploded)
      )
        terminal('exploded');
      else if (
        (state.phase !== 'defused' && state.phase !== 'exploded') ||
        (sample.ticking && sample.entity !== state.bomb?.entity && !before?.present)
      ) {
        const sameBomb =
          state.bomb !== undefined &&
          (state.bomb.entity === undefined || state.bomb.entity === sample.entity);
        const previousBomb = sameBomb ? state.bomb : undefined;
        const bomb: Bomb = {
          ...previousBomb,
          entity: sample.entity,
          end: sample.endTick ?? previousBomb?.end,
          duration: sample.duration ?? previousBomb?.duration,
          site: sample.site ?? previousBomb?.site,
        };
        if (bomb.end !== undefined && bomb.duration !== undefined)
          bomb.start = bomb.end - bomb.duration * data.tickRate;
        const old = before?.kind === 'bomb' ? before : undefined;
        const startedBomb = sample.ticking && (!old?.present || !old.ticking);
        if (
          startedBomb ||
          (sample.beingDefused && (!old?.present || !old.beingDefused)) ||
          state.bomb?.entity === sample.entity
        ) {
          state = {
            ...state,
            phase: sameBomb && state.phase === 'defusing' ? 'defusing' : 'planted',
            action: sameBomb && state.phase === 'defusing' ? state.action : undefined,
            actor: sameBomb
              ? state.actor
              : state.phase === 'planting'
                ? { actor: state.action?.actor, name: state.action?.name }
                : undefined,
            notice: startedBomb ? undefined : state.notice,
            bomb,
          };
          const started =
            sample.beingDefused &&
            (!old?.present || !old.beingDefused || sample.actor !== old.actor);
          if (started) {
            const start =
              sample.defuseEndTick !== undefined && sample.defuseDuration !== undefined
                ? sample.defuseEndTick - sample.defuseDuration * data.tickRate
                : tick;
            state = {
              ...state,
              phase: 'defusing',
              action: {
                start,
                end: sample.defuseEndTick,
                duration: sample.defuseDuration,
                actor: sample.actor,
                name: sample.actor ? names.get(sample.actor) : undefined,
                entity: sample.entity,
              },
              notice: undefined,
            };
          } else if (state.phase === 'defusing') {
            if (sample.beingDefused === false) abort('defuse-aborted', tick);
            else
              state = {
                ...state,
                action: {
                  ...state.action!,
                  end: sample.defuseEndTick ?? state.action?.end,
                  duration: sample.defuseDuration ?? state.action?.duration,
                  actor: sample.actor ?? state.action?.actor,
                },
              };
          }
        }
      }
    } else if (event) {
      if (event.type === 'bomb_beginplant') {
        const same =
          state.phase === 'planting' &&
          (!state.action?.actor || state.action.actor === event.user_steamid);
        state = {
          tick,
          phase: 'planting',
          action: { ...(same ? state.action : {}), ...actor(event), start: tick },
          notice: undefined,
        };
      } else if (
        event.type === 'bomb_abortplant' &&
        state.phase === 'planting' &&
        (!event.user_steamid || !state.action?.actor || event.user_steamid === state.action.actor)
      )
        abort('plant-aborted', tick);
      else if (event.type === 'bomb_planted') {
        state = {
          tick,
          phase: 'planted',
          bomb: { ...state.bomb, start: state.bomb?.start ?? tick },
          actor: actor(event),
        };
      } else if (event.type === 'bomb_begindefuse') {
        const same =
          state.phase === 'defusing' &&
          (!state.action?.actor || state.action.actor === event.user_steamid);
        state = {
          ...state,
          phase: 'defusing',
          bomb: state.bomb || {},
          action: { ...(same ? state.action : {}), ...actor(event), start: tick, kit: kit(event) },
          notice: undefined,
        };
      } else if (
        event.type === 'bomb_abortdefuse' &&
        state.phase === 'defusing' &&
        (!event.user_steamid || !state.action?.actor || event.user_steamid === state.action.actor)
      )
        abort('defuse-aborted', tick);
      else if (event.type === 'bomb_defused') terminal('defused', actor(event));
      else if (event.type === 'bomb_exploded') terminal('exploded');
      else if (
        event.type === 'player_death' &&
        state.action?.actor &&
        event.user_steamid === state.action.actor
      ) {
        if (state.phase === 'planting') abort('plant-aborted', tick);
        if (state.phase === 'defusing') abort('defuse-aborted', tick);
      }
    }
    state = { ...state, tick };
    states.push(state);
  }
  return {
    tickRate: data.tickRate,
    states,
    complete: data.objectives?.complete ?? true,
    lastSampleTick: data.objectives?.samples.at(-1)?.tick ?? -1,
  };
}

function meter(
  start: number | undefined,
  end: number | undefined,
  tick: number,
  rate: number,
): ObjectiveMeter {
  const result: ObjectiveMeter = {};
  if (start !== undefined) result.elapsed = Math.max(0, (tick - start) / rate);
  if (end !== undefined) result.remaining = Math.max(0, (end - tick) / rate);
  if (start !== undefined && end !== undefined && end > start)
    result.progress = Math.max(0, Math.min(1, (tick - start) / (end - start)));
  return result;
}

/** Timers stop at zero while waiting for a recorded outcome; zero never invents one. */
export function objectiveAt(timeline: ObjectiveTimeline, tick: number): ObjectiveView | undefined {
  let low = 0,
    high = timeline.states.length - 1,
    index = -1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    if (timeline.states[mid].tick <= tick) {
      index = mid;
      low = mid + 1;
    } else high = mid - 1;
  }
  const state = timeline.states[index];
  if (!state) return;
  const rate = timeline.tickRate;
  // Two seconds is presentation lifetime for an interruption notice, never a game action duration.
  const notice =
    state.notice && tick - state.notice.tick < 2 * rate ? state.notice.kind : undefined;
  if (state.phase === 'idle' && !notice) return;
  const recordedTiming = timeline.complete || tick <= timeline.lastSampleTick;
  const bomb = state.bomb
    ? meter(state.bomb.start, recordedTiming ? state.bomb.end : undefined, tick, rate)
    : undefined;
  const action = state.action
    ? meter(state.action.start, recordedTiming ? state.action.end : undefined, tick, rate)
    : undefined;
  return {
    phase: notice || (state.phase as ObjectiveView['phase']),
    actor: notice ? state.notice?.actor : (state.action?.actor ?? state.actor?.actor),
    name: notice ? state.notice?.name : (state.action?.name ?? state.actor?.name),
    site: state.bomb?.site,
    kit: state.action?.kit,
    meter: action || bomb || {},
    fuse: state.phase === 'defusing' || notice === 'defuse-aborted' ? bomb : undefined,
  };
}
