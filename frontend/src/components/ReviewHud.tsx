import { useTranslation } from 'react-i18next';
import { memo, useLayoutEffect, useRef, useState } from 'react';
import { t } from '../i18n';
import type { Frame, Playback } from '../types';
import type { ViewerSettings } from '../playback';
import PlayerInputs from './PlayerInputs';
import MatchEconomy from './MatchEconomy';
import './review-hud.css';

const splitViewport = '(min-width: 900px) and (min-height: 650px)';

/** Settings own display preferences; these edge instruments only present the replay. */
function ReviewHud({
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
  useTranslation();
  const hudRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLElement>(null);
  const restorePlayer = useRef<string | undefined>(undefined);
  const [desktop, setDesktop] = useState(
    () => typeof matchMedia !== 'undefined' && matchMedia(splitViewport).matches,
  );
  const desktopRef = useRef(desktop);
  const split = settings.economy && settings.teamLayout === 'split' && desktop;

  useLayoutEffect(() => {
    if (typeof matchMedia === 'undefined') return;
    const query = matchMedia(splitViewport);
    const update = () => {
      if (query.matches === desktopRef.current) return;
      desktopRef.current = query.matches;
      const active = document.activeElement;
      if (
        settings.teamLayout === 'split' &&
        active instanceof HTMLElement &&
        hudRef.current?.contains(active)
      )
        restorePlayer.current = active.closest<HTMLElement>('.broadcast-player')?.dataset.playerId;
      else restorePlayer.current = undefined;
      setDesktop(query.matches);
    };
    query.addEventListener('change', update);
    update();
    return () => query.removeEventListener('change', update);
  }, [settings.teamLayout]);

  useLayoutEffect(() => {
    const id = restorePlayer.current;
    restorePlayer.current = undefined;
    if (!id) return;
    const focused = document.activeElement;
    if (focused && focused !== document.body && !hudRef.current?.contains(focused)) return;
    const button = [
      ...(hudRef.current?.querySelectorAll<HTMLButtonElement>('.broadcast-player-select') ?? []),
    ].find(
      (candidate) => candidate.closest<HTMLElement>('.broadcast-player')?.dataset.playerId === id,
    );
    if (!button) return;
    button.focus({ preventScroll: true });
    const viewport = button.closest<HTMLElement>('.broadcast-lineup-stack');
    if (!viewport) return;
    const row = button.getBoundingClientRect(),
      bounds = viewport.getBoundingClientRect();
    if (row.bottom > bounds.bottom) viewport.scrollTop += row.bottom - bounds.bottom;
    else if (row.top < bounds.top) viewport.scrollTop -= bounds.top - row.top;
  }, [split]);

  useLayoutEffect(() => {
    const input = inputRef.current,
      hud = hudRef.current;
    if (!input || !hud || typeof ResizeObserver === 'undefined') return;
    const update = () =>
      hud.style.setProperty('--review-input-height', `${input.getBoundingClientRect().height}px`);
    const observer = new ResizeObserver(update);
    observer.observe(input);
    update();
    return () => {
      observer.disconnect();
      hud.style.removeProperty('--review-input-height');
    };
  }, [settings.inputs]);

  const player = data.players.find((player) => player.id === selected);
  if (!settings.inputs && !settings.economy) return null;
  return (
    <aside
      ref={hudRef}
      className="viewer-review-hud"
      data-layout={split ? 'split' : 'right'}
      data-viewer-chrome
      data-economy={settings.economy}
      data-inputs={settings.inputs}
      hidden={hidden}
      inert={!chromeVisible}
      aria-hidden={!chromeVisible || hidden}
      aria-label={t('Analysis HUD')}
    >
      {settings.economy && (
        <div className={'review-economy-frame' + (split ? ' is-split' : '')}>
          {split ? (
            ([3, 2] as const).map((team) => (
              <div key={team} className="review-team-frame" data-team={team}>
                <MatchEconomy
                  team={team}
                  players={data.players}
                  frame={frame}
                  selected={selected}
                  onSelect={onSelect}
                />
              </div>
            ))
          ) : (
            <MatchEconomy
              players={data.players}
              frame={frame}
              selected={selected}
              onSelect={onSelect}
            />
          )}
        </div>
      )}
      {settings.inputs && (
        <section ref={inputRef} className="review-inputs-panel" aria-label={t('Recorded inputs')}>
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

export default memo(ReviewHud);
