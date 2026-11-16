import { useMemo } from 'react';
import { Bomb, Check, X } from 'lucide-react';
import EquipmentGlyph from './EquipmentGlyph';
import type { Playback } from '../types';
import { buildObjectiveTimeline, objectiveAt, type ObjectiveMeter } from '../objective-state';
import { locale, t } from '../i18n';
import './objective-hud.css';

function Meter({
  value,
  label,
  fuse = false,
}: {
  value: ObjectiveMeter;
  label: string;
  fuse?: boolean;
}) {
  const seconds = value.remaining ?? value.elapsed;
  const formatted =
    seconds === undefined
      ? undefined
      : seconds.toLocaleString(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return (
    <div className={'objective-meter' + (fuse ? ' objective-meter-fuse' : '')}>
      <div className="objective-meter-caption">
        <span>
          {fuse && <Bomb size={12} aria-hidden="true" />}
          {label}
        </span>
        <span
          className={
            'objective-seconds' +
            (formatted === undefined
              ? ' is-unrecorded'
              : value.remaining === undefined
                ? ' is-elapsed'
                : '')
          }
          aria-live="off"
        >
          {formatted === undefined
            ? t('Timer not recorded')
            : value.remaining !== undefined
              ? t('{{seconds}} s', { seconds: formatted })
              : t('Elapsed {{seconds}} s', { seconds: formatted })}
        </span>
      </div>
      <div
        className={'objective-meter-track' + (value.progress === undefined ? ' is-unknown' : '')}
        aria-hidden="true"
      >
        {value.progress !== undefined && (
          <span style={{ width: `${100 * (fuse ? 1 - value.progress : value.progress)}%` }} />
        )}
      </div>
    </div>
  );
}

/** Spectator objective overlay. Countdown values come exclusively from recorded server deadlines. */
export default function ObjectiveHud({
  data,
  tick,
  hidden = false,
}: {
  data: Playback;
  tick: number;
  hidden?: boolean;
}) {
  const timeline = useMemo(
    () => buildObjectiveTimeline(data),
    [data.events, data.objectives, data.rounds, data.players, data.tickRate],
  );
  const objective = objectiveAt(timeline, tick);
  const labels = {
    planting: t('Planting'),
    planted: t('Bomb planted'),
    defusing: t('Defusing'),
    defused: t('Bomb defused'),
    exploded: t('Bomb exploded'),
    'plant-aborted': t('Plant interrupted'),
    'defuse-aborted': t('Defuse interrupted'),
  };
  const phase = objective?.phase;
  const label = phase ? labels[phase] : '';
  const terminal = phase === 'defused' || phase === 'exploded';
  const Icon = phase === 'defused' ? Check : X;
  return (
    <>
      {/* This stable live region changes only with lifecycle/visibility, never each timer frame. */}
      <span className="visually-hidden" role="status" aria-atomic="true">
        {hidden ? '' : label}
      </span>
      {objective && !hidden && (
        <aside className="objective-hud" data-phase={phase} aria-label={t('Bomb objective')}>
          <div className="objective-heading">
            {phase === 'defused' || phase === 'plant-aborted' || phase === 'defuse-aborted' ? (
              <Icon size={22} className="objective-symbol" aria-hidden="true" />
            ) : (
              <EquipmentGlyph
                item={phase === 'defusing' ? 'defuser' : 'c4'}
                className="objective-symbol"
              />
            )}
            <div className="objective-identity">
              <strong>{label}</strong>
              {(objective.name || objective.site !== undefined || objective.kit !== undefined) && (
                <span className="objective-context">
                  {objective.name && <span className="objective-player">{objective.name}</span>}
                  {objective.site !== undefined && (
                    <span>
                      {t('Bombsite {{site}}', { site: objective.site === 0 ? 'A' : 'B' })}
                    </span>
                  )}
                  {objective.kit !== undefined && (
                    <span>{t(objective.kit ? 'Defuse kit' : 'No defuse kit')}</span>
                  )}
                </span>
              )}
            </div>
          </div>
          {!terminal && phase !== 'plant-aborted' && (
            <div className="objective-timers">
              {phase !== 'defuse-aborted' && (
                <Meter
                  value={objective.meter}
                  label={t(
                    phase === 'planting'
                      ? 'Plant progress'
                      : phase === 'defusing'
                        ? 'Defuse progress'
                        : 'Bomb timer',
                  )}
                  fuse={phase === 'planted'}
                />
              )}
              {objective.fuse && <Meter value={objective.fuse} label={t('Bomb timer')} fuse />}
            </div>
          )}
        </aside>
      )}
    </>
  );
}
