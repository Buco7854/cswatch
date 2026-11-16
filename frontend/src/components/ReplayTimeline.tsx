import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Check, ListFilter, ListVideo } from 'lucide-react';
import { t } from '../i18n';
import type { Playback } from '../types';
import { roundEvents, type ReviewRound } from '../review-events';
import { timelineGroups, timelinePosition, type TimelineWindow } from '../timeline';
import { ActionMenu, SelectControl } from './Controls';
import { eventIcon, eventLabel } from './RoundEvents';
import './replay-timeline.css';

const clock = (seconds: number) => {
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
};

export default function ReplayTimeline({
  data,
  tick,
  first,
  last,
  round,
  selected,
  onSeek,
  onReview,
}: {
  data: Playback;
  tick: number;
  first: number;
  last: number;
  round: ReviewRound;
  selected: string;
  onSeek: (tick: number) => void;
  onReview: (trigger: HTMLButtonElement) => void;
}) {
  const [scope, setScope] = useState('match');
  const [players, setPlayers] = useState<'player' | 'all'>('player');
  const [utilities, setUtilities] = useState(false);
  const [width, setWidth] = useState(1000);
  const [dragWindow, setDragWindow] = useState<TimelineWindow | null>(null);
  const plot = useRef<HTMLDivElement>(null);
  const slider = useRef<HTMLInputElement>(null);
  const focused = useRef<string | null>(null);
  const window =
    dragWindow ??
    (scope === 'round'
      ? { start: Math.max(first, round.start), end: Math.min(last, round.end) }
      : { start: first, end: last });
  const events = useMemo(
    () =>
      roundEvents(data, { number: 0, start: first, end: last }, selected, players).filter(
        (event) => utilities || event.type !== 'throw',
      ),
    [data.events, data.players, data.sample, first, last, selected, players, utilities],
  );
  const visible = useMemo(
    () => events.filter((event) => event.tick >= window.start && event.tick <= window.end),
    [events, window.start, window.end],
  );
  const groups = useMemo(
    () => timelineGroups(visible, window, width),
    [visible, window.start, window.end, width],
  );
  const player = data.players.find((player) => player.id === selected);
  const currentRound = useMemo(
    () => roundEvents(data, round, selected, 'player'),
    [data.events, data.players, data.sample, round.start, round.end, selected],
  );
  const summary = t('{{player}}: {{kills}}, {{deaths}}', {
    player: player?.name || t('Selected player'),
    kills: t('review_kill_count', {
      count: currentRound.filter((event) => event.type === 'kill').length,
    }),
    deaths: t('review_death_count', {
      count: currentRound.filter((event) => event.type === 'death').length,
    }),
  });
  useEffect(() => {
    const element = plot.current;
    if (!element) return;
    const update = () => setWidth(element.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (focused.current && !groups.some((group) => group.id === focused.current)) {
      focused.current = null;
      slider.current?.focus({ preventScroll: true });
    }
  }, [groups]);
  const progress = timelinePosition(tick, window) * 100;
  return (
    <section className="replay-timeline" aria-label={t('Replay timeline')}>
      <div className="timeline-context">
        <span className="timeline-time num">{clock((tick - first) / data.tickRate)}</span>
        <SelectControl
          label={t('Timeline range')}
          className="timeline-scope"
          value={scope}
          displayValue={
            scope === 'round' ? t('Round {{round}}', { round: round.number }) : t('All match')
          }
          onValueChange={setScope}
          options={[
            { value: 'match', label: t('All match') },
            { value: 'round', label: t('Current round'), disabled: !data.rounds.length },
          ]}
        />
        <ActionMenu
          label={t('Timeline events')}
          heading={players === 'player' ? player?.name || t('Selected player') : t('All players')}
          trigger={
            <button
              className="timeline-filter icon-button"
              aria-label={t('Timeline events')}
              title={
                players === 'player'
                  ? t('Selected player: {{player}}', { player: player?.name || '—' })
                  : t('All players')
              }
            >
              <ListFilter size={16} />
              <span className="timeline-player-name">
                {players === 'player' ? player?.name || t('Selected player') : t('All players')}
              </span>
            </button>
          }
          items={[
            {
              id: 'player',
              label: t('Selected player'),
              icon: players === 'player' ? <Check size={14} /> : undefined,
              onSelect: () => setPlayers('player'),
            },
            {
              id: 'all',
              label: t('All players'),
              icon: players === 'all' ? <Check size={14} /> : undefined,
              onSelect: () => setPlayers('all'),
            },
            {
              id: 'utility',
              separatorBefore: true,
              label: t(utilities ? 'Hide utility throws' : 'Show utility throws'),
              onSelect: () => setUtilities((value) => !value),
            },
          ]}
        />
        <button
          className="timeline-review icon-button"
          title={summary}
          aria-label={t('Review round {{round}} events. {{summary}}', {
            round: round.number,
            summary,
          })}
          onClick={(event) => onReview(event.currentTarget)}
        >
          <ListVideo size={16} />
        </button>
        <span className="timeline-duration num">{clock((last - first) / data.tickRate)}</span>
      </div>
      <div
        className={'replay-timeline-plot' + (!visible.length ? ' is-empty' : '')}
        ref={plot}
        style={{ '--timeline-progress': `${progress}%` } as CSSProperties}
      >
        <div className="timeline-track-line" aria-hidden="true">
          <i />
        </div>
        <svg
          className="timeline-event-stems"
          viewBox="0 0 1000 88"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {(['kill', 'death', 'objective'] as const).map((type) => (
            <path
              key={type}
              className={'timeline-stem-' + type}
              d={visible
                .filter((event) =>
                  type === 'objective'
                    ? !['kill', 'death'].includes(event.type)
                    : event.type === type,
                )
                .map((event) => `M${timelinePosition(event.tick, window) * 1000},26 V66`)
                .join(' ')}
            />
          ))}
        </svg>
        <div className="timeline-event-markers" aria-label={t('Timeline events')}>
          {groups.map((group) => {
            const event = group.events[0];
            const label =
              group.events.length === 1
                ? eventLabel(event, first, data.tickRate)
                : t('{{count}} events from {{start}} to {{end}}', {
                    count: group.events.length,
                    start: clock((event.tick - first) / data.tickRate),
                    end: clock((group.events.at(-1)!.tick - first) / data.tickRate),
                  });
            const trigger = (
              <button
                key={group.id}
                className={`timeline-event-marker event-${event.type}${group.events.length > 1 ? ' is-cluster' : ''}`}
                style={{ left: `${group.anchor * 100}%` }}
                data-tick={event.tick}
                aria-label={label}
                title={label}
                onFocus={() => {
                  focused.current = group.id;
                }}
                onBlur={() => {
                  focused.current = null;
                }}
                onClick={group.events.length === 1 ? () => onSeek(event.tick) : undefined}
              >
                {eventIcon(event, 15)}
                {group.events.length > 1 && (
                  <span className="timeline-cluster-count">{group.events.length}</span>
                )}
              </button>
            );
            return group.events.length === 1 ? (
              trigger
            ) : (
              <ActionMenu
                key={group.id}
                label={label}
                heading={t('Recorded events')}
                trigger={trigger}
                items={group.events.map((member) => ({
                  id: member.id,
                  label: eventLabel(member, first, data.tickRate),
                  icon: eventIcon(member),
                  onSelect: () => onSeek(member.tick),
                }))}
              />
            );
          })}
        </div>
        <input
          ref={slider}
          className="timeline-slider"
          aria-label={t('Playback position')}
          aria-valuetext={t('{{time}} of {{duration}}', {
            time: clock((tick - first) / data.tickRate),
            duration: clock((last - first) / data.tickRate),
          })}
          type="range"
          min={window.start}
          max={window.end}
          step={1}
          value={Math.round(Math.max(window.start, Math.min(window.end, tick)))}
          onPointerDown={() => {
            setDragWindow(window);
            onSeek(tick);
          }}
          onPointerUp={() => setDragWindow(null)}
          onPointerCancel={() => setDragWindow(null)}
          onBlur={() => setDragWindow(null)}
          onChange={(event) => onSeek(Number(event.target.value))}
        />
        {!visible.length && (
          <span className="timeline-no-events" title={t('No key events recorded in this range.')}>
            {t('No key events recorded in this range.')}
          </span>
        )}
      </div>
      <p className="visually-hidden">
        {players === 'player'
          ? t('Selected player: {{player}}', { player: player?.name || '—' })
          : t('All players')}
        . {t('Bomb objectives remain visible for every player.')}
      </p>
    </section>
  );
}
