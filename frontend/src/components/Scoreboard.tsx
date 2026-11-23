import { useId, useMemo, useRef } from 'react';
import { X } from 'lucide-react';
import { useWorkspaceDialog } from '../context';
import type { Frame, Playback } from '../types';
import {
  buildMatchStats,
  buildMatchTimeline,
  matchAt,
  matchClock,
  matchStatsAt,
  MATCH_PHASE_LABELS,
  type MatchStatsRow,
} from '../match-stats';
import { locale, t } from '../i18n';
import ReviewEventGlyph from './ReviewEventGlyph';
import './scoreboard.css';

const number = (value: number | undefined) =>
  value !== undefined && Number.isFinite(value) && value >= 0 && value <= 1e9
    ? value.toLocaleString(locale(), { maximumFractionDigits: 0 })
    : '-';
function Stat({ value, suffix = '' }: { value: number | undefined; suffix?: string }) {
  return (
    <span title={value === undefined ? t('Not recorded') : undefined}>
      {number(value)}
      {value === undefined ? '' : suffix}
    </span>
  );
}

function TeamTable({
  side,
  score,
  rows,
  selected,
  onSelect,
}: {
  side?: 2 | 3;
  score?: number;
  rows: MatchStatsRow[];
  selected: string;
  onSelect: (id: string) => void;
}) {
  const name = t(
    side === 3 ? 'Counter-terrorists' : side === 2 ? 'Terrorists' : 'Side unavailable',
  );
  return (
    <section className="scoreboard-team" data-team={side || 'unknown'} aria-label={name}>
      <div className="scoreboard-team-heading">
        <h3>
          {side && <ReviewEventGlyph event={{ type: 'round-end', team: side }} size={20} />}
          {name}
        </h3>
        {side && (
          <strong className="num">
            {number(score)}
            <span className="visually-hidden"> {t('Rounds won')}</span>
          </strong>
        )}
      </div>
      <div
        className="scoreboard-table-viewport"
        tabIndex={0}
        role="region"
        aria-label={t('{{team}} statistics', { team: name })}
      >
        <table>
          <thead>
            <tr>
              <th scope="col">{t('Player')}</th>
              <th scope="col">
                <abbr title={t('Kills')}>K</abbr>
              </th>
              <th scope="col">
                <abbr title={t('Deaths')}>D</abbr>
              </th>
              <th scope="col">
                <abbr title={t('Assists')}>A</abbr>
              </th>
              <th scope="col">
                <abbr title={t('Headshot percentage')}>HS%</abbr>
              </th>
              <th scope="col">{t('Damage')}</th>
              <th scope="col">{t('Money')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ player, state, stats, source }) => (
              <tr
                key={player.id}
                data-player-id={player.id}
                data-stats-source={source}
                className={selected === player.id ? 'is-selected' : ''}
              >
                <th scope="row">
                  <button
                    type="button"
                    className="scoreboard-select-player"
                    aria-pressed={selected === player.id}
                    onClick={() => onSelect(player.id)}
                    aria-label={t('Select player {{player}}', { player: player.name })}
                  >
                    {state && !state.alive && (
                      <ReviewEventGlyph event={{ type: 'death' }} size={14} />
                    )}
                    <span title={player.name}>{player.name}</span>
                    {state && !state.alive && <span className="visually-hidden">{t('Out')}</span>}
                  </button>
                </th>
                <td data-stat="kills">
                  <Stat value={stats.kills} />
                </td>
                <td data-stat="deaths">
                  <Stat value={stats.deaths} />
                </td>
                <td data-stat="assists">
                  <Stat value={stats.assists} />
                </td>
                <td data-stat="headshots">
                  <Stat value={stats.headshotPercent} suffix="%" />
                </td>
                <td data-stat="damage">
                  <Stat value={stats.damage} />
                </td>
                <td data-stat="money">
                  {number(state?.money) === '-' ? (
                    <Stat value={undefined} />
                  ) : (
                    '$' + number(state?.money)
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Native modal; Viewer owns opening shortcuts, close state and opener restoration. */
export default function Scoreboard({
  data,
  frame,
  tick,
  selected,
  onSelect,
  close,
  buffering = false,
}: {
  data: Playback;
  frame: Frame;
  tick: number;
  selected: string;
  onSelect: (id: string) => void;
  close: () => void;
  buffering?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  useWorkspaceDialog(dialog);
  const index = useMemo(() => buildMatchStats(data), [data.players]);
  const timeline = useMemo(() => buildMatchTimeline(data), [data.matchState, data.tickRate]);
  const match = matchAt(timeline, tick);
  const rows = matchStatsAt(index, tick, frame);
  return (
    <dialog
      ref={dialog}
      className="scoreboard-dialog"
      data-buffering={buffering}
      aria-labelledby={headingId}
      onCancel={close}
      onClick={(event) => {
        if (event.target === dialog.current) close();
      }}
    >
      <header className="scoreboard-heading">
        <div>
          <h2 id={headingId}>{t('Scoreboard')}</h2>
          <p>
            {match.roundNumber !== undefined && (
              <span>{t('Round {{round}}', { round: match.roundNumber })}</span>
            )}
            {match.phase && <span>{t(MATCH_PHASE_LABELS[match.phase])}</span>}
            <span className="num">{matchClock(match.remaining) ?? '-'}</span>
          </p>
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={close}
          aria-label={t('Close scoreboard')}
        >
          <X size={20} />
        </button>
      </header>
      <div className="scoreboard-content">
        {buffering ? (
          <p role="status">{t('Loading this moment…')}</p>
        ) : (
          <>
            {rows.length > 0 && (
              <p className="scoreboard-scroll-note">
                {t('Scroll horizontally to see all statistics.')}
              </p>
            )}
            {[3, 2, undefined].map((side) => {
              const members = rows.filter((row) => row.side === side);
              return members.length ? (
                <TeamTable
                  key={side || 'unknown'}
                  side={side as 2 | 3 | undefined}
                  score={side === 3 ? match.ctScore : side === 2 ? match.tScore : undefined}
                  rows={members}
                  selected={selected}
                  onSelect={onSelect}
                />
              ) : null;
            })}
            {!rows.length && <p>{t('No players were recorded.')}</p>}
          </>
        )}
      </div>
      <footer className="scoreboard-footer">
        <p>
          {t(
            data.sample
              ? 'Interactive sample · original scene & synthetic data'
              : 'Match totals use recorded player counters. A dash means unavailable data.',
          )}
        </p>
        <span>{t('Esc to close')}</span>
      </footer>
    </dialog>
  );
}
