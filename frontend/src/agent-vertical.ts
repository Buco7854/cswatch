import { MathUtils } from 'three';
import { strideDisplacement } from '../../shared/stride-distance.mjs';
import type { Playback } from './types';

type History = Pick<Playback, 'frames' | 'tickRate' | 'rounds'>;

/** Two consecutive gravity-like accelerations distinguish a curved flight path
 * from a stair or a uniform climb. Use only the current live pawn's trail. */
export function recordedAirWeight(data: History, id: string, index: number) {
  const { frames, tickRate: rate } = data;
  const end = frames[index].tick;
  let current = frames[index].players.find((p) => p.id === id);
  let laterSpeed: number | undefined;
  let laterSeconds = 0;
  let newerCurveEnd: number | undefined;
  for (let i = index; i > 0; i--) {
    const { tick } = frames[i];
    const previous = frames[i - 1];
    const from = previous.players.find((p) => p.id === id);
    const seconds = (tick - previous.tick) / rate;
    if (
      seconds < 0.02 ||
      seconds > 0.15 ||
      data.rounds.some((r) => r.tick > previous.tick && r.tick <= tick)
    )
      break;
    const delta = strideDisplacement(from, current, seconds);
    if (!delta) break;
    const speed = (delta.vertical * 0.0254) / seconds;
    if (Math.abs(speed) > 13) break;
    if (laterSpeed !== undefined) {
      const curveEnd = frames[i + 1].tick;
      if (end - (newerCurveEnd ?? curveEnd) >= rate * 0.16) break;
      const acceleration = (laterSpeed - speed) / ((seconds + laterSeconds) / 2);
      const curved =
        acceleration < -13 &&
        acceleration > -29 &&
        Math.max(Math.abs(speed), Math.abs(laterSpeed)) > 0.6;
      if (curved && newerCurveEnd !== undefined)
        return 1 - MathUtils.smoothstep((end - newerCurveEnd) / rate, 0.025, 0.16);
      newerCurveEnd = curved ? curveEnd : undefined;
    }
    laterSpeed = speed;
    laterSeconds = seconds;
    current = from;
  }
  return 0;
}
