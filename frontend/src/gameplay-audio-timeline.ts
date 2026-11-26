import type { GameplaySoundCue } from '../../shared/gameplay-sounds';

type PlannedSound = { cue: GameplaySoundCue; delay: number };

/** A native loop (fire, a lit molotov) repeats until its recorded stop. Without
 * a recorded stop it plays once, like any other cue. */
export function sustainedCue(cue: GameplaySoundCue) {
  return cue.endTick !== undefined && /\.(?:idle)?loop$/i.test(cue.eventName ?? '');
}
/** Bounded look-ahead on recorded time, independent of render-frame cadence.
 * Resets establish a new floor so seeking never replays earlier sound cues. */
export class GameplayAudioTimeline {
  private previous?: { tick: number; wall: number; speed: number };
  private floor = 0;
  private seen = new Map<string, number>();
  private input?: GameplaySoundCue[];
  private ordered: GameplaySoundCue[] = [];
  private cadence = 0.12;
  reset() {
    this.previous = undefined;
    this.seen.clear();
    this.input = undefined;
    this.ordered = [];
    this.cadence = 0.12;
  }
  plan(
    cues: GameplaySoundCue[],
    tick: number,
    rate: number,
    speed: number,
    wall: number,
    playable: (cue: GameplaySoundCue) => boolean = () => true,
    wallSample?: string,
  ) {
    if (![tick, rate, speed, wall].every(Number.isFinite) || rate <= 0 || speed <= 0) {
      this.reset();
      return { reset: true, sounds: [] as PlannedSound[], prefetch: new Set<string>() };
    }
    const previous = this.previous;
    if (previous && wall >= previous.wall)
      this.cadence = Math.max(
        0.12,
        Math.min(0.65, Math.max((wall - previous.wall) / 1000, this.cadence * 0.85)),
      );
    const reset =
      !previous ||
      previous.speed !== speed ||
      tick < previous.tick - 0.01 ||
      Math.abs((tick - previous.tick) / rate - ((wall - previous.wall) / 1000) * speed) >
        Math.max(0.25 * speed, 2 / rate);
    if (reset) {
      this.floor = tick;
      this.seen.clear();
    }
    this.previous = { tick, wall, speed };
    if (this.input !== cues) {
      this.input = cues;
      this.ordered = [...cues].sort((a, b) => a.tick - b.tick || a.id.localeCompare(b.id));
    }
    // Loops stay marked until their recorded stop, other cues for one second.
    for (const [id, at] of this.seen) if (at < tick - rate) this.seen.delete(id);
    const start = Math.max(this.floor, tick - rate * 0.025),
      end = tick + rate * speed * Math.min(1, Math.max(0.18, this.cadence * 1.5 + 0.05)),
      horizon = tick + rate * speed;
    let low = 0,
      high = this.ordered.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.ordered[middle].tick < start) low = middle + 1;
      else high = middle;
    }
    const sounds: PlannedSound[] = [];
    const prefetch = new Set<string>();
    // A seek lands inside recorded loops: resume them at their current offset.
    if (reset)
      for (let i = 0; i < low && sounds.length < 32; i++) {
        const cue = this.ordered[i];
        if (!sustainedCue(cue) || cue.endTick! <= tick || !playable(cue) || this.seen.has(cue.id))
          continue;
        this.seen.set(cue.id, cue.endTick! + rate);
        sounds.push({ cue, delay: (cue.tick - tick) / rate / speed });
      }
    for (let i = low; i < this.ordered.length && this.ordered[i].tick <= horizon; i++) {
      const cue = this.ordered[i];
      if (!playable(cue)) continue;
      if (cue.tick >= tick && prefetch.size < 16) {
        prefetch.add(cue.soundId);
        if (wallSample && cue.shotAngles && prefetch.size < 16) prefetch.add(wallSample);
      }
      // Give the global winner announcement the full one-second audio clock
      // horizon, even when the next visual frame arrives late.
      if (cue.category !== 'round' && cue.tick > end) continue;
      if (this.seen.has(cue.id) || sounds.length >= 128 || this.seen.size >= 4096) continue;
      this.seen.set(cue.id, sustainedCue(cue) ? cue.endTick! + rate : cue.tick);
      sounds.push({ cue, delay: (cue.tick - tick) / rate / speed });
    }
    return { reset, sounds, prefetch };
  }
}
