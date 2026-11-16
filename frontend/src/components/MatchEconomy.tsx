import { useMemo } from 'react';
import { ChevronDown } from 'lucide-react';
import { locale, t } from '../i18n';
import type { Frame, Player, Position } from '../types';
import { equipmentLabel, isUtilityItem } from '../equipment-labels';

const money = (value: number | undefined) =>
  typeof value === 'number' && Number.isFinite(value) ? '$' + value.toLocaleString(locale()) : '—';
const status = (value: boolean | undefined) =>
  value === undefined ? '—' : t(value ? 'Yes' : 'No');

function Inventory({ state }: { state: Position | undefined }) {
  const language = locale();
  const items = useMemo(() => {
    if (!state?.inventory) return null;
    const count = new Map<string, number>();
    state.inventory.forEach((item) => {
      const name = equipmentLabel(item);
      count.set(name, (count.get(name) || 0) + 1);
    });
    return [...count].map(([name, count]) => ({
      name,
      count,
      utility: isUtilityItem(name),
    }));
  }, [state?.inventory, language]);
  return (
    <>
      <dl className="economy-selected-values">
        <div>
          <dt>{t('Round start money')}</dt>
          <dd className="num">{money(state?.startMoney)}</dd>
        </div>
        <div>
          <dt>{t('Spent this round')}</dt>
          <dd className="num">{money(state?.spentThisRound)}</dd>
        </div>
        <div>
          <dt>{t('Helmet')}</dt>
          <dd>{status(state?.helmet)}</dd>
        </div>
        <div>
          <dt>{t('Defuse kit')}</dt>
          <dd>{status(state?.defuser)}</dd>
        </div>
        <div>
          <dt>{t('Scoped')}</dt>
          <dd>{status(state?.scoped)}</dd>
        </div>
        <div>
          <dt>{t('Defusing')}</dt>
          <dd>{status(state?.defusing)}</dd>
        </div>
      </dl>
      {items === null ? (
        <p className="input-recording-note">{t('Inventory is unavailable at this moment.')}</p>
      ) : items.length ? (
        <>
          <h4>{t('Utility inventory')}</h4>
          {items.some((item) => item.utility) ? (
            <ul className="economy-inventory">
              {items
                .filter((item) => item.utility)
                .map((item) => (
                  <li key={item.name}>
                    <span>{item.name}</span>
                    <strong className="num">×{item.count}</strong>
                  </li>
                ))}
            </ul>
          ) : (
            <p className="input-recording-note">{t('No utility carried.')}</p>
          )}
          <h4>{t('Weapons and equipment')}</h4>
          <ul className="economy-inventory">
            {items
              .filter((item) => !item.utility)
              .map((item) => (
                <li key={item.name}>
                  <span>{item.name}</span>
                  <strong className="num">×{item.count}</strong>
                </li>
              ))}
          </ul>
        </>
      ) : (
        <p className="input-recording-note">{t('No items carried at this moment.')}</p>
      )}
    </>
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
  const selectedPlayer = players.find((player) => player.id === selected);
  const selectedState = frame.players.find((player) => player.id === selected);
  return (
    <section className="match-economy" aria-label={t('Economy and loadouts')}>
      <details className="economy-loadout">
        <summary>
          <span>
            {t('Selected loadout')}
            <small>
              {selectedState?.weapon
                ? equipmentLabel(selectedState.weapon)
                : selectedPlayer?.name || '—'}
              {selectedState?.ammo !== undefined
                ? ' · ' + t('{{count}} ammo', { count: selectedState.ammo })
                : ''}
            </small>
          </span>
          <ChevronDown size={15} />
        </summary>
        <Inventory state={selectedState} />
      </details>
      <table className="economy-table">
        <thead>
          <tr>
            <th scope="col">{t('Player')}</th>
            <th scope="col">{t('Money')}</th>
            <th scope="col">{t('Equipment')}</th>
          </tr>
        </thead>
        {[3, 2, 1, 0].map((team) => {
          const teamPlayers = players.filter(
            (player) =>
              (frame.players.find((state) => state.id === player.id)?.team ?? player.team) === team,
          );
          if (!teamPlayers.length) return null;
          return (
            <tbody key={team}>
              <tr className="economy-team-heading">
                <th colSpan={3} scope="colgroup">
                  <span className={'team-dot team-' + team} />
                  {t(
                    team === 3 ? 'Counter-terrorists' : team === 2 ? 'Terrorists' : 'Other players',
                  )}
                </th>
              </tr>
              {teamPlayers.map((player) => {
                const state = frame.players.find((state) => state.id === player.id);
                return (
                  <tr key={player.id} className={player.id === selected ? 'selected' : ''}>
                    <th scope="row">
                      <button
                        aria-pressed={player.id === selected}
                        onClick={() => onSelect(player.id)}
                      >
                        <strong>{player.name}</strong>
                        <small>
                          {state
                            ? `${state.health} ${t('HP')} · ${state.armor ?? '—'} ${t('armor')}${!state.alive ? ' · ' + t('Out') : ''}`
                            : t('State unavailable')}
                        </small>
                      </button>
                    </th>
                    <td className="num">{money(state?.money)}</td>
                    <td className="num">{money(state?.equipmentValue)}</td>
                  </tr>
                );
              })}
            </tbody>
          );
        })}
      </table>
      <p className="input-recording-note">
        {t(
          'Equipment is the current carried value. A dash means the demo did not record that field.',
        )}
      </p>
    </section>
  );
}
