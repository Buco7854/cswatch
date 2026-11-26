import type { GameplaySoundCue } from '../../shared/gameplay-sounds';
import type { ObjectiveData } from '../../shared/objectives';

export const c4BeepSample = 'objective-9ec82865cd0f';
const MAX_BEEPS = 1024;

type Located = (actor: string, tick: number) => GameplaySoundCue['position'];

/** The planted C4's beep is client-side in CS2 and is not part of the network
 * recording. Derive it from the recorded plant, detonation deadline and timer
 * length: each beep schedules the next after 0.1 s + 0.9 s × the remaining
 * fraction of the timer, never sooner than 0.15 s (the CS:GO planted-C4 rule).
 * It stops at the recorded defuse, explosion or removal. */
export function c4BeepCues(
  objectives: ObjectiveData | undefined,
  rate: number,
  locate: Located,
): GameplaySoundCue[] {
  if (!objectives?.samples.length || !(rate > 0)) return [];
  const cues: GameplaySoundCue[] = [];
  const samples = objectives.samples;
  const started = new Set<string>();
  for (let i = 0; i < samples.length && cues.length < MAX_BEEPS; i++) {
    const sample = samples[i];
    if (
      sample.kind !== 'bomb' ||
      started.has(sample.entity) ||
      !sample.present ||
      !sample.ticking ||
      sample.endTick === undefined ||
      !(sample.duration! > 0) ||
      sample.endTick <= sample.tick
    )
      continue;
    started.add(sample.entity);
    const blow = sample.endTick,
      timer = sample.duration! * rate;
    let stop = blow;
    for (let j = i + 1; j < samples.length; j++) {
      const later = samples[j];
      if (later.entity !== sample.entity || later.kind !== 'bomb') continue;
      if (!later.present || later.defused || later.exploded || later.ticking === false) {
        stop = Math.min(stop, later.tick);
        break;
      }
    }
    // The planter's recorded position at the moment the bomb started ticking.
    const planter = [...samples.slice(0, i)]
      .reverse()
      .find((candidate) => candidate.kind === 'plant' && candidate.actor)?.actor;
    const position = planter ? locate(planter, sample.tick) : undefined;
    for (let tick = sample.tick; tick < stop && cues.length < MAX_BEEPS;) {
      cues.push({
        id: `c4-beep-${sample.entity}-${cues.length}`,
        tick,
        soundId: c4BeepSample,
        category: 'objective',
        evidence: 'recorded-state',
        selection: 'representative',
        eventName: 'C4.PlantSound',
        ...(position ? { position } : {}),
      });
      const remaining = Math.max(0, (blow - tick) / timer);
      tick += Math.max(0.1 + 0.9 * remaining, 0.15) * rate;
    }
  }
  return cues;
}
