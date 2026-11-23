import {
  memo,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { ListVideo, X } from 'lucide-react';
import { useWorkspaceDialog } from '../context';
import { t } from '../i18n';
import type { Playback } from '../types';
import { roundEvents, type ReviewEvent, type ReviewRound } from '../review-events';
import { timelineGroups, timelinePosition, type TimelineWindow } from '../timeline';
import { ActionMenu, SelectControl, SwitchRow } from './Controls';
import { eventIcon, eventLabel } from './RoundEvents';
import './replay-timeline.css';

const clock = (seconds: number) => {
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
};

function TimelineOptionsDialog({ close, children }: { close: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useWorkspaceDialog(dialog);
  return (
    <dialog
      ref={dialog}
      className="options-dialog member-dialog timeline-options-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (event.target === dialog.current) close();
      }}
    >
      <div className="panel-heading">
        <h2 id={titleId}>{t('Timeline options')}</h2>
        <button
          type="button"
          className="icon-button"
          aria-label={t('Close timeline options')}
          onClick={close}
        >
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}

// A moving playhead only changes the slider and clock. Marker menus and their
// localized labels depend on the event window and the available track width.
const TimelineEvents = memo(function TimelineEvents({
  visible,
  start,
  end,
  width,
  first,
  rate,
  onSeek,
  slider,
}: {
  visible: ReviewEvent[];
  start: number;
  end: number;
  width: number;
  first: number;
  rate: number;
  onSeek: (tick: number) => void;
  slider: RefObject<HTMLInputElement | null>;
}) {
  useTranslation();
  const window = { start, end };
  const focused = useRef<string | null>(null);
  const groups = useMemo(
    () => timelineGroups(visible, { start, end }, width, 32),
    [visible, start, end, width],
  );
  useEffect(() => {
    if (focused.current && !groups.some((group) => group.id === focused.current)) {
      focused.current = null;
      slider.current?.focus({ preventScroll: true });
    }
  }, [groups]);
  return (
    <>
      <svg
        className="timeline-event-stems"
        viewBox="0 0 1000 44"
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
              .map((event) => `M${timelinePosition(event.tick, window) * 1000},18 V30`)
              .join(' ')}
          />
        ))}
      </svg>
      <div className="timeline-event-markers" aria-label={t('Timeline events')}>
        {groups.map((group) => {
          const event = group.events[0];
          const label =
            group.events.length === 1
              ? eventLabel(event, first, rate)
              : t('{{count}} events from {{start}} to {{end}}', {
                  count: group.events.length,
                  start: clock((event.tick - first) / rate),
                  end: clock((group.events.at(-1)!.tick - first) / rate),
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
              {eventIcon(event, 16)}
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
                label: eventLabel(member, first, rate),
                icon: eventIcon(member),
                onSelect: () => onSeek(member.tick),
              }))}
            />
          );
        })}
      </div>
    </>
  );
});

