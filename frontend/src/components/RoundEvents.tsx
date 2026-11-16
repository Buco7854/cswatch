import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Bomb,
  CheckCircle2,
  ChevronRight,
  Crosshair,
  Flag,
  Flame,
  Skull,
  Waypoints,
} from 'lucide-react';
import { t } from '../i18n';
import { roundEvents, type ReviewEvent, type ReviewRound } from '../review-events';
import type { Playback } from '../types';
import { equipmentLabel } from '../equipment-labels';
import { SelectControl } from './Controls';
import './round-events.css';

const clock = (seconds: number) => {
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
};
const eventIcon = (event: ReviewEvent, size = 16): ReactNode => {
  if (event.type === 'death') return <Skull size={size} />;
  if (event.type === 'plant') return <Bomb size={size} />;
  if (event.type === 'defuse') return <CheckCircle2 size={size} />;
  if (event.type === 'explosion') return <Flame size={size} />;
  if (event.type === 'round-end') return <Flag size={size} />;
  if (event.type === 'throw') return <Waypoints size={size} />;
  return <Crosshair size={size} />;
};
function eventTitle(event: ReviewEvent) {
  if (event.type === 'kill') return t('Kill');
  if (event.type === 'death') return t('Death');
  if (event.type === 'elimination') return t('Elimination');
  if (event.type === 'plant') return t('Bomb planted');
  if (event.type === 'defuse') return t('Bomb defused');
  if (event.type === 'explosion') return t('Bomb exploded');
  if (event.type === 'throw') return t('Utility thrown');
  return t('Round ended');
}
function eventDescription(event: ReviewEvent) {
  if (event.type === 'throw') {
    return t('{{player}} threw {{utility}}', {
      player: event.actor || t('a player'),
      utility: event.weapon ? equipmentLabel(event.weapon) : t('Utility'),
    });
  }
  if (['kill', 'death', 'elimination'].includes(event.type))
    return t('{{actor}} eliminated {{target}}', {
      actor: event.actor || t('World'),
      target: event.target || t('a player'),
    });
  if (event.type === 'plant' && event.actor)
    return t('Bomb planted by {{player}}', { player: event.actor });
  if (event.type === 'defuse' && event.actor)
    return t('Bomb defused by {{player}}', { player: event.actor });
  if (event.type === 'round-end' && [2, 3].includes(event.team ?? 0))
    return t('{{team}} won the round', {
      team: t(event.team === 3 ? 'Counter-terrorists' : 'Terrorists'),
    });
  return eventTitle(event);
}
function eventLabel(event: ReviewEvent, origin: number, rate: number) {
  return t('{{event}} at {{time}}', {
    event: eventDescription(event),
    time: clock((event.tick - origin) / rate),
  });
}

type ReplayEventsProps = {
  data: Playback;
  round: ReviewRound;
  tick: number;
  selected: string;
  onSeek: (tick: number) => void;
};

/** Chronological 44px markers never overlap, even when eliminations share a tick. */
export default function RoundEvents({
  data,
  round,
  tick,
  selected,
  onSeek,
  onReview,
}: ReplayEventsProps & { onReview: (trigger: HTMLButtonElement) => void }) {
  const events = useMemo(
    () => roundEvents(data, round, selected),
    [data, round.start, round.end, selected],
  );
  const player = data.players.find((player) => player.id === selected);
  const kills = events.filter((event) => event.type === 'kill').length;
  const deaths = events.filter((event) => event.type === 'death').length;
  const active = events.reduce(
    (previous, event, index) => (event.tick <= tick ? index : previous),
    -1,
  );
  const activeId = events[active]?.id;
  const track = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = track.current;
    const marker = container?.querySelector<HTMLElement>('[aria-current="step"]');
    if (!container || !marker) return;
    const left = marker.offsetLeft - (container.clientWidth - marker.offsetWidth) / 2;
    container.scrollTo({ left: Math.max(0, left), behavior: 'instant' });
  }, [activeId, round.number]);
  const summary = t('{{player}}: {{kills}}, {{deaths}}', {
    player: player?.name || t('Selected player'),
    kills: t('review_kill_count', { count: kills }),
    deaths: t('review_death_count', { count: deaths }),
  });
  return (
    <section className="round-events" aria-label={t('Current round events')}>
      <button
        className="round-events-heading"
        onClick={(event) => onReview(event.currentTarget)}
        aria-label={t('Review round {{round}} events. {{summary}}', {
          round: round.number,
          summary,
        })}
        title={summary}
      >
        <span className="round-events-heading-copy" aria-hidden="true">
          <strong>{t(data.rounds.length ? 'Round events' : 'Match events')}</strong>
          <small>
            <span className="round-events-player">{player?.name || t('Selected player')}</span>
            <span className="round-event-kills">
              <Crosshair size={12} />
              {kills}
            </span>
            <span className="round-event-deaths">
              <Skull size={12} />
              {deaths}
            </span>
          </small>
        </span>
        <ChevronRight size={14} aria-hidden="true" />
      </button>
      <div className="round-events-track" ref={track}>
        {events.length ? (
          events.map((event, index) => (
            <button
              key={event.id}
              className={`round-event-marker event-${event.type}${event.selected ? ' selected-player-event' : ''}${event.tick <= tick ? ' event-passed' : ''}`}
              aria-label={eventLabel(event, round.start, data.tickRate)}
              title={eventLabel(event, round.start, data.tickRate)}
              aria-current={index === active ? 'step' : undefined}
              onClick={() => onSeek(event.tick)}
            >
              <span className="round-event-icon" aria-hidden="true">
                {eventIcon(event)}
              </span>
              <span className="round-event-short-name">{eventTitle(event)}</span>
              <span className="round-event-time num">
                +{clock((event.tick - round.start) / data.tickRate)}
              </span>
            </button>
          ))
        ) : (
          <p className="round-events-empty">{t('No key events recorded in this round.')}</p>
        )}
      </div>
    </section>
  );
}

