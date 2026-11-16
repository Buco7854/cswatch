import { useId, useMemo } from 'react';
import { ChevronDown, Skull } from 'lucide-react';
import { locale, t } from '../i18n';
import type { Frame, Player, Position } from '../types';
import { equipmentKey, equipmentKind, equipmentName, utilityInventory } from '../equipment-display';
import EquipmentGlyph from './EquipmentGlyph';
import './broadcast-economy.css';

const known = (value: number | undefined) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
const number = (value: number | undefined) => known(value)?.toLocaleString(locale()) ?? '—';
const money = (value: number | undefined) =>
  known(value) === undefined ? '—' : '$' + number(value);
const yesNo = (value: boolean | undefined) => (value === undefined ? '—' : t(value ? 'Yes' : 'No'));
export type LoadoutMember = { player: Player; state: Position | undefined };

function UtilityInventory({ state }: { state: Position | undefined }) {
  const items = utilityInventory(state?.inventory);
  if (items === null)
    return (
      <span
        className="broadcast-unavailable"
        title={t('Inventory is unavailable at this moment.')}
        aria-label={t('Inventory is unavailable at this moment.')}
      >
        —
      </span>
    );
  if (!items.length)
    return (
      <span
        className="broadcast-no-utility"
        role="img"
        aria-label={t('No utility carried.')}
        title={t('No utility carried.')}
      >
        <EquipmentGlyph kind="he" />
        <span>0</span>
      </span>
    );
  return (
    <span className="broadcast-utility" aria-label={t('Utility inventory')}>
      {items.map((item) => (
        <span
          key={item.kind}
          className="broadcast-utility-item"
          role="img"
          aria-label={`${equipmentName(item.item)} ×${item.count}`}
          title={`${equipmentName(item.item)} ×${item.count}`}
        >
          <EquipmentGlyph kind={item.kind} />
          {item.count > 1 && <b className="num">{item.count}</b>}
        </span>
      ))}
    </span>
  );
}