export default function ReplayTimeline({
  data,
  tick,
  first,
  last,
  round,
  selected,
  scope,
  onSeek,
  onReview,
  optionsOpen,
  onCloseOptions,
}: {
  data: Playback;
  tick: number;
  first: number;
  last: number;
  round: ReviewRound;
  selected: string;
  scope: 'match' | 'round';
  onSeek: (tick: number) => void;
  onReview: (trigger: HTMLButtonElement) => void;
  optionsOpen: boolean;
  onCloseOptions: () => void;
}) {
  const [players, setPlayers] = useState<'player' | 'all'>('player');
  const [utilities, setUtilities] = useState(false);
  const [width, setWidth] = useState(1000);
  const [dragWindow, setDragWindow] = useState<TimelineWindow | null>(null);
  const plot = useRef<HTMLDivElement>(null);
  const slider = useRef<HTMLInputElement>(null);
  const window =
    dragWindow ??
    (scope === 'round'
      ? { start: Math.max(first, round.start), end: Math.min(last, round.end) }
      : { start: first, end: last });
  const segments = useMemo(() => {
    const ordered = [...data.rounds].sort((a, b) => a.tick - b.tick);
    return ordered.flatMap((segment, index) => {
      const start = Math.max(window.start, segment.tick);
      const end = Math.min(window.end, ordered[index + 1]?.tick ?? last);
      if (end <= start) return [];
      return [
        {
          ...segment,
          start: timelinePosition(start, window),
          span: timelinePosition(end, window) - timelinePosition(start, window),
        },
      ];
    });
  }, [data.rounds, window.start, window.end, last]);
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
  const player = data.players.find((player) => player.id === selected);
  const currentRound = useMemo(
    () => (optionsOpen ? roundEvents(data, round, selected, 'player') : []),
    [data.events, data.players, data.sample, round.start, round.end, selected, optionsOpen],
  );
  const summary = optionsOpen
    ? t('{{player}}: {{kills}}, {{deaths}}', {
        player: player?.name || t('Selected player'),
        kills: t('review_kill_count', {
          count: currentRound.filter((event) => event.type === 'kill').length,
        }),
        deaths: t('review_death_count', {
          count: currentRound.filter((event) => event.type === 'death').length,
        }),
      })
    : undefined;
  useEffect(() => {
    const element = plot.current;
    if (!element) return;
    const update = () => setWidth(element.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const progress = timelinePosition(tick, window) * 100;
  return (
    <section className="replay-timeline" aria-label={t('Replay timeline')}>
      <div className="timeline-context">
        <span className="timeline-time num">{clock((tick - first) / data.tickRate)}</span>
        <span className="timeline-duration num">{clock((last - first) / data.tickRate)}</span>
      </div>
      {segments.length > 0 && (
        <div className="timeline-round-lane" role="group" aria-label={t('Round timeline')}>
          {segments.map((segment) => (
            <span
              key={segment.number}
              className="timeline-round-segment"
              data-winner={segment.winner}
              aria-current={round.number === segment.number ? 'step' : undefined}
              aria-label={t('Round {{round}}', { round: segment.number })}
              title={t('Round {{round}}', { round: segment.number })}
              style={{ left: `${segment.start * 100}%`, width: `${segment.span * 100}%` }}
            >
              {segment.span * width >= 15 ? segment.number : ''}
            </span>
          ))}
        </div>
      )}
      <div
        className={'replay-timeline-plot' + (!visible.length ? ' is-empty' : '')}
        ref={plot}
        style={{ '--timeline-progress': `${progress}%` } as CSSProperties}
      >
        <div className="timeline-track-line" aria-hidden="true">
          <i />
        </div>
        <TimelineEvents
          visible={visible}
          start={window.start}
          end={window.end}
          width={width}
          first={first}
          rate={data.tickRate}
          onSeek={onSeek}
          slider={slider}
        />
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
      {optionsOpen &&
        createPortal(
          <TimelineOptionsDialog close={onCloseOptions}>
            <div className="timeline-options-fields">
              {!!data.rounds.length && (
                <label className="timeline-options-field">
                  <span>{t('Round')}</span>
                  <SelectControl
                    label={t('Round')}
                    value={String(round.number)}
                    onValueChange={(value) => {
                      const target = data.rounds.find(({ number }) => number === Number(value));
                      if (target) {
                        onSeek(target.liveTick ?? target.tick);
                        onCloseOptions();
                      }
                    }}
                    options={data.rounds.map(({ number }) => ({
                      value: String(number),
                      label: t('Round {{round}}', { round: number }),
                    }))}
                  />
                </label>
              )}
              <label className="timeline-options-field">
                <span>{t('Event players')}</span>
                <SelectControl
                  label={t('Event players')}
                  value={players}
                  onValueChange={(value) => setPlayers(value as 'player' | 'all')}
                  options={[
                    { value: 'player', label: t('Selected player') },
                    { value: 'all', label: t('All players') },
                  ]}
                />
              </label>
              <SwitchRow
                label={t('Show utility throws')}
                checked={utilities}
                onChange={setUtilities}
              />
            </div>
            <p>{t('Bomb objectives remain visible for every player.')}</p>
            <button
              type="button"
              className="button timeline-options-review"
              title={summary}
              aria-label={t('Review round {{round}} events. {{summary}}', {
                round: round.number,
                summary,
              })}
              onClick={(event) => {
                event.currentTarget.closest('dialog')?.close();
                onCloseOptions();
                onReview(event.currentTarget);
              }}
            >
              <ListVideo size={16} />
              {t('Current round events')}
            </button>
          </TimelineOptionsDialog>,
          plot.current?.closest('.viewer-frame') ?? document.body,
        )}
      <p className="visually-hidden">
        {players === 'player'
          ? t('Selected player: {{player}}', { player: player?.name || '-' })
          : t('All players')}
        . {t('Bomb objectives remain visible for every player.')}
      </p>
    </section>
  );
}
