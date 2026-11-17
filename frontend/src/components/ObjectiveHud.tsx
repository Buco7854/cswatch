import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import EquipmentGlyph from './EquipmentGlyph';
import ReviewEventGlyph from './ReviewEventGlyph';
import type { ObjectiveMeter, ObjectiveView } from '../objective-state';
import { locale, t } from '../i18n';
import './objective-hud.css';

function phaseLabel(phase: ObjectiveView['phase']) {
  return t(
    {
      planting: 'Planting',
      planted: 'Bomb planted',
      defusing: 'Defusing',
      defused: 'Bomb defused',
      exploded: 'Bomb exploded',
      'plant-aborted': 'Plant interrupted',
      'defuse-aborted': 'Defuse interrupted',
    }[phase],
  );
}

/** Stable accessible description: lifecycle and actor, never per-frame seconds. */
export function objectiveDescription(value: ObjectiveView) {
  return [
    phaseLabel(value.phase),
    value.name,
    value.site !== undefined
      ? t('Bombsite {{site}}', { site: value.site === 0 ? 'A' : 'B' })
      : undefined,
    value.kit !== undefined ? t(value.kit ? 'Defuse kit' : 'No defuse kit') : undefined,
  ]
    .filter(Boolean)
    .join(', ');
}

/** Register the empty region before announcing, including a replay that opens
 * mid-objective. Cancel obsolete notices when seeking or leaving the viewer. */
export function ObjectiveAnnouncement({ message }: { message: string }) {
  const [announced, setAnnounced] = useState('');
  useEffect(() => {
    const pending = window.setTimeout(() => setAnnounced(message), 0);
    return () => window.clearTimeout(pending);
  }, [message]);
  return (
    <span className="visually-hidden" role="status" aria-atomic="true">
      {announced}
    </span>
  );
}

function Seconds({ value }: { value: ObjectiveMeter }) {
  const seconds = value.remaining ?? value.elapsed;
  const formatted = seconds?.toLocaleString(locale(), {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  return (
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
  );
}

/** One small caption under the score tracks, never a second objective card. */
export function ObjectiveContext({ value }: { value: ObjectiveView }) {
  return (
    <span className="objective-context">
      <span className="objective-phase">{phaseLabel(value.phase)}</span>
      {value.name && <span className="objective-player">{value.name}</span>}
      {value.site !== undefined && (
        <span>{t('Bombsite {{site}}', { site: value.site === 0 ? 'A' : 'B' })}</span>
      )}
      {value.kit !== undefined && <span>{t(value.kit ? 'Defuse kit' : 'No defuse kit')}</span>}
    </span>
  );
}

/** Native objective emblem and recorded progress/countdown in the score centre.
 * Unknown deadlines do not draw fake progress or synthesize a finish. */
export default function ObjectiveHud({
  value,
  variant = 'floating',
}: {
  value: ObjectiveView;
  variant?: 'score' | 'floating';
}) {
  const { phase } = value;
  const terminal = phase === 'defused' || phase === 'exploded';
  const interrupted = phase === 'plant-aborted' || phase === 'defuse-aborted';
  const showTimer = !terminal && !interrupted;
  const progress = showTimer ? value.meter.progress : undefined;
  const Element = variant === 'score' ? 'span' : 'aside';
  return (
    <Element
      className={`objective-hud objective-hud-${variant}`}
      data-phase={phase}
      role={variant === 'score' ? 'group' : undefined}
      aria-label={t('Bomb objective')}
    >
      <span className="objective-emblem" title={phaseLabel(phase)}>
        {showTimer && (
          <svg
            className={'objective-progress' + (progress === undefined ? ' is-unknown' : '')}
            viewBox="0 0 40 40"
            aria-hidden="true"
          >
            <circle className="objective-progress-track" cx="20" cy="20" r="18" />
            {progress !== undefined && (
              <circle
                className="objective-progress-value"
                cx="20"
                cy="20"
                r="18"
                pathLength="1"
                strokeDasharray="1"
                strokeDashoffset={phase === 'planted' ? progress : 1 - progress}
              />
            )}
          </svg>
        )}
        {interrupted ? (
          <X size={18} aria-hidden="true" />
        ) : terminal || phase === 'planted' ? (
          <ReviewEventGlyph
            event={{
              type: phase === 'defused' ? 'defuse' : phase === 'exploded' ? 'explosion' : 'plant',
            }}
            size={18}
          />
        ) : (
          <EquipmentGlyph item={phase === 'defusing' ? 'defuser' : 'c4'} />
        )}
      </span>
      {showTimer && (
        <span
          className="objective-clock"
          aria-label={t(
            phase === 'planted'
              ? 'Bomb timer'
              : phase === 'defusing'
                ? 'Defuse progress'
                : 'Plant progress',
          )}
        >
          <Seconds value={value.meter} />
        </span>
      )}
      {value.fuse && (
        <span className="objective-fuse-clock" aria-label={t('Bomb timer')}>
          <EquipmentGlyph item="c4" />
          <Seconds value={value.fuse} />
        </span>
      )}
      {variant === 'floating' && <ObjectiveContext value={value} />}
    </Element>
  );
}
