import { t } from '../i18n';
import { useMemo } from 'react';
import type { Playback } from '../types';
import { frameAt, playbackBounds } from '../playback';
export default function TacticalPlot({
  data,
  tick,
  selected,
  compact = false,
}: {
  data: Playback;
  tick: number;
  selected: string;
  compact?: boolean;
}) {
  const bounds = useMemo(() => {
    const { minX, maxX, minY, maxY } = playbackBounds(data);
    return { minX, minY, size: Math.max(maxX - minX, maxY - minY, 500) };
  }, [data.worldBounds, data.worldBounds ? null : data.frames]);
  const { frame } = frameAt(data, tick);
  return (
    <svg
      className={compact ? 'position-radar' : 'tactical-plot'}
      viewBox="0 0 120 120"
      role="img"
      aria-label={t('Player position plot. No map geometry.')}
    >
      <rect width="120" height="120" rx="4" fill="#171b19" />
      {[30, 60, 90].map((v) => (
        <g key={v} stroke="#3b403d" strokeWidth=".2">
          <path d={`M${v} 5V115 M5 ${v}H115`} />
        </g>
      ))}
      {frame.players
        .filter((p) => p.alive)
        .map((p) => (
          <g
            key={p.id}
            transform={`translate(${10 + ((p.x - bounds.minX) / bounds.size) * 100} ${110 - ((p.y - bounds.minY) / bounds.size) * 100})`}
          >
            <circle
              r={p.id === selected ? 2.7 : 1.8}
              fill={p.team === 3 ? '#9ec7da' : '#e7ba73'}
              stroke={p.id === selected ? '#fff' : 'none'}
              strokeWidth=".5"
            />
            <path
              d="M0 0h4"
              stroke={p.team === 3 ? '#9ec7da' : '#e7ba73'}
              strokeWidth=".6"
              transform={`rotate(${-p.yaw})`}
            />
          </g>
        ))}
    </svg>
  );
}
