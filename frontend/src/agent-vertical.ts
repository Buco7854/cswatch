import { MathUtils } from 'three';
import { frameAt } from './playback';
import type { Playback } from './types';

/** Match sample-to-sample vertical acceleration. A steady climb supplies no air pose. */
export function recordedAirPose(
  data: Pick<Playback, 'frames' | 'tickRate' | 'rounds'>,
  id: string,
  tick: number,
) {
  const { index } = frameAt(data, tick);
  const end = Math.min(index + 1, data.frames.length - 1);
  const rate = data.tickRate;
  let newest = -Infinity;
  let matches = 0;
  for (let i = end; i >= 2 && end - i <= 5; i--) {
    const a = data.frames[i - 2],
      b = data.frames[i - 1],
      c = data.frames[i];
    const from = a.players.find((p) => p.id === id),
      middle = b.players.find((p) => p.id === id),
      to = c.players.find((p) => p.id === id);
    const d1 = (b.tick - a.tick) / rate,
      d2 = (c.tick - b.tick) / rate;
    if (
      !from?.alive ||
      !middle?.alive ||
      !to?.alive ||
      d1 < 0.02 ||
      d2 < 0.02 ||
      d1 > 0.15 ||
      d2 > 0.15 ||
      data.rounds.some(({ tick }) => tick > a.tick && tick <= c.tick)
    )
      break;
    const before = ((middle.z - from.z) * 0.0254) / d1;
    const after = ((to.z - middle.z) * 0.0254) / d2;
    const acceleration = (after - before) / ((d1 + d2) / 2);
    if (Math.abs(before) > 13 || Math.abs(after) > 13) break;
    if (
      acceleration < -13 &&
      acceleration > -29 &&
      Math.max(Math.abs(before), Math.abs(after)) > 0.6
    ) {
      if (!matches) newest = c.tick;
      matches++;
    }
  }
  if (matches < 2 || tick - newest > rate * 0.16) return;
  return 1 - MathUtils.smoothstep((tick - newest) / rate, 0.025, 0.16);
}
