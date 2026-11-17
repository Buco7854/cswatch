import { useId, useMemo } from 'react';
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
}: {
  data: Playback;
  tick: number;
  onOpenScoreboard?: () => void;
  hidden?: boolean;
  chromeVisible?: boolean;
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
  const content = (
    <span className="match-score-body" id={descriptionId}>
      <span className="match-score-side" data-team="3">
        <ReviewEventGlyph event={{ type: 'round-end', team: 3 }} size={23} />
        <span className="match-score-side-label" title={t('Counter-terrorists')}>
          CT
        </span>
        <strong className="num" data-score="ct">
          {number(view.ctScore)}
        </strong>
      </span>
      <span className="match-score-clock">
        <span className="match-score-phase" title={phase}>
          {shortPhase}
        </span>
        <strong className="num" title={clock === undefined ? t('Clock not recorded') : undefined}>
          {clock ?? '—'}
        </strong>
        <span className="match-score-round">
          {t('Round {{round}}', { round: view.roundNumber ?? '—' })}
        </span>
      </span>
      <span className="match-score-side" data-team="2">
        <strong className="num" data-score="t">
          {number(view.tScore)}
        </strong>
        <span className="match-score-side-label" title={t('Terrorists')}>
          T
        </span>
        <ReviewEventGlyph event={{ type: 'round-end', team: 2 }} size={23} />
      </span>
    </span>
  );
  const properties = {
    className: 'viewer-match-score match-score',
    hidden,
    inert: !chromeVisible,
    'data-viewer-chrome': true,
    'aria-hidden': !chromeVisible || hidden,
    'data-phase': view.phase || 'unknown',
    'data-recorded': view.recorded,
    'aria-live': 'off' as const,
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