function PlayerRow({
  member,
  selected,
  onSelect,
}: {
  member: LoadoutMember;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const { player, state } = member;
  const descriptionId = useId();
  const health = state ? known(state.health) : undefined;
  const bomb =
    state?.inventory?.some((item) => equipmentKind(item) === 'bomb') ||
    (state?.weapon && equipmentKind(state.weapon) === 'bomb');
  return (
    <li
      className={
        'broadcast-player' +
        (selected ? ' is-selected' : '') +
        (state && !state.alive ? ' is-out' : '')
      }
      data-player-id={player.id}
      data-health={health === undefined ? 'unknown' : health <= 25 ? 'low' : 'normal'}
    >
      <button
        type="button"
        className="broadcast-player-select"
        onClick={() => onSelect(player.id)}
        aria-label={t('Select player {{player}}', { player: player.name })}
        aria-describedby={descriptionId}
        aria-pressed={selected}
      >
        <span className="broadcast-player-heading">
          <strong className="broadcast-player-name" title={player.name}>
            {state && !state.alive && <Skull size={13} aria-hidden="true" />}
            {player.name}
          </strong>
          <span className="broadcast-health-value num" title={t('Health')}>
            {health === undefined ? (
              '—'
            ) : (
              <>
                {number(health)} <small className="visually-hidden">{t('HP')}</small>
              </>
            )}
          </span>
          <span className="broadcast-active-weapon">
            <span
              className="broadcast-weapon-identity"
              title={state?.weapon ? equipmentName(state.weapon) : undefined}
            >
              {state?.weapon ? (
                <>
                  <EquipmentGlyph item={state.weapon} />
                  <span className="visually-hidden">{equipmentName(state.weapon)}</span>
                </>
              ) : (
                <span className="broadcast-unavailable">{t('Weapon unavailable')}</span>
              )}
            </span>
            <span className="broadcast-ammo num" title={t('Ammo')}>
              {number(state?.ammo)}
              <span className="visually-hidden"> {t('Ammo')}</span>
            </span>
          </span>
        </span>
        <span className="broadcast-player-equipment">
          <span className="broadcast-cash num" title={t('Money')}>
            {money(state?.money)}
          </span>
          <UtilityInventory state={state} />
          <span className="broadcast-protection">
            <span
              className="broadcast-armor"
              role="img"
              aria-label={t('Armor: {{value}}', { value: number(state?.armor) })}
              title={t('Armor: {{value}}', { value: number(state?.armor) })}
            >
              <EquipmentGlyph kind="armor" />
              <span className="num">{number(state?.armor)}</span>
            </span>
            {state?.helmet === true && (
              <span role="img" aria-label={t('Helmet')} title={t('Helmet')}>
                <EquipmentGlyph kind="helmet" />
              </span>
            )}
            {state?.defuser === true && (
              <span role="img" aria-label={t('Defuse kit')} title={t('Defuse kit')}>
                <EquipmentGlyph kind="defuser" />
              </span>
            )}
            {bomb && (
              <span
                className="broadcast-bomb"
                role="img"
                aria-label={t('Carries C4')}
                title={t('Carries C4')}
              >
                <EquipmentGlyph kind="bomb" />
              </span>
            )}
          </span>
        </span>
        {!state && <span className="visually-hidden">{t('State unavailable')}</span>}
        {state && !state.alive && <span className="visually-hidden">{t('Out')}</span>}
        <span id={descriptionId} className="visually-hidden">
          {[
            `${t('Health')}: ${number(health)}`,
            `${t('Money')}: ${money(state?.money)}`,
            state?.weapon ? equipmentName(state.weapon) : t('Weapon unavailable'),
            `${t('Ammo')}: ${number(state?.ammo)}`,
            t('Armor: {{value}}', { value: number(state?.armor) }),
            state?.inventory === undefined
              ? t('Inventory is unavailable at this moment.')
              : `${t('Weapons and equipment')}: ${state.inventory.length ? state.inventory.map(equipmentName).join(', ') : t('No items carried at this moment.')}`,
          ].join('. ')}
        </span>
        <span className="broadcast-health-track" aria-hidden="true">
          <span style={{ width: `${health === undefined ? 0 : Math.min(100, health)}%` }} />
        </span>
      </button>
    </li>
  );
}

export function SelectedLoadout({ member }: { member: LoadoutMember }) {
  const { player, state } = member;
  const items = useMemo(() => {
    if (state?.inventory === undefined) return null;
    const counted = new Map<string, { item: string; count: number }>();
    for (const item of state.inventory) {
      const key = equipmentKey(item),
        previous = counted.get(key);
      if (previous) previous.count++;
      else counted.set(key, { item, count: 1 });
    }
    return [...counted.values()];
  }, [state?.inventory]);
  return (
    <details
      className="broadcast-loadout"
      onToggle={(event) => {
        if (event.currentTarget.open)
          event.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }}
    >
      <summary>
        <span>
          <span className="broadcast-loadout-label" title={t('Selected loadout')}>
            {t('Selected loadout')}
          </span>
          <strong title={player.name}>{player.name}</strong>
        </span>
        <ChevronDown size={14} />
      </summary>
      <div className="broadcast-loadout-body">
        <dl className="broadcast-loadout-values">
          <div>
            <dt>{t('Money')}</dt>
            <dd className="num">{money(state?.money)}</dd>
          </div>
          <div>
            <dt>{t('Equipment')}</dt>
            <dd className="num">{money(state?.equipmentValue)}</dd>
          </div>
          <div>
            <dt>{t('Round start money')}</dt>
            <dd className="num">{money(state?.startMoney)}</dd>
          </div>
          <div>
            <dt>{t('Spent this round')}</dt>
            <dd className="num">{money(state?.spentThisRound)}</dd>
          </div>
          <div>
            <dt>{t('Armor')}</dt>
            <dd className="num">{number(state?.armor)}</dd>
          </div>
          <div>
            <dt>{t('Helmet')}</dt>
            <dd>{yesNo(state?.helmet)}</dd>
          </div>
          <div>
            <dt>{t('Defuse kit')}</dt>
            <dd>{yesNo(state?.defuser)}</dd>
          </div>
          <div>
            <dt>{t('Scoped')}</dt>
            <dd>{yesNo(state?.scoped)}</dd>
          </div>
          <div>
            <dt>{t('Defusing')}</dt>
            <dd>{yesNo(state?.defusing)}</dd>
          </div>
        </dl>
        {items === null ? (
          <p>{t('Inventory is unavailable at this moment.')}</p>
        ) : items.length ? (
          <ul className="broadcast-inventory" aria-label={t('Weapons and equipment')}>
            {items.map(({ item, count }) => (
              <li key={equipmentKey(item)}>
                <EquipmentGlyph item={item} />
                <span>{equipmentName(item)}</span>
                <strong className="num">×{count}</strong>
              </li>
            ))}
          </ul>
        ) : (
          <p>{t('No items carried at this moment.')}</p>
        )}
        <p className="broadcast-availability-note">
          {t('A dash means this field was not recorded.')}
        </p>
      </div>
    </details>
  );
}

function TeamBank({
  team,
  members,
  selected,
  onSelect,
}: {
  team: 2 | 3;
  members: LoadoutMember[];
  selected: string;
  onSelect: (id: string) => void;
}) {
  const descriptionId = useId();
  const name = t(team === 3 ? 'Counter-terrorists' : 'Terrorists');
  const complete = members.every((member) => member.state !== undefined);
  const alive = members.filter((member) => member.state?.alive).length;
  return (
    <section
      className="broadcast-bank"
      data-team={team}
      aria-label={t('{{team}} live loadouts', { team: name })}
      aria-describedby={descriptionId}
    >
      <span id={descriptionId} className="visually-hidden">
        {complete
          ? t('{{alive}} / {{count}} alive', { alive, count: members.length })
          : t('State incomplete')}
      </span>
      {members.length ? (
        <ul className="broadcast-roster">
          {members.map((member) => (
            <PlayerRow
              key={member.player.id}
              member={member}
              selected={member.player.id === selected}
              onSelect={onSelect}
            />
          ))}
        </ul>
      ) : (
        <p className="broadcast-empty">{t('No recorded players on this side.')}</p>
      )}
    </section>
  );
}

/** One lineup stack on the picture's edge; full inventory is requested in Players. */
export default function MatchEconomy({
  players,
  frame,
  selected,
  onSelect,
}: {
  players: Player[];
  frame: Frame;
  selected: string;
  onSelect: (id: string) => void;
}) {
  const states = useMemo(
    () => new Map(frame.players.map((state) => [state.id, state])),
    [frame.players],
  );
  const teams = useMemo(() => {
    const grouped: Record<2 | 3, LoadoutMember[]> = { 2: [], 3: [] };
    for (const player of players) {
      const state = states.get(player.id),
        team = state?.team ?? player.team;
      if (team === 2 || team === 3) grouped[team].push({ player, state });
    }
    return grouped;
  }, [players, states]);
  return (
    <section className="broadcast-economy" aria-label={t('Economy and loadouts')}>
      <div className="broadcast-lineup-stack">
        <TeamBank team={3} members={teams[3]} selected={selected} onSelect={onSelect} />
        <TeamBank team={2} members={teams[2]} selected={selected} onSelect={onSelect} />
      </div>
    </section>
  );
}