/** Drawer detail keeps every event accessible; long matches load progressively. */
export function RoundEventReview({
  data,
  round,
  tick,
  selected,
  first,
  last,
  onSeek,
}: ReplayEventsProps & { first: number; last: number }) {
  const [range, setRange] = useState<'round' | 'match'>(data.rounds.length ? 'round' : 'match');
  const [scope, setScope] = useState<'all' | 'player'>('player');
  const [limit, setLimit] = useState(100);
  const events = useMemo(
    () =>
      roundEvents(
        data,
        range === 'round' ? round : { number: 0, start: first, end: last },
        selected,
        scope,
      ),
    [
      data,
      range,
      range === 'round' ? round.start : first,
      range === 'round' ? round.end : last,
      selected,
      scope,
    ],
  );
  const roundNumber = range === 'round' ? round.number : 0;
  useEffect(() => setLimit(100), [range, scope, roundNumber, selected]);
  const player = data.players.find((player) => player.id === selected);
  const active = events.reduce(
    (previous, event, index) => (event.tick <= tick ? index : previous),
    -1,
  );
  return (
    <section className="round-event-review" aria-label={t('Event review')}>
      <div className="round-event-filters">
        <SelectControl
          label={t('Event range')}
          value={range}
          onValueChange={(value) => setRange(value as 'round' | 'match')}
          options={[
            { value: 'round', label: t('Current round'), disabled: !data.rounds.length },
            { value: 'match', label: t('All match') },
          ]}
        />
        <SelectControl
          label={t('Event players')}
          value={scope}
          onValueChange={(value) => setScope(value as 'all' | 'player')}
          options={[
            { value: 'player', label: t('Selected player') },
            { value: 'all', label: t('All players') },
          ]}
        />
      </div>
      <div className="round-event-review-context">
        <span>
          {range === 'round' ? t('Round {{round}}', { round: round.number }) : t('All match')}
        </span>
        <span>{t('review_event_count', { count: events.length })}</span>
      </div>
      {player && (
        <p className="round-event-following">
          {t('Selected player: {{player}}', { player: player.name })}
        </p>
      )}
      <div className="round-event-list">
        {events.length ? (
          events.slice(0, limit).map((event, index) => (
            <button
              key={event.id}
              className={`round-review-row event-${event.type}${event.selected ? ' selected-player-event' : ''}`}
              aria-label={eventLabel(event, first, data.tickRate)}
              aria-current={index === active ? 'step' : undefined}
              onClick={() => onSeek(event.tick)}
            >
              <span className="round-review-time num">
                {clock((event.tick - first) / data.tickRate)}
              </span>
              <span className="round-event-icon" aria-hidden="true">
                {eventIcon(event)}
              </span>
              <span className="round-review-copy">
                <strong>{eventDescription(event)}</strong>
                <small>
                  {eventTitle(event)}
                  {event.weapon && event.type !== 'throw'
                    ? ' · ' + event.weapon.replace('weapon_', '').replaceAll('_', ' ').toUpperCase()
                    : ''}
                  {event.headshot ? ' · ' + t('Headshot') : ''}
                </small>
              </span>
            </button>
          ))
        ) : (
          <p className="panel-empty">
            {t(
              'No matching events in this range. Bomb objectives remain visible for every player.',
            )}
          </p>
        )}
      </div>
      {events.length > limit && (
        <button
          className="button round-event-load-more"
          onClick={() => setLimit((value) => value + 100)}
        >
          {t('Load more events')}
        </button>
      )}
    </section>
  );
}
