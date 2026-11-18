import { useMemo } from 'react';
import type { Frame, Player } from '../types';
import { t } from '../i18n';
import { PlayerRow, SelectedLoadout } from './MatchEconomy';

/** The picker reuses the broadcast player row instead of a second selected
 * player card. Inventory is a quiet disclosure beside the selected row. */
export default function PlayerPicker({
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
  const selectedPlayer = players.find((player) => player.id === selected);
  return (
    <div className="player-picker">
      {[3, 2, 1, 0].map((team) => {
        const members = players.filter(
          (player) => (states.get(player.id)?.team ?? player.team) === team,
        );
        if (!members.length) return null;
        return (
          <section className="broadcast-bank player-picker-bank" data-team={team} key={team}>
            <h3>
              {t(team === 3 ? 'Counter-terrorists' : team === 2 ? 'Terrorists' : 'Other players')}
            </h3>
            <ul className="broadcast-roster">
              {members.map((player) => (
                <PlayerRow
                  key={player.id}
                  member={{ player, state: states.get(player.id) }}
                  selected={player.id === selected}
                  onSelect={onSelect}
                />
              ))}
            </ul>
          </section>
        );
      })}
      {selectedPlayer && (
        <SelectedLoadout
          member={{
            player: selectedPlayer,
            state: states.get(selected),
          }}
        />
      )}
    </div>
  );
}
