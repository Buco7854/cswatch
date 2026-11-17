import { useId, useMemo, type ReactNode } from 'react';
import type { Playback } from '../types';
import { buildMatchTimeline, matchAt, matchClock, MATCH_PHASE_LABELS } from '../match-stats';
import { locale, t } from '../i18n';
import ReviewEventGlyph from './ReviewEventGlyph';
import './match-score.css';

/** Side identity and scores come from recorded snapshots, never halftime arithmetic. */
export default function MatchScore({
  data,
  tick,
  onOpenScoreboard,
  hidden = false,
  chromeVisible = true,
  objective,
  objectiveCaption,
  objectiveDescription,
}: {
  data: Playback;
  tick: number;
  onOpenScoreboard?: () => void;
  hidden?: boolean;
  chromeVisible?: boolean;
  /** Recorded objective artwork/countdown replaces the ordinary clock only. */
  objective?: ReactNode;
  /** Recorded objective context occupies its own full-width row. */
  objectiveCaption?: ReactNode;
  /** Stable objective phase/context only; countdown values belong to the timer. */
  objectiveDescription?: string;
}) {
  const descriptionId = useId();
  const timeline = useMemo(() => buildMatchTimeline(data), [data.matchState, data.tickRate]);
  const view = matchAt(timeline, tick);
  const phase = view.phase ? t(MATCH_PHASE_LABELS[view.phase]) : t('Round state unavailable');
  const shortPhase = !view.phase
    ? t('Not recorded')
    : view.phase === 'timeout'
      ? t('Timeout')
      : view.phase === 'technical'
        ? t('Technical pause')
        : phase;
  const number = (value: number | undefined) => value?.toLocaleString(locale()) ?? '—';
  const clock = matchClock(view.remaining);
  const hasObjective = objective !== undefined && objective !== null && objective !== false;
  const hasCaption =
    objectiveCaption !== undefined && objectiveCaption !== null && objectiveCaption !== false;
  const description = [
    `${t('Counter-terrorists')}: ${number(view.ctScore)}`,
    `${t('Terrorists')}: ${number(view.tScore)}`,
    phase,
    t('Round {{round}}', { round: view.roundNumber ?? '—' }),
    objectiveDescription,
  ]
    .filter(Boolean)
    .join('. ');
  const content = (
    <>
      <span className="visually-hidden match-score-description" id={descriptionId}>
        {description}
      </span>
      <span className="match-score-body">
        <span className="match-score-side" data-team="3" title={t('Counter-terrorists')}>
          <span className="visually-hidden match-score-side-label">{t('Counter-terrorists')}</span>
          <ReviewEventGlyph event={{ type: 'round-end', team: 3 }} size={22} />
          <strong className="num" data-score="ct">
            {number(view.ctScore)}
          </strong>
        </span>
        <span
          className={'match-score-clock' + (hasObjective ? ' has-objective' : '')}
          role="timer"
          aria-live="off"
          aria-atomic="true"
        >
          {hasObjective ? (
            objective
          ) : (
            <>
              <span className="match-score-phase" title={phase}>
                {shortPhase}
              </span>
              <strong
                className="num"
                title={clock === undefined ? t('Clock not recorded') : undefined}
              >
                {clock ?? '—'}
              </strong>
              <span className="match-score-round">
                {t('Round {{round}}', { round: view.roundNumber ?? '—' })}
              </span>
            </>
          )}
        </span>
        <span className="match-score-side" data-team="2" title={t('Terrorists')}>
          <span className="visually-hidden match-score-side-label">{t('Terrorists')}</span>
          <strong className="num" data-score="t">
            {number(view.tScore)}
          </strong>
          <ReviewEventGlyph event={{ type: 'round-end', team: 2 }} size={22} />
        </span>
        {hasCaption && <span className="match-score-objective-caption">{objectiveCaption}</span>}
      </span>
    </>
  );
  const properties = {
    className: 'viewer-match-score match-score',
    hidden,
    inert: !chromeVisible,
    'data-viewer-chrome': true,
    'aria-hidden': !chromeVisible || hidden,
    'data-phase': view.phase || 'unknown',
    'data-recorded': view.recorded,
    'data-objective': hasObjective,
  };
  return onOpenScoreboard ? (
    <button
      {...properties}
      type="button"
      onClick={onOpenScoreboard}
      aria-label={t('Open scoreboard')}
      aria-describedby={descriptionId}
    >
      {content}
    </button>
  ) : (
    <div {...properties} role="group" aria-label={t('Match score')}>
      {content}
    </div>
  );
}
