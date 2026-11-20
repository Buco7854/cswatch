import { t } from '../i18n';
import { useId, useMemo } from 'react';
import type { Playback } from '../types';
import type { MapOverview } from '../../../shared/map-assets';
import { overviewPoint, overviewRadius } from '../tactical-coordinates';
import { tacticalPalette } from '../tactical-palette';
import type { AssetStatus } from '../map-assets';
import { frameAt, playbackBounds, defaultSettings, type ViewerSettings } from '../playback';
import { buildUtilityZoneIndex, projectilesAt } from '../utility-state';
import { hasRecordedProjectiles, indexItems, itemsAt } from '../item-state';
import { equipmentKind, equipmentName } from '../equipment-display';
import EquipmentGlyph from './EquipmentGlyph';
import MapUnavailable, { type MapUnavailableAction } from './MapUnavailable';
import type { MapUnavailableReason } from '../map-availability';
import './tactical-plot.css';
export default function TacticalPlot({
  data,
  tick,
  selected,
  compact = false,
  settings = defaultSettings,
  focus,
  overview,
  overviewStatus = 'missing',
  onOverviewState,
  unavailableReason = 'missing',
  unavailableNotice,
  unavailableAction,
}: {
  data: Playback;
  tick: number;
  selected: string;
  compact?: boolean;
  unavailableReason?: MapUnavailableReason;
  unavailableNotice?: { title: string; description: string };
  unavailableAction?: MapUnavailableAction;
  settings?: ViewerSettings;
  focus?: { x: number; y: number };
  overview?: MapOverview | null;
  overviewStatus?: AssetStatus;
  onOverviewState?: (image: string, version: string, status: 'ready' | 'error') => void;
}) {
  const clip = useId().replace(/:/g, '');
  const calibrated = overview && overviewStatus !== 'error' ? overview : null;
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
  const zonesAt = useMemo(
    () => buildUtilityZoneIndex(data.events, data.tickRate),
    [data.events, data.tickRate],
  );
  const zones = settings.utilities ? zonesAt(tick) : [];
  const projectiles = useMemo(
    () => projectilesAt(data.grenades || [], tick, data.tickRate, settings.trajectories),
    [data.grenades, tick, data.tickRate, settings.trajectories],
  );
  const itemIndex = useMemo(() => indexItems(data.itemSamples), [data.itemSamples]);
  const items = useMemo(() => itemsAt(itemIndex, tick), [itemIndex, tick]);
  const recordedProjectiles = hasRecordedProjectiles(data);
  const itemBodies = items.filter((item) => item.kind !== 'projectile' || recordedProjectiles);
  const position = (value: { x: number; y: number }) => {
    const normalized = calibrated
      ? overviewPoint(calibrated, value)
      : { x: (value.x - bounds.minX) / bounds.size, y: 1 - (value.y - bounds.minY) / bounds.size };
    return { x: 10 + normalized.x * 100, y: 10 + normalized.y * 100 };
  };
  const point = (value: { x: number; y: number }) => {
    const p = position(value);
    return `${p.x},${p.y}`;
  };
  const { frame } = frameAt(data, tick);
  if (!calibrated && !data.sample)
    return compact ? null : (
      <MapUnavailable
        notice={unavailableNotice}
        action={unavailableAction}
        reason={overview && overviewStatus === 'error' ? 'overview-error' : unavailableReason}
      />
    );
  const painted = Boolean(data.sample) || overviewStatus === 'ready';
  return (
    <svg
      className={compact ? 'position-radar' : 'tactical-plot'}
      viewBox="0 0 120 120"
      style={{ backgroundColor: compact ? 'transparent' : tacticalPalette.ground }}
      role="img"
      aria-label={t(
        calibrated
          ? overviewStatus === 'ready'
            ? 'Map overview with recorded player positions'
            : 'Loading map overview'
          : 'Player position plot. No map geometry.',
      )}
      data-map-image-state={
        calibrated ? overviewStatus : overviewStatus === 'error' ? 'error' : 'missing'
      }
      data-overview-image={calibrated?.image}
      data-overview-version={calibrated?.assetVersion}
      data-projectile-count={
        recordedProjectiles
          ? items.filter((item) => item.kind === 'projectile').length
          : projectiles.length
      }
      data-world-item-count={items.filter((item) => item.kind !== 'projectile').length}
      data-utility-zone-count={zones.length}
    >
      <rect
        width="120"
        height="120"
        rx="2"
        fill={compact ? tacticalPalette.radarBackdrop : tacticalPalette.ground}
      />
      {calibrated ? (
        <>
          <defs>
            <clipPath id={clip}>
              <rect x="10" y="10" width="100" height="100" />
            </clipPath>
          </defs>
          <image
            key={calibrated.image + ':' + calibrated.assetVersion}
            href={calibrated.image}
            x="10"
            y="10"
            width="100"
            height="100"
            preserveAspectRatio="none"
            onLoad={() => onOverviewState?.(calibrated.image, calibrated.assetVersion, 'ready')}
            onError={() => onOverviewState?.(calibrated.image, calibrated.assetVersion, 'error')}
          />
        </>
      ) : (
        [30, 60, 90].map((v) => (
          <g key={v} className="tactical-grid" stroke={tacticalPalette.grid} strokeWidth=".2">
            <path d={`M${v} 5V115 M5 ${v}H115`} />
          </g>
        ))
      )}
      <g
        visibility={painted ? undefined : 'hidden'}
        clipPath={calibrated ? `url(#${clip})` : undefined}
      >
        {zones.map((zone) => (
          <circle
            key={zone.id}
            className="tactical-utility-zone"
            data-kind={zone.kind}
            cx={position(zone).x}
            cy={position(zone).y}
            r={
              calibrated
                ? overviewRadius(
                    calibrated,
                    zone.kind === 'smoke' ? 146 : zone.kind === 'fire' ? 126 : 35,
                  ) * 100
                : Math.max(
                    1.5,
                    Math.min(
                      30,
                      ((zone.kind === 'smoke' ? 146 : zone.kind === 'fire' ? 126 : 35) /
                        bounds.size) *
                        100,
                    ),
                  )
            }
            fill={zone.kind === 'smoke' ? '#b5b8ad' : zone.kind === 'flash' ? '#f5f0d8' : '#e4a661'}
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
                stroke={tacticalPalette.utility}
                strokeWidth=".55"
              />
            )}
            {!recordedProjectiles && (
              <circle
                className="tactical-projectile"
                cx={position(grenade.point).x}
                cy={position(grenade.point).y}
                r={compact ? 1.2 : 1.5}
                fill={tacticalPalette.utility}
                stroke={tacticalPalette.ground}
                strokeWidth=".35"
              />
            )}
          </g>
        ))}
        {itemBodies.map((item) => {
          const p = position(item),
            kind = equipmentKind(item.equipment),
            weapon = [
              'ak',
              'rifle',
              'sniper',
              'smg',
              'pistol',
              'shotgun',
              'machinegun',
              'knife',
              'taser',
            ].includes(kind),
            width = weapon ? 6.8 : 3.4,
            height = 3.4;
          return (
            <g
              key={item.id}
              className="tactical-item"
              data-item-id={item.id}
              data-kind={item.kind}
              data-equipment={item.equipment}
              transform={`translate(${p.x} ${p.y})`}
            >
              <title>
                {item.kind === 'planted'
                  ? t('Bomb planted')
                  : item.kind === 'dropped'
                    ? t('Dropped {{item}}', { item: equipmentName(item.equipment) })
                    : equipmentName(item.equipment)}
              </title>
              {item.kind === 'planted' && (
                <circle r="2.6" fill={tacticalPalette.t} fillOpacity=".22" />
              )}
              <foreignObject x={-width / 2} y={-height / 2} width={width} height={height}>
                <div className="tactical-item-symbol">
                  <EquipmentGlyph item={item.equipment === 'plantedc4' ? 'c4' : item.equipment} />
                </div>
              </foreignObject>
            </g>
          );
        })}
        {focus && (
          <circle
            className="tactical-review-target"
            cx={position(focus).x}
            cy={position(focus).y}
            r="4"
            fill="none"
            stroke={tacticalPalette.target}
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
              data-player-id={p.id}
              transform={`translate(${position(p).x} ${position(p).y})`}
            >
              <circle
                r={p.id === selected ? 2.7 : 1.8}
                fill={p.team === 3 ? tacticalPalette.ct : tacticalPalette.t}
                stroke={p.id === selected ? tacticalPalette.selected : 'none'}
                strokeWidth=".5"
              />
              <path
                d="M0 0h4"
                stroke={p.team === 3 ? tacticalPalette.ct : tacticalPalette.t}
                strokeWidth=".6"
                transform={`rotate(${-p.yaw})`}
              />
            </g>
          ))}
      </g>
    </svg>
  );
}
