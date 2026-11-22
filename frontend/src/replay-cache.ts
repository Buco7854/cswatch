import { validGaitHistory } from '../../shared/agent-gait-history.mjs';
import type { Playback, PlaybackManifest, PlaybackChunk } from '../../shared/playback';
import { attachAim } from './player-pose';
import { validateItemSamples, validateItemState } from './item-state';
import { validateGameplaySoundInfo, validateGameplaySoundCues } from './gameplay-sound-assets';
import { validAgentDeaths } from '../../shared/agent-deaths.mjs';
import { validSmokeTracks } from '../../shared/smoke-state.mjs';

export const streamedReplayViews = new WeakSet<Playback>();

export function validateManifest(value: PlaybackManifest): PlaybackManifest {
  value.gameplaySounds = validateGameplaySoundInfo(value.gameplaySounds);
  if (
    value.version !== 2 ||
    !Number.isSafeInteger(value.firstTick) ||
    !Number.isSafeInteger(value.lastTick) ||
    value.firstTick < 0 ||
    value.firstTick > value.lastTick ||
    !Array.isArray(value.chunks) ||
    !value.chunks.length ||
    value.chunks.length > 512 ||
    !Array.isArray(value.players) ||
    !Array.isArray(value.events)
  )
    throw new Error('Replay metadata is invalid.');
  validateItemState(value.itemState);
  if (!validAgentDeaths(value.agentDeaths)) delete value.agentDeaths;
  if (
    value.gaitHistory !== undefined &&
    !validGaitHistory(
      value.gaitHistory,
      new Set(value.players.map(({ id }) => id)),
      value.firstTick,
      value.lastTick,
      value.tickRate,
    )
  )
    delete value.gaitHistory;
  if (!validSmokeTracks(value.smokeTracks, value.lastTick)) delete value.smokeTracks;
  for (const [i, part] of value.chunks.entries()) {
    if (
      part.index !== i ||
      !Number.isSafeInteger(part.startTick) ||
      !Number.isSafeInteger(part.endTick) ||
      !Number.isSafeInteger(part.firstFrameTick) ||
      part.firstFrameTick > part.startTick ||
      part.startTick > part.endTick ||
      !Number.isSafeInteger(part.frames) ||
      part.frames < 1 ||
      part.frames > 561 ||
      !Number.isSafeInteger(part.bytes) ||
      part.bytes < 1 ||
      part.bytes > 4 * 1024 ** 2 ||
      (i > 0 && part.startTick !== value.chunks[i - 1].endTick)
    )
      throw new Error('Replay metadata is invalid.');
    if (
      part.stride !== undefined &&
      (!Array.isArray(part.stride) ||
        part.stride.length > 128 ||
        part.stride.some(
          (pair) =>
            !Array.isArray(pair) ||
            pair.length !== 2 ||
            typeof pair[0] !== 'string' ||
            !/^\d{1,20}$/.test(pair[0]) ||
            !Number.isSafeInteger(pair[1]) ||
            pair[1] < 0 ||
            pair[1] > 100_000_000,
        ) ||
        new Set(part.stride.map(([id]) => id)).size !== part.stride.length)
    )
      delete part.stride;
  }
  if (
    value.chunks[0].startTick !== value.firstTick ||
    value.chunks.at(-1)!.endTick !== value.lastTick
  )
    throw new Error('Replay metadata is invalid.');
  return value;
}

