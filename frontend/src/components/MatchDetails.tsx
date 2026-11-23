import { useEquipmentIcon } from '../equipment-icons';
import { Map } from 'lucide-react';
import { useState } from 'react';
import previews from '../../../shared/map-previews.json';
import type { MatchPerformance } from '../../../shared/library-match';
import { locale, t } from '../i18n';

export function mapName(map?: string | null) {
  return map?.trim().replace(/^(?:de|cs)_/i, '') || '';
}

export function MapThumbnail({ map }: { map?: string | null }) {
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  const name = mapName(map);
  const id = map?.trim().toLowerCase();
  const bare = name.toLowerCase();
  const canonical = id?.includes('_') ? id : (bare === 'office' ? 'cs_' : 'de_') + bare;
  const badge = useEquipmentIcon('map' + canonical);
  const preview = previews.maps.includes(canonical)
    ? '/api/map-preview/' + canonical + '.png'
    : undefined;
  const source =
    badge && !failed.has(badge) ? badge : preview && !failed.has(preview) ? preview : undefined;
  return (
    <span className="map-initial match-thumbnail" aria-hidden="true">
      {source ? (
        <img
          src={source}
          data-badge={source === badge}
          alt=""
          loading="lazy"
          onError={() => setFailed((previous) => new Set([...previous, source]))}
        />
      ) : name ? (
        name.slice(0, 2).toUpperCase()
      ) : (
        <Map size={17} />
      )}
    </span>
  );
}

// Competitive and Wingman publish ordinal skill groups. The conventional CS
// rank abbreviations keep the labels readable in compact rows.
const skillGroups = [
  '',
  'S1',
  'S2',
  'S3',
  'S4',
  'SE',
  'SEM',
  'GN1',
  'GN2',
  'GN3',
  'GNM',
  'MG1',
  'MG2',
  'MGE',
  'DMG',
  'LE',
  'LEM',
  'SMFC',
  'GE',
];

export function MatchDetails({
  performance,
  score,
  faceitLevel,
}: {
  performance?: MatchPerformance;
  faceitLevel?: number;
  score?: number[] | null;
}) {
  const rank = performance?.rank;
  const { kills, deaths, assists, headshotKills } = performance ?? {};
  const hasKda = kills != null || deaths != null || assists != null;
  if (!faceitLevel && !rank && !hasKda && score?.length !== 2) return null;
  const number = new Intl.NumberFormat(locale());
  return (
    <span className="match-performance">
      {score?.length === 2 && (
        <span title={t('Recorded CT–T score')}>{t('CT {{v0}} T', { v0: score.join('–') })}</span>
      )}
      {faceitLevel && (
        <span className="match-rank">{t('FACEIT level {{v0}}', { v0: faceitLevel })}</span>
      )}
      {rank && (
        <span className="match-rank">
          {t(
            rank.mode === 'Premier'
              ? 'Premier'
              : rank.mode === 'Wingman'
                ? 'Wingman'
                : 'Competitive',
          )}{' '}
          {rank.mode === 'Premier' ? number.format(rank.value) : skillGroups[rank.value]}
          {rank.change !== undefined && rank.change !== 0 && (
            <span className="match-rank-change">
              {' '}
              {rank.change > 0 ? '+' : '−'}
              {number.format(Math.abs(rank.change))}
            </span>
          )}
        </span>
      )}
      {hasKda && (
        <span title={t('Recorded kills, deaths and assists')}>
          {t('K/D/A')} {kills ?? '–'}/{deaths ?? '–'}/{assists ?? '–'}
        </span>
      )}
      {kills != null && kills > 0 && headshotKills != null && headshotKills <= kills && (
        <span title={t('Headshot percentage')}>
          {new Intl.NumberFormat(locale(), { style: 'percent', maximumFractionDigits: 1 }).format(
            headshotKills / kills,
          )}{' '}
          HS
        </span>
      )}
    </span>
  );
}
