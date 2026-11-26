/** Per-player official agent models: holds recorded variants until resident (see agent-assets). */
import { useEffect, useRef, useState } from 'react';
import { holdEquipmentModel } from './equipment-loader';

/** Holds each wanted variant until it is resident. Returns the URLs safe to mount without
 * suspending. A failed load stays absent, so the team model remains. */
export function useLoadedAgentModels(urls: readonly string[]): ReadonlySet<string> {
  const key = [...new Set(urls)].sort().join('|');
  const holds = useRef(new Map<string, () => void>());
  const [ready, setReady] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    const wanted = new Set(key ? key.split('|') : []);
    for (const [url, release] of holds.current)
      if (!wanted.has(url)) {
        release();
        holds.current.delete(url);
        setReady((previous) => {
          if (!previous.has(url)) return previous;
          const next = new Set(previous);
          next.delete(url);
          return next;
        });
      }
    for (const url of wanted)
      if (!holds.current.has(url))
        holds.current.set(
          url,
          holdEquipmentModel(
            url,
            () =>
              setReady((previous) => (previous.has(url) ? previous : new Set(previous).add(url))),
            () => undefined,
          ),
        );
  }, [key]);
  useEffect(() => {
    const current = holds.current;
    return () => {
      for (const release of current.values()) release();
      current.clear();
    };
  }, []);
  return ready;
}
