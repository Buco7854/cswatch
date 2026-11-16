import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { t } from '../i18n';
import { roundEvents, type ReviewEvent, type ReviewRound } from '../review-events';
import type { Playback } from '../types';
import { equipmentLabel } from '../equipment-labels';
import { SelectControl } from './Controls';
import ReviewEventGlyph from './ReviewEventGlyph';
import './round-events.css';

const clock = (seconds: number) => {
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
};
export const eventIcon = (event: ReviewEvent, size = 16): ReactNode => (
  <ReviewEventGlyph event={event} size={size} />
);
export function eventTitle(event: ReviewEvent) {
  if (event.type === 'kill') return t('Kill');
  if (event.type === 'death') return t('Death');
  if (event.type === 'elimination') return t('Elimination');
  if (event.type === 'plant') return t('Bomb planted');
  if (event.type === 'defuse') return t('Bomb defused');
  if (event.type === 'explosion') return t('Bomb exploded');
  if (event.type === 'throw') return t('Utility thrown');
  return t('Round ended');
}
export function eventDescription(event: ReviewEvent) {
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
export function eventLabel(event: ReviewEvent, origin: number, rate: number) {
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
                  {event.headshot ? (
                    <>
                      {' · '}
                      <ReviewEventGlyph event={event} detail="headshot" size={12} /> {t('Headshot')}
                    </>
                  ) : null}
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