export function chunkIndex(manifest: PlaybackManifest, tick: number): number {
  let low = 0,
    high = manifest.chunks.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (manifest.chunks[middle].startTick <= tick) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** At most three decoded slices and two requests; seeking cancels irrelevant transfers. */
export class ReplayCache {
  private cache = new Map<number, PlaybackChunk>();
  private views = new Map<number, Playback>();
  private pending = new Map<
    number,
    { controller: AbortController; promise: Promise<PlaybackChunk> }
  >();
  private target = 0;
  private disposed = false;
  constructor(
    readonly manifest: PlaybackManifest,
    private fetchChunk: (index: number, signal: AbortSignal) => Promise<PlaybackChunk>,
  ) {}

  get size() {
    return this.cache.size;
  }
  get requests() {
    return this.pending.size;
  }
  has(tick: number) {
    return this.cache.has(chunkIndex(this.manifest, tick));
  }

  /** Synchronous canonical lookup avoids rendering a previous slice after a cached boundary seek. */
  peek(tick: number): Playback | undefined {
    const index = chunkIndex(this.manifest, tick),
      part = this.cache.get(index);
    return part ? this.view(index, part) : undefined;
  }
  /** Only contiguous already-decoded slices may extend the playback clock horizon. */
  readyUntil(tick: number): number {
    let index = chunkIndex(this.manifest, tick);
    if (!this.cache.has(index)) return tick;
    while (index + 1 < this.manifest.chunks.length && this.cache.has(index + 1)) index++;
    return this.manifest.chunks[index].endTick;
  }
  private view(index: number, part: PlaybackChunk): Playback {
    const existing = this.views.get(index);
    if (existing) return existing;
    const {
      version: _version,
      chunks: _chunks,
      firstTick: _first,
      lastTick: _last,
      ...metadata
    } = this.manifest;
    const descriptor = this.manifest.chunks[index];
    const value: Playback = {
      ...metadata,
      version: 1,
      frames: part.frames,
      grenades: part.grenades,
      voice: part.voice,
      sounds: part.sounds,
      itemSamples: part.itemSamples,
      strideAnchor: descriptor.stride
        ? { tick: descriptor.startTick, players: descriptor.stride }
        : undefined,
    };
    streamedReplayViews.add(value);
    if (this.cache.get(index) === part) this.views.set(index, value);
    return value;
  }

  private load(index: number): Promise<PlaybackChunk> {
    if (this.disposed) return Promise.reject(new DOMException('Replay closed', 'AbortError'));
    const cached = this.cache.get(index);
    if (cached) {
      this.cache.delete(index);
      this.cache.set(index, cached);
      return Promise.resolve(cached);
    }
    const existing = this.pending.get(index);
    if (existing) return existing.promise;
    const controller = new AbortController();
    const promise = this.fetchChunk(index, controller.signal)
      .then((part) => {
        if (controller.signal.aborted || this.disposed)
          throw new DOMException('Replay closed', 'AbortError');
        const info = this.manifest.chunks[index];
        if (
          part.version !== 2 ||
          part.index !== index ||
          !Array.isArray(part.frames) ||
          !Array.isArray(part.grenades) ||
          part.frames.length !== info.frames ||
          part.frames[0]?.tick !== info.firstFrameTick ||
          part.frames.at(-1)?.tick !== info.endTick ||
          part.frames.some(
            (f, i) => !Array.isArray(f.players) || (i > 0 && f.tick <= part.frames[i - 1].tick),
          )
        )
          throw new Error('Replay chunk is invalid.');
        part.itemSamples = validateItemSamples(part.itemSamples, info.endTick);
        part.sounds = validateGameplaySoundCues(
          part.sounds,
          info.firstFrameTick,
          info.endTick,
          this.manifest.lastTick,
        );
        if (Boolean(this.manifest.itemState) !== (part.itemSamples !== undefined))
          throw new Error('Replay item metadata is invalid.');
        attachAim(part, info, new Set(this.manifest.players.map((player) => player.id)));
        this.cache.set(index, part);
        while (this.cache.size > 3) {
          const oldest = this.cache.keys().next().value!;
          this.cache.delete(oldest);
          this.views.delete(oldest);
        }
        return part;
      })
      .finally(() => {
        if (this.pending.get(index)?.controller === controller) this.pending.delete(index);
      });
    this.pending.set(index, { controller, promise });
    return promise;
  }

  async at(tick: number): Promise<Playback> {
    const index = chunkIndex(this.manifest, tick);
    this.target = index;
    // Keep only the requested slice and its forward prefetch when the user jumps elsewhere.
    for (const [key, request] of this.pending) {
      if (key !== index && key !== index + 1) {
        request.controller.abort();
        this.pending.delete(key);
      }
    }
    const part = await this.load(index);
    if (this.disposed) throw new DOMException('Replay closed', 'AbortError');
    if (this.target === index && index + 1 < this.manifest.chunks.length && this.pending.size < 2)
      void this.load(index + 1).catch(() => {});
    return this.view(index, part);
  }

  close() {
    this.disposed = true;
    for (const request of this.pending.values()) request.controller.abort();
    this.pending.clear();
    this.cache.clear();
    this.views.clear();
  }
}
