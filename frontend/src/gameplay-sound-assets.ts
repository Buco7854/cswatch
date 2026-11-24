import type {
  GameplaySoundCue,
  GameplaySoundInfo,
  SharedGameplaySoundCatalog,
} from '../../shared/gameplay-sounds';
import registry from '../../shared/gameplay-sounds.json';
import { gameplayAudioLimits, inspectGameplayAudio } from '../../shared/gameplay-sound-files.mjs';
import { readMapJSON } from './demo-map-assets';

export const gameplaySoundCategories = [
  'weapon',
  'footstep',
  'reload',
  'utility',
  'objective',
  'round',
] as const;
const MiB = 1024 ** 2;
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid game sound data');
  return value as Record<string, unknown>;
};
const integer = (value: unknown, minimum: number, maximum: number) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
export function validateGameplaySoundCatalog(value: unknown): SharedGameplaySoundCatalog {
  const input = record(value),
    items = record(input.items);
  if (input.schemaVersion !== 1 || Object.keys(items).length > gameplayAudioLimits.bankItems)
    throw new Error('Invalid game sound catalog');
  const result: SharedGameplaySoundCatalog = { schemaVersion: 1, items: {} };
  let total = 0;
  for (const [id, raw] of Object.entries(items)) {
    const item = record(raw);
    if (
      !Object.hasOwn(registry.items, id) ||
      item.mime !== 'audio/wav' ||
      item.url !== `/api/sound-assets/${id}.wav` ||
      typeof item.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(item.sha256) ||
      !integer(item.bytes, 44, 2 * MiB) ||
      typeof item.durationMs !== 'number' ||
      !Number.isFinite(item.durationMs) ||
      item.durationMs <= 0 ||
      item.durationMs > 10000 ||
      !integer(item.sampleRate, 8000, 48000) ||
      !integer(item.channels, 1, 2)
    )
      throw new Error('Invalid game sound asset');
    total += item.bytes as number;
    if (total > 64 * MiB) throw new Error('Game sound catalog exceeds its bound');
    result.items[id] = {
      url: item.url as string,
      sha256: item.sha256,
      bytes: item.bytes as number,
      durationMs: item.durationMs as number,
      sampleRate: item.sampleRate as number,
      channels: item.channels as number,
      mime: 'audio/wav',
    };
  }
  return result;
}
/** Shared container preflight runs before the browser's native decoder. */
export function validateSoundPCM(
  bytes: Uint8Array,
  item: SharedGameplaySoundCatalog['items'][string],
) {
  const actual = inspectGameplayAudio(bytes);
  if (
    bytes.byteLength !== item.bytes ||
    actual.mime !== item.mime ||
    actual.sampleRate !== item.sampleRate ||
    actual.channels !== item.channels ||
    Math.abs(actual.durationMs - item.durationMs) > 0.01
  )
    throw new Error('PCM descriptor mismatch');
}
export function validateGameplaySoundCues(
  value: unknown,
  first = 0,
  last = 691200,
  matchLast = 691200,
): GameplaySoundCue[] {
  if (!Array.isArray(value) || value.length > 4096) throw new Error('Invalid recorded game sounds');
  const seen = new Set<string>();
  return value.map((raw) => {
    const item = record(raw);
    if (
      typeof item.id !== 'string' ||
      !item.id ||
      item.id.length > 100 ||
      seen.has(item.id) ||
      typeof item.tick !== 'number' ||
      !Number.isFinite(item.tick) ||
      item.tick < first ||
      item.tick > last ||
      typeof item.soundId !== 'string' ||
      !Object.hasOwn(registry.items, item.soundId) ||
      registry.items[item.soundId as keyof typeof registry.items].category !== item.category ||
      !['game-event', 'network-sound'].includes(String(item.evidence)) ||
      !['representative', 'recorded'].includes(String(item.selection)) ||
      (item.eventName !== undefined &&
        (typeof item.eventName !== 'string' || !item.eventName || item.eventName.length > 128)) ||
      (item.endTick !== undefined &&
        (typeof item.endTick !== 'number' ||
          !Number.isFinite(item.endTick) ||
          item.endTick < item.tick ||
          item.endTick > matchLast)) ||
      (item.actor !== undefined &&
        (typeof item.actor !== 'string' || !/^\d{1,20}$/.test(item.actor))) ||
      (item.volume !== undefined &&
        (typeof item.volume !== 'number' ||
          !Number.isFinite(item.volume) ||
          item.volume < 0 ||
          item.volume > 1)) ||
      (item.pitch !== undefined &&
        (typeof item.pitch !== 'number' ||
          !Number.isFinite(item.pitch) ||
          item.pitch < 0.25 ||
          item.pitch > 4))
    )
      throw new Error('Invalid recorded game sound');
    if (item.position !== undefined) {
      const position = record(item.position);
      if (
        !['x', 'y', 'z'].every(
          (key) =>
            typeof position[key] === 'number' &&
            Number.isFinite(position[key]) &&
            Math.abs(position[key] as number) <= 1e7,
        )
      )
        throw new Error('Invalid sound position');
    }
    seen.add(item.id);
    return item as unknown as GameplaySoundCue;
  });
}
export function validateGameplaySoundInfo(value: unknown): GameplaySoundInfo {
  const input = record(value),
    coverage = record(input.coverage);
  if (
    typeof input.truncated !== 'boolean' ||
    Object.keys(coverage).length !== 6 ||
    !gameplaySoundCategories.every((category) =>
      ['available', 'partial', 'unavailable'].includes(String(coverage[category])),
    )
  )
    throw new Error('Invalid game sound coverage');
  return {
    coverage: Object.fromEntries(
      gameplaySoundCategories.map((category) => [category, coverage[category]]),
    ) as GameplaySoundInfo['coverage'],
    truncated: input.truncated,
  };
}
export async function fetchGameplaySoundCatalog(signal: AbortSignal) {
  const response = await fetch('/api/sound-assets', {
    signal,
    credentials: 'same-origin',
    redirect: 'error',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error('Game sound catalog unavailable');
  return validateGameplaySoundCatalog(await readMapJSON(response));
}

/** Private viewer cache: two decodes, bounded queue and LRU memory. Canceled
 * generations cannot publish decoded buffers or retain a previous identity. */
export class GameplaySoundBuffers {
  private cache = new Map<string, AudioBuffer>();
  private pending = new Map<string, Promise<AudioBuffer>>();
  private failed = new Set<string>();
  private controllers = new Set<AbortController>();
  private active = 0;
  private waiting: (() => void)[] = [];
  private generation = 0;
  private bytes = 0;
  private closed = false;
  constructor(
    private catalog: SharedGameplaySoundCatalog,
    private context: () => AudioContext | null,
  ) {}
  updateCatalog(catalog: SharedGameplaySoundCatalog) {
    this.catalog = catalog;
  }
  get(id: string): Promise<AudioBuffer> {
    const cached = this.cache.get(id);
    if (cached) {
      this.cache.delete(id);
      this.cache.set(id, cached);
      return Promise.resolve(cached);
    }
    const existing = this.pending.get(id);
    if (existing) return existing;
    const item = this.catalog.items[id];
    if (!item || this.closed || this.failed.has(id) || this.pending.size >= 16)
      return Promise.reject(new Error('Game sound unavailable'));
    const generation = this.generation;
    const promise = (async () => {
      // A wake-up does not reserve capacity against a newly arriving request.
      while (this.active >= 2) {
        await new Promise<void>((resolve) => this.waiting.push(resolve));
        if (this.closed || generation !== this.generation)
          throw new DOMException('Sound canceled', 'AbortError');
      }
      if (this.closed || generation !== this.generation)
        throw new DOMException('Sound canceled', 'AbortError');
      this.active++;
      const controller = new AbortController();
      this.controllers.add(controller);
      const deadline = setTimeout(() => controller.abort(), 10000);
      try {
        let response!: Response;
        for (let attempt = 0; attempt < 3; attempt++) {
          response = await fetch(item.url, {
            signal: controller.signal,
            credentials: 'same-origin',
            redirect: 'error',
          });
          if (![429, 503].includes(response.status) || attempt === 2) break;
          await response.body?.cancel().catch(() => {});
          const seconds = Number(response.headers.get('Retry-After'));
          const delay =
            Number.isFinite(seconds) && seconds > 0
              ? Math.min(2000, seconds * 1000)
              : 200 * 3 ** attempt;
          await new Promise<void>((resolve, reject) => {
            const abort = () => {
              clearTimeout(timer);
              controller.signal.removeEventListener('abort', abort);
              reject(new DOMException('Sound canceled', 'AbortError'));
            };
            const timer = setTimeout(() => {
              controller.signal.removeEventListener('abort', abort);
              resolve();
            }, delay);
            controller.signal.addEventListener('abort', abort, { once: true });
            if (controller.signal.aborted) abort();
          });
        }
        if (
          !response.ok ||
          (response.headers.get('Content-Type') || '').split(';')[0] !== item.mime ||
          Number(response.headers.get('Content-Length')) > item.bytes
        )
          throw new Error('Game sound download failed');
        const reader = response.body?.getReader();
        if (!reader) throw new Error('Missing sound bytes');
        const parts: Uint8Array[] = [];
        let length = 0;
        try {
          while (true) {
            const result = await reader.read();
            if (result.done) break;
            length += result.value.length;
            if (length > item.bytes) throw new Error('Sound exceeds its bound');
            parts.push(result.value);
          }
        } catch (error) {
          await reader.cancel().catch(() => {});
          throw error;
        } finally {
          reader.releaseLock();
        }
        if (length !== item.bytes) throw new Error('Incomplete sound');
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const part of parts) {
          bytes.set(part, offset);
          offset += part.length;
        }
        validateSoundPCM(bytes, item);
        const digest = await crypto.subtle.digest('SHA-256', bytes.buffer);
        if (
          [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('') !==
          item.sha256
        )
          throw new Error('Sound content mismatch');
        const context = this.context();
        if (!context || generation !== this.generation || this.closed)
          throw new DOMException('Sound canceled', 'AbortError');
        const buffer = await context.decodeAudioData(bytes.buffer);
        if (
          buffer.duration > 10.02 ||
          Math.abs(buffer.duration - item.durationMs / 1000) > 0.02 ||
          buffer.numberOfChannels !== item.channels ||
          buffer.sampleRate !== context.sampleRate ||
          buffer.sampleRate > 48000 ||
          buffer.length * buffer.numberOfChannels * 4 > 4 * MiB
        )
          throw new Error('Decoded sound exceeds its bound');
        if (generation !== this.generation || this.closed)
          throw new DOMException('Sound canceled', 'AbortError');
        const size = buffer.length * buffer.numberOfChannels * 4;
        while (this.bytes + size > 32 * MiB && this.cache.size) {
          const [key, old] = this.cache.entries().next().value!;
          this.cache.delete(key);
          this.bytes -= old.length * old.numberOfChannels * 4;
        }
        this.cache.set(id, buffer);
        this.bytes += size;
        return buffer;
      } finally {
        clearTimeout(deadline);
        this.controllers.delete(controller);
        this.active--;
        this.waiting.shift()?.();
      }
    })()
      .catch((error) => {
        if (!this.closed && generation === this.generation && error?.name !== 'AbortError')
          this.failed.add(id);
        throw error;
      })
      .finally(() => {
        if (this.pending.get(id) === promise) this.pending.delete(id);
      });
    this.pending.set(id, promise);
    return promise;
  }
  cancel() {
    this.generation++;
    for (const controller of this.controllers) controller.abort();
    for (const resume of this.waiting.splice(0)) resume();
    this.pending.clear();
  }
  close() {
    this.closed = true;
    this.cancel();
    this.cache.clear();
    this.failed.clear();
    this.bytes = 0;
  }
}
