import { smokeLimits } from '../../shared/smoke-state.mjs';
import { smokeJournal } from './smoke-journal';
import type { SmokeDensityRequest, SmokeDensityResult } from './smoke-render-state';

const live = new Map<string, ReturnType<typeof smokeJournal>>();

self.onmessage = ({ data }: MessageEvent<SmokeDensityRequest>) => {
  const targets = data.targets.slice(0, smokeLimits.active);
  const transfer: ArrayBuffer[] = [];
  const rows: SmokeDensityResult[] = targets.map(({ key, track, offset, previousOffset }) => {
    try {
      let journal = live.get(key);
      if (journal) live.delete(key);
      else journal = smokeJournal(track);
      live.set(key, journal);
      if (live.size > smokeLimits.active) live.delete(live.keys().next().value!);
      const pair = journal(offset, previousOffset);
      // Keep the pair locally for the next step. Transfer copies to the renderer.
      const previous = { ...pair.previous, texels: pair.previous.texels.slice() };
      const current =
        pair.current === pair.previous
          ? previous
          : { ...pair.current, texels: pair.current.texels.slice() };
      transfer.push(previous.texels.buffer);
      if (current !== previous) transfer.push(current.texels.buffer);
      return { key, offset, previous, current, stoppedAt: pair.stoppedAt };
    } catch {
      live.delete(key);
      return { key, offset };
    }
  });
  self.postMessage(rows, { transfer });
};
