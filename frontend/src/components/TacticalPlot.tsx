import { t } from '../i18n';
import { useMemo } from 'react';
import type { Playback } from '../types';
import { frameAt, playbackBounds, defaultSettings, type ViewerSettings } from '../playback';
import { buildUtilityZones, projectilesAt } from '../utility-state';
export default function TacticalPlot({
  data,
  tick,
  selected,
  compact = false,
  settings = defaultSettings,
  focus,
}: {
  data: Playback;
  tick: number;
  selected: string;
  compact?: boolean;
  settings?: ViewerSettings;
  focus?: { x: number; y: number };
}) {
  const bounds = useMemo(() => {
    let { minX, maxX, minY, maxY } = playbackBounds(data);
    for (const event of data.events) {
      if (
        typeof event.x !== 'number' ||
        typeof event.y !== 'number' ||
        !Number.isFinite(event.x) ||
        !Number.isFinite(event.y)
      )
        continue;
      minX = Math.min(minX, event.x);
      maxX = Math.max(maxX, event.x);
      minY = Math.min(minY, event.y);
      maxY = Math.max(maxY, event.y);
    }
    return { minX, minY, size: Math.max(maxX - minX, maxY - minY, 500) };
  }, [data.worldBounds, data.events, data.worldBounds ? null : data.frames]);
  const zones = useMemo(
    () => buildUtilityZones(data.events, data.tickRate),
    [data.events, data.tickRate],
  );
  const projectiles = useMemo(
    () => projectilesAt(data.grenades || [], tick, data.tickRate),
    [data.grenades, tick, data.tickRate],
  );
  const point = (value: { x: number; y: number }) =>
    `${10 + ((value.x - bounds.minX) / bounds.size) * 100},${110 - ((value.y - bounds.minY) / bounds.size) * 100}`;
  const { frame } = frameAt(data, tick);
  return (
    <svg
      className={compact ? 'position-radar' : 'tactical-plot'}
      viewBox="0 0 120 120"
      role="img"
      aria-label={t('Player position plot. No map geometry.')}
      data-projectile-count={projectiles.length}
      data-utility-zone-count={
        settings.utilities
          ? zones.filter((zone) => tick >= zone.start && tick < zone.end).length
          : 0
      }
    >
      <rect width="120" height="120" rx="2" fill="var(--viewer-plane, #171b19)" />
      {[30, 60, 90].map((v) => (
        <g key={v} stroke="var(--viewer-line, #3b403d)" strokeWidth=".2">
          <path d={`M${v} 5V115 M5 ${v}H115`} />
        </g>
      ))}
      {settings.utilities &&
        zones
          .filter((zone) => tick >= zone.start && tick < zone.end)
          .map((zone) => (
            <circle
              key={zone.id}
              className="tactical-utility-zone"
              data-kind={zone.kind}
              cx={10 + ((zone.x - bounds.minX) / bounds.size) * 100}
              cy={110 - ((zone.y - bounds.minY) / bounds.size) * 100}
              r={Math.max(
                1.5,
                Math.min(
                  30,
                  ((zone.kind === 'smoke' ? 146 : zone.kind === 'fire' ? 126 : 35) / bounds.size) *
                    100,
                ),
              )}
              fill={
                zone.kind === 'smoke' ? '#b5b8ad' : zone.kind === 'flash' ? '#f5f0d8' : '#e4a661'
              }
              fillOpacity=".35"
              stroke="none"
            />
          ))}
      {projectiles.map((grenade) => (
        <g key={grenade.id}>
          {settings.trajectories && grenade.trail.length > 1 && (
            <polyline
              className="tactical-grenade-path"
              points={grenade.trail.map(point).join(' ')}
              fill="none"
              stroke="#e4b575"
              strokeWidth=".55"
            />
          )}
          <circle
            className="tactical-projectile"
            cx={10 + ((grenade.point.x - bounds.minX) / bounds.size) * 100}
            cy={110 - ((grenade.point.y - bounds.minY) / bounds.size) * 100}
            r={compact ? 1.2 : 1.5}
            fill="#e4b575"
            stroke="var(--viewer-plane, #171b19)"
            strokeWidth=".35"
          />
        </g>
      ))}
      {focus && (
        <circle
          className="tactical-review-target"
          cx={10 + ((focus.x - bounds.minX) / bounds.size) * 100}
          cy={110 - ((focus.y - bounds.minY) / bounds.size) * 100}
          r="4"
          fill="none"
          stroke="var(--signal)"
          strokeWidth=".8"
        >
          <title>{t('Utility landing')}</title>
        </circle>
      )}
      {frame.players
        .filter((p) => p.alive)
        .map((p) => (
          <g
            key={p.id}
            transform={`translate(${10 + ((p.x - bounds.minX) / bounds.size) * 100} ${110 - ((p.y - bounds.minY) / bounds.size) * 100})`}
          >
            <circle
              r={p.id === selected ? 2.7 : 1.8}
              fill={p.team === 3 ? 'var(--team-ct, #9ec7da)' : 'var(--team-t, #e7ba73)'}
              stroke={p.id === selected ? 'var(--viewer-ink, #fff)' : 'none'}
              strokeWidth=".5"
            />
            <path
              d="M0 0h4"
              stroke={p.team === 3 ? 'var(--team-ct, #9ec7da)' : 'var(--team-t, #e7ba73)'}
              strokeWidth=".6"
              transform={`rotate(${-p.yaw})`}
            />
          </g>
        ))}
    </svg>
  );
}
