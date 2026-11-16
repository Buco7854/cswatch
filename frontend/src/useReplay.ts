import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { sample } from './sample';
import { ReplayCache, chunkIndex, validateManifest } from './replay-cache';
import type { Demo, Playback } from './types';
import type { PlaybackChunk, PlaybackManifest } from '../../shared/playback';

export function useReplay(
  id: string | undefined,
  tick: number,
  onReady: (data: Playback, first: number) => void,
  userId?: string,
) {
  const [data, setData] = useState<Playback | null>(id === 'sample' ? sample : null);
  const [demo, setDemo] = useState<Demo | null>(null);
  const [error, setError] = useState('');
  const [chunkError, setChunkError] = useState('');
  const [buffering, setBuffering] = useState(false);
  const [bounds, setBounds] = useState({ first: 0, last: 0 });
  const [manifest, setManifest] = useState<PlaybackManifest | null>(null);
  const [retry, setRetry] = useState(0);
  const cache = useRef<ReplayCache | null>(null);
  const callback = useRef(onReady);
  const position = useRef(tick);
  position.current = tick;
  const previousId = useRef<string | undefined>(undefined);
  const identity = `${id || ''}:${userId || ''}`;
  const [loadedFor, setLoadedFor] = useState(identity);
  const [metadataFor, setMetadataFor] = useState(identity);
  callback.current = onReady;

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const resumeTick = previousId.current === id ? position.current : undefined;
    previousId.current = id;
    cache.current?.close();
    cache.current = null;
    setManifest(null);
    setDemo(null);
    setMetadataFor(identity);
    setError('');
    setChunkError('');
    setBuffering(false);
    setData(id === 'sample' ? sample : null);
    if (id === 'sample') {
      setBounds({ first: sample.frames[0].tick, last: sample.frames.at(-1)!.tick });
      setLoadedFor(identity);
      callback.current(sample, resumeTick ?? 400);
      return () => controller.abort();
    }
    const options = { signal: controller.signal };
    async function load() {
      try {
        const detail = await api<Demo>(`/api/demos/${id}`, options);
        if (controller.signal.aborted) return;
        setDemo(detail);
        if (detail.status !== 'ready') {
          if (detail.status !== 'failed') timer = setTimeout(load, 3000);
          return;
        }
        const replay = await api<Playback | PlaybackManifest>(`/api/demos/${id}/playback`, options);
        if (controller.signal.aborted) return;
        if (replay.version === 2) {
          const metadata = validateManifest(replay);
          const next = new ReplayCache(metadata, (index, signal) =>
            api<PlaybackChunk>(`/api/demos/${id}/playback/chunks/${index}`, { signal }),
          );
          cache.current = next;
          const start = Math.max(
            metadata.firstTick,
            Math.min(metadata.lastTick, resumeTick ?? metadata.firstTick),
          );
          const initial = await next.at(start);
          if (controller.signal.aborted) {
            next.close();
            return;
          }
          setData(initial);
          setBounds({ first: metadata.firstTick, last: metadata.lastTick });
          setManifest(metadata);
          setLoadedFor(identity);
          callback.current(initial, start);
        } else {
          if (replay.version !== 1 || !replay.frames?.length)
            throw new Error('Replay metadata is invalid.');
          setData(replay);
          setBounds({ first: replay.frames[0].tick, last: replay.frames.at(-1)!.tick });
          setLoadedFor(identity);
          callback.current(
            replay,
            Math.max(
              replay.frames[0].tick,
              Math.min(replay.frames.at(-1)!.tick, resumeTick ?? replay.frames[0].tick),
            ),
          );
        }
      } catch (e) {
        if (!controller.signal.aborted) setError((e as Error).message);
      }
    }
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
      cache.current?.close();
      cache.current = null;
    };
  }, [id, userId]);

  const index = manifest ? chunkIndex(manifest, tick) : -1;
  useEffect(() => {
    const current = cache.current;
    if (!current || !manifest || index < 0 || loadedFor !== identity) return;
    let disposed = false;
    setBuffering(!current.has(tick));
    setChunkError('');
    void current
      .at(tick)
      .then((next) => {
        if (!disposed && cache.current === current) {
          setData(next);
          setBuffering(false);
        }
      })
      .catch((e) => {
        if (!disposed && cache.current === current && e.name !== 'AbortError') {
          setChunkError('This moment could not be loaded. Check your connection and try again.');
          setBuffering(true);
        }
      });
    return () => {
      disposed = true;
    };
  }, [manifest, index, retry, identity, loadedFor]);

  return {
    data: loadedFor === identity ? data : null,
    demo: metadataFor === identity ? demo : null,
    setDemo,
    error,
    chunkError,
    buffering,
    ...bounds,
    retryChunk: () => setRetry((n) => n + 1),
  };
}
