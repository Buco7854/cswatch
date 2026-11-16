import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Users, X } from 'lucide-react';
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
type Member = { player: Player; state: Position | undefined };

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
  compact = false,
}: {
  member: Member;
  selected: boolean;
  onSelect: (id: string) => void;
  compact?: boolean;
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
        (compact ? 'broadcast-compact-player' : 'broadcast-player') +
        (selected ? ' is-selected' : '') +
        (state && !state.alive ? ' is-out' : '')
      }
      data-player-id={player.id}
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
            {player.name}
          </strong>
          <span className="broadcast-health-value num" title={t('Health')}>
            {health === undefined ? '—' : `${number(health)} ${t('HP')}`}
          </span>
          <span className="broadcast-cash num" title={t('Money')}>
            {money(state?.money)}
          </span>
        </span>
        <span className="broadcast-active-weapon">
          <span className="broadcast-weapon-identity">
            {state?.weapon ? (
              <>
                <EquipmentGlyph item={state.weapon} />
                <span title={equipmentName(state.weapon)}>{equipmentName(state.weapon)}</span>
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
        <span className="broadcast-player-equipment">
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

function SelectedLoadout({ member }: { member: Member }) {
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
  members: Member[];
  selected: string;
  onSelect: (id: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const name = t(team === 3 ? 'Counter-terrorists' : 'Terrorists');
  const selectedMember = members.find((member) => member.player.id === selected);
  const complete = members.every((member) => member.state !== undefined);
  const alive = members.filter((member) => member.state?.alive).length;
  return (
    <section
      className={'broadcast-bank' + (collapsed ? ' is-collapsed' : '')}
      data-team={team}
      aria-label={t('{{team}} live loadouts', { team: name })}
    >
      <header className="broadcast-bank-heading">
        <div>
          <strong className="broadcast-team-code">{team === 3 ? 'CT' : 'T'}</strong>
          <span className="broadcast-team-name">
            {name}
            <small>
              {complete
                ? t('{{alive}} / {{count}} alive', { alive, count: members.length })
                : t('State incomplete')}
            </small>
          </span>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label={t(collapsed ? 'Expand {{team}} loadouts' : 'Collapse {{team}} loadouts', {
            team: name,
          })}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
        >
          {collapsed ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>
      </header>
      {!collapsed && (
        <div className="broadcast-bank-content">
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
          {selectedMember ? (
            <SelectedLoadout member={selectedMember} />
          ) : (
            <p className="broadcast-select-hint">{t('Select a player')}</p>
          )}
        </div>
      )}
    </section>
  );
}

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
  const selectedTeam =
    states.get(selected)?.team ?? players.find((player) => player.id === selected)?.team;
  const [activeTeam, setActiveTeam] = useState<2 | 3>(selectedTeam === 2 ? 2 : 3);
  const [lineupsOpen, setLineupsOpen] = useState(false);
  const openLineups = useRef<HTMLButtonElement>(null);
  const closeLineups = useRef<HTMLButtonElement>(null);
  const previousLineupsOpen = useRef(lineupsOpen);
  const selectedPlayer = players.find((player) => player.id === selected);
  useEffect(() => {
    if (previousLineupsOpen.current !== lineupsOpen) {
      (lineupsOpen ? closeLineups : openLineups).current?.focus({ preventScroll: true });
      previousLineupsOpen.current = lineupsOpen;
    }
  }, [lineupsOpen]);
  useEffect(() => {
    if (selectedTeam === 2 || selectedTeam === 3) setActiveTeam(selectedTeam);
  }, [selected, selectedTeam]);
  const teams = useMemo(() => {
    const grouped: Record<2 | 3, Member[]> = { 2: [], 3: [] };
    for (const player of players) {
      const state = states.get(player.id),
        team = state?.team ?? player.team;
      if (team === 2 || team === 3) grouped[team].push({ player, state });
    }
    return grouped;
  }, [players, states]);
  return (
    <section
      className={'broadcast-economy' + (lineupsOpen ? ' is-lineups-open' : '')}
      data-active-team={activeTeam}
      aria-label={t('Economy and loadouts')}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && lineupsOpen) {
          event.preventDefault();
          setLineupsOpen(false);
        }
      }}
    >
      <section
        className="broadcast-compact-card"
        data-team={selectedTeam === 2 ? '2' : '3'}
        aria-label={t('Selected player loadout')}
      >
        {selectedPlayer ? (
          <ul className="broadcast-compact-roster">
            <PlayerRow
              compact
              member={{ player: selectedPlayer, state: states.get(selected) }}
              selected
              onSelect={onSelect}
            />
          </ul>
        ) : (
          <p className="broadcast-empty">{t('State unavailable')}</p>
        )}
        <button
          type="button"
          ref={openLineups}
          className="broadcast-lineups-open"
          aria-expanded={lineupsOpen}
          onClick={() => setLineupsOpen(true)}
        >
          <Users size={15} />
          {t('Expand team lineups')}
          <ChevronDown size={14} />
        </button>
      </section>
      <button
        type="button"
        ref={closeLineups}
        className="broadcast-lineups-close"
        onClick={() => setLineupsOpen(false)}
      >
        <X size={16} />
        {t('Close team lineups')}
      </button>
      <div className="broadcast-team-switch" role="group" aria-label={t('Visible team loadouts')}>
        {[3, 2].map((team) => (
          <button
            type="button"
            key={team}
            data-team={team}
            aria-pressed={activeTeam === team}
            onClick={() => setActiveTeam(team as 2 | 3)}
          >
            <span>{team === 3 ? 'CT' : 'T'}</span>
            {t(team === 3 ? 'Counter-terrorists' : 'Terrorists')}
          </button>
        ))}
      </div>
      <TeamBank team={3} members={teams[3]} selected={selected} onSelect={onSelect} />
      <TeamBank team={2} members={teams[2]} selected={selected} onSelect={onSelect} />
    </section>
  );
}
