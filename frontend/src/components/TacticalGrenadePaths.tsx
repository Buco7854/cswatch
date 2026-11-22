import { useMemo } from 'react';
import {
  grenadePathOpacity,
  revealedPoints,
  visibleGrenadePaths,
  type GrenadePathsMode,
} from '../grenade-paths';
import type { Playback } from '../types';
import { useReducedMotion } from '../reduced-motion';
import { useGrenadePaths } from './useGrenadePaths';

export default function TacticalGrenadePaths({
  data,
  tick,
  selected,
  mode,
  position,
}: {
  data: Playback;
  tick: number;
  selected: string;
  mode: GrenadePathsMode;
  position: (value: { x: number; y: number }) => { x: number; y: number };
}) {
  const paths = useGrenadePaths(data);
  const steady = useReducedMotion();
  const projected = useMemo(
    () =>
      new Map(
        paths.map((path) => {
          const points = path.points.map(position);
          const offsets: number[] = [];
          let line = '';
          for (const p of points) {
            line += `${line ? ' ' : ''}${p.x},${p.y}`;
            offsets.push(line.length);
          }
          return [path, { points, line, offsets }];
        }),
      ),
    [paths, position],
  );
  return visibleGrenadePaths(paths, tick, data.tickRate, mode, selected).map((path) => {
    const count = revealedPoints(path.points, tick);
    if (!count) return null;
    const { points, line, offsets } = projected.get(path)!;
    const visibleLine = count > 1 ? line.slice(0, offsets[count - 1]) : undefined;
    const tip = tick < path.end && tick <= path.points.at(-1)!.tick ? points[count - 1] : undefined;
    return (
      <g key={path.id} opacity={grenadePathOpacity(path, tick, data.tickRate, steady)}>
        {visibleLine && (
          <>
            <polyline
              points={visibleLine}
              fill="none"
              stroke="#302924"
              strokeWidth="3.3"
              vectorEffect="non-scaling-stroke"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            <polyline
              className="tactical-grenade-path"
              points={visibleLine}
              fill="none"
              stroke={path.color}
              strokeWidth="1.9"
              vectorEffect="non-scaling-stroke"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          </>
        )}
        {path.bounces.map(
          (i) =>
            i + 1 < count && (
              <circle
                key={i}
                cx={points[i].x}
                cy={points[i].y}
                r="1.6"
                fill={path.color}
                stroke="#302924"
                strokeWidth=".6"
              />
            ),
        )}
        {tip && (
          <circle
            cx={tip.x}
            cy={tip.y}
            r="2.1"
            fill={path.marker}
            stroke="#262a2b"
            strokeWidth=".65"
          />
        )}
      </g>
    );
  });
}
