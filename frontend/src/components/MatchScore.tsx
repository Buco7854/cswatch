import { memo, useId, useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { Frame, Playback } from '../types';
import { buildMatchTimeline, matchAt, matchClock, MATCH_PHASE_LABELS } from '../match-stats';
import { locale, t } from '../i18n';
import ReviewEventGlyph from './ReviewEventGlyph';
import './match-score.css';

type ScoreControls = {
  onOpenScoreboard?: () => void;
  hidden?: boolean;
  chromeVisible?: boolean;
  objective?: ReactNode;
  objectiveCaption?: ReactNode;
  objectiveDescription?: string;
};

/** Side identity and scores come from recorded snapshots, never halftime arithmetic. */
export default function MatchScore({
  data,
  frame,
  tick,
  ...controls
}: ScoreControls & {
  data: Playback;
  frame?: Frame;
  tick: number;
}) {
  const timeline = useMemo(() => buildMatchTimeline(data), [data.matchState, data.tickRate]);
  const view = matchAt(timeline, tick);
  const [ctAlive, tAlive] = useMemo(() => {
    const positions = new Map(frame?.players.map((player) => [player.id, player]));
    return [3, 2].map((team) => {
      const side = data.players.filter(
        (player) => (positions.get(player.id)?.team ?? player.team) === team,
      );
      return side.length && side.every((player) => positions.has(player.id))
        ? side.filter((player) => positions.get(player.id)?.alive).length
        : undefined;
    });
  }, [data.players, frame?.players]);
  return (
    <ScoreDisplay
      ctScore={view.ctScore}
      tScore={view.tScore}
      ctAlive={ctAlive}
      tAlive={tAlive}
      phase={view.phase}
      recorded={view.recorded}
      clock={matchClock(view.remaining)}
      round={view.roundNumber ?? data.rounds.filter((round) => round.tick <= tick).at(-1)?.number}
      {...controls}
    />
  );
}

const ScoreDisplay = memo(function ScoreDisplay({
  ctScore,
  tScore,
  ctAlive,
  tAlive,
  phase: phaseId,
  recorded,
  clock,
  round,
  onOpenScoreboard,
  hidden = false,
  chromeVisible = true,
  objective,
  objectiveCaption,
  objectiveDescription,
}: ScoreControls & {
  ctScore?: number;
  tScore?: number;
  ctAlive?: number;
  tAlive?: number;
  phase: ReturnType<typeof matchAt>['phase'];
  recorded: boolean;
  clock?: string;
  round?: number;
}) {
  useTranslation();
  const descriptionId = useId();
  const phase = phaseId ? t(MATCH_PHASE_LABELS[phaseId]) : t('Round state unavailable');
  const shortPhase = !phaseId
    ? t('Not recorded')
    : phaseId === 'timeout'
      ? t('Timeout')
      : phaseId === 'technical'
        ? t('Technical pause')
        : phase;
  const number = (value: number | undefined) => value?.toLocaleString(locale()) ?? '-';
  const hasObjective = objective !== undefined && objective !== null && objective !== false;
  const hasCaption =
    objectiveCaption !== undefined && objectiveCaption !== null && objectiveCaption !== false;
  const ct = ctAlive === undefined ? '–' : number(ctAlive);
  const tr = tAlive === undefined ? '–' : number(tAlive);
  const description = [
    `${t('Counter-terrorists')}: ${number(ctScore)}`,
    `${t('Terrorists')}: ${number(tScore)}`,
    t('Alive CT {{ct}}, T {{t}}', { ct, t: tr }),
    phase,
    t('Round {{round}}', { round: round ?? '-' }),
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
            {number(ctScore)}
          </strong>
          <span className="match-score-alive num" title={t('Alive: {{count}}', { count: ct })}>
            {ct} <span aria-hidden="true">●</span>
          </span>
        </span>
        <span
          className={'match-score-clock' + (hasObjective ? ' has-objective' : '')}
          role="timer"
          aria-live="off"
          aria-atomic="true"
        >
          {hasObjective ? (
            <>
              {objective}
              <span className="match-score-round">
                {t('Round {{round}}', { round: round ?? '-' })}
              </span>
            </>
          ) : (
            <>
              <span className="match-score-phase" title={phase}>
                {shortPhase}
              </span>
              <strong
                className="num"
                title={clock === undefined ? t('Clock not recorded') : undefined}
              >
                {clock ?? '-'}
              </strong>
              <span className="match-score-round">
                {t('Round {{round}}', { round: round ?? '-' })}
              </span>
            </>
          )}
        </span>
        <span className="match-score-side" data-team="2" title={t('Terrorists')}>
          <span className="visually-hidden match-score-side-label">{t('Terrorists')}</span>
          <span className="match-score-alive num" title={t('Alive: {{count}}', { count: tr })}>
            <span aria-hidden="true">●</span> {tr}
          </span>
          <strong className="num" data-score="t">
            {number(tScore)}
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
    'data-phase': phaseId || 'unknown',
    'data-recorded': recorded,
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
});
