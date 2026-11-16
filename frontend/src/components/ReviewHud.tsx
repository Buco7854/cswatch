import { t } from '../i18n';
import type { Frame, Playback } from '../types';
import type { ViewerSettings } from '../playback';
import PlayerInputs from './PlayerInputs';
import MatchEconomy from './MatchEconomy';
import './review-hud.css';

/** Settings own display preferences; these edge instruments only present the replay. */
export default function ReviewHud({
  data,
  frame,
  selected,
  settings,
  hidden,
  chromeVisible = true,
  onSelect,
}: {
  data: Playback;
  frame: Frame;
  selected: string;
  settings: ViewerSettings;
  hidden: boolean;
  chromeVisible?: boolean;
  onSelect: (id: string) => void;
}) {
  const player = data.players.find((player) => player.id === selected);
  if (!settings.inputs && !settings.economy) return null;
  return (
    <aside
      className="viewer-review-hud"
      data-viewer-chrome
      data-economy={settings.economy}
      data-inputs={settings.inputs}
      hidden={hidden}
      inert={!chromeVisible}
      aria-hidden={!chromeVisible || hidden}
      aria-label={t('Analysis HUD')}
    >
      {settings.economy && (
        <div className="review-economy-frame">
          <MatchEconomy
            players={data.players}
            frame={frame}
            selected={selected}
            onSelect={onSelect}
          />
        </div>
      )}
      {settings.inputs && (
        <section className="review-inputs-panel" aria-label={t('Recorded inputs')}>
          <p className="review-inputs-player" title={player?.name}>
            {player?.name || t('Selected player')}
          </p>
          <PlayerInputs
            state={frame.players.find((player) => player.id === selected)}
            layout={settings.inputLayout}
            compact
            detailsExpanded={settings.inputDetails}
            mouseInput={settings.mouseInput}
          />
        </section>
      )}
    </aside>
  );
}
