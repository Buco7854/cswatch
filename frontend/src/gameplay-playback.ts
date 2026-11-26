import type {
  GameplaySoundCategory,
  GameplaySoundCue,
  SharedGameplaySoundCatalog,
} from '../../shared/gameplay-sounds';
import { GameplayAudioTimeline, sustainedCue } from './gameplay-audio-timeline';
import { GameplaySoundBuffers } from './gameplay-sound-assets';
import { ViewerAudio } from './viewer-audio';
import { nearWallContact, wallImpactSample, type WallTrace } from './shot-wall-audio';

/** Recorded gameplay and optional nearby wall contacts share the playback clock and source limits. */
export class GameplayPlayback {
  private timeline = new GameplayAudioTimeline();
  private buffers: GameplaySoundBuffers;
  private gain: GainNode | null = null;
  private sources = new Map<AudioBufferSourceNode, () => void>();
  private activeBytes = 0;
  private generation = 0;
  private scope = '';
  private closed = false;
  private release: () => void;
  constructor(
    private audio: ViewerAudio,
    private catalog: SharedGameplaySoundCatalog,
    private report: (message: string) => void,
  ) {
    this.buffers = new GameplaySoundBuffers(catalog, () => audio.context);
    this.release = audio.onFlush(() => this.stop());
  }
  updateCatalog(catalog: SharedGameplaySoundCatalog) {
    const changed = Object.entries(this.catalog.items).some(
      ([id, item]) => catalog.items[id] && catalog.items[id].sha256 !== item.sha256,
    );
    if (changed) {
      this.stop();
      this.buffers.close();
      this.buffers = new GameplaySoundBuffers(catalog, () => this.audio.context);
    } else this.buffers.updateCatalog(catalog);
    this.catalog = catalog;
  }
  private flush() {
    this.generation++;
    for (const stop of [...this.sources.values()]) stop();
    this.sources.clear();
    this.activeBytes = 0;
    this.buffers.cancel();
  }
  stop() {
    this.flush();
    this.timeline.reset();
  }
  sync(
    cues: GameplaySoundCue[],
    tick: number,
    rate: number,
    speed: number,
    volume: number,
    categories: GameplaySoundCategory[],
    spatial: boolean,
    scope: string,
    locate: (cue: GameplaySoundCue) => { x: number; y: number; z: number } | undefined,
    ownActor?: string,
    rounds: readonly { tick: number }[] = [],
    wallTrace?: WallTrace,
  ) {
    const context = this.audio.context;
    if (
      this.closed ||
      !context ||
      context.state !== 'running' ||
      this.audio.snapshot() !== 'running'
    )
      return;
    const scopeKey = `${scope}:${spatial}:${categories.join(',')}`;
    if (this.scope !== scopeKey) {
      this.stop();
      this.scope = scopeKey;
    }
    if (!this.gain) this.gain = this.audio.channel();
    if (!this.gain) return;
    this.gain.gain.value = Math.max(0, Math.min(1, volume));
    const allowed = new Set(categories);
    const wallSample =
      wallTrace && this.catalog.items[wallImpactSample] ? wallImpactSample : undefined;
    const plan = this.timeline.plan(
      cues,
      tick,
      rate,
      speed,
      performance.now(),
      (cue) =>
        allowed.has(cue.category) && cue.volume !== 0 && Boolean(this.catalog.items[cue.soundId]),
      wallSample,
    );
    if (plan.reset) this.flush();
    const generation = this.generation;
    // Warm only nearby known samples. The cache serializes at two decodes and
    // keeps at most sixteen pending requests, including this prefetch window.
    for (const id of plan.prefetch) void this.buffers.get(id).catch(() => {});
    if (wallTrace && wallSample) {
      // A stalled render frame can schedule a burst. Keep optional geometry
      // queries bounded and leave the original sounds on their normal clock.
      const contacts = [];
      let queries = 0;
      const deadline = performance.now() + 2;
      for (const { cue, delay } of plan.sounds) {
        if (!cue.shotAngles) continue;
        if (++queries > 4 || performance.now() > deadline) break;
        const position = nearWallContact(cue, wallTrace);
        if (position)
          contacts.push({
            cue: {
              id: cue.id + '-wall',
              tick: cue.tick,
              category: cue.category,
              soundId: wallImpactSample,
              selection: cue.selection,
              evidence: cue.evidence,
              position,
            },
            delay,
          });
      }
      plan.sounds.push(...contacts);
    }
    for (const { cue, delay } of plan.sounds) {
      const start = context.currentTime + delay;
      const nextRound =
        cue.category === 'round' ? rounds.find((round) => round.tick > cue.tick) : undefined;
      const endTick = Math.min(cue.endTick ?? Infinity, nextRound?.tick ?? Infinity);
      const end =
        endTick === Infinity ? undefined : context.currentTime + (endTick - tick) / rate / speed;
      void this.buffers
        .get(cue.soundId)
        .then((buffer) => {
          if (
            generation !== this.generation ||
            this.closed ||
            this.audio.context !== context ||
            this.audio.snapshot() !== 'running'
          )
            return;
          const bytes = buffer.length * buffer.numberOfChannels * 4;
          if (end !== undefined && end <= context.currentTime) return;
          const loop = sustainedCue(cue) && end !== undefined;
          if (
            (!loop && context.currentTime - start > 0.1) ||
            this.sources.size >= 128 ||
            this.activeBytes + bytes > 16 * 1024 ** 2
          ) {
            this.report('Some game sounds could not be played.');
            return;
          }
          const source = context.createBufferSource(),
            cueGain = context.createGain();
          source.buffer = buffer;
          source.playbackRate.value = speed * (cue.pitch ?? 1);
          cueGain.gain.value = cue.volume ?? 1;
          source.connect(cueGain);
          let panner: PannerNode | undefined;
          const localAction =
            ownActor !== undefined &&
            cue.actor === ownActor &&
            ['weapon', 'reload', 'footstep'].includes(cue.category);
          const position = cue.category === 'round' ? undefined : cue.position || locate(cue);
          if (spatial && position && !localAction) {
            panner = context.createPanner();
            panner.panningModel = 'equalpower';
            panner.distanceModel = 'inverse';
            panner.refDistance = 3;
            panner.maxDistance = 250;
            panner.rolloffFactor = 1;
            panner.positionX.value = position.x * 0.0254;
            panner.positionY.value = position.z * 0.0254;
            panner.positionZ.value = -position.y * 0.0254;
            cueGain.connect(panner);
            panner.connect(this.gain!);
          } else cueGain.connect(this.gain!);
          const cleanup = () => {
            this.sources.delete(source);
            this.activeBytes = Math.max(0, this.activeBytes - bytes);
            cueGain.disconnect();
            panner?.disconnect();
          };
          const stop = this.audio.track(source, cleanup);
          if (!stop) {
            source.disconnect();
            cueGain.disconnect();
            panner?.disconnect();
            return;
          }
          this.sources.set(source, stop);
          this.activeBytes += bytes;
          source.loop = loop;
          const elapsed = Math.max(0, context.currentTime - start) * source.playbackRate.value;
          const offset = loop ? elapsed % buffer.duration : elapsed;
          if (offset >= buffer.duration) {
            stop();
            return;
          }
          try {
            source.start(Math.max(context.currentTime, start), offset);
            if (end !== undefined) source.stop(end);
          } catch {
            stop();
            this.report('Some game sounds could not be played.');
          }
        })
        .catch((error) => {
          if (generation === this.generation && !this.closed && error?.name !== 'AbortError')
            this.report('Some game sounds could not be decoded or verified.');
        });
    }
  }
  close() {
    this.closed = true;
    this.release();
    this.stop();
    this.buffers.close();
    this.audio.releaseChannel(this.gain);
    this.gain = null;
  }
}
