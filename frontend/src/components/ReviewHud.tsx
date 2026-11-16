import { useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Keyboard, Wallet, X } from 'lucide-react';
import { t } from '../i18n';
import type { Frame, Playback } from '../types';
import type { ViewerSettings } from '../playback';
import PlayerInputs from './PlayerInputs';
import MatchEconomy from './MatchEconomy';
import './review-hud.css';

export default function ReviewHud({
  data,
  frame,
  selected,
  settings,
  hidden,
  onSelect,
  onClose,
}: {
  data: Playback;
  frame: Frame;
  selected: string;
  settings: ViewerSettings;
  hidden: boolean;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const [requested, setActive] = useState<'inputs' | 'economy'>(
    settings.inputs ? 'inputs' : 'economy',
  );
  const [collapsed, setCollapsed] = useState(false);
  const collapse = useRef<HTMLButtonElement>(null);
  const tabButtons = useRef<Partial<Record<'inputs' | 'economy', HTMLButtonElement | null>>>({});
  const active = settings[requested] ? requested : settings.inputs ? 'inputs' : 'economy';
  const player = data.players.find((player) => player.id === selected);
  if (!settings.inputs && !settings.economy) return null;
  return (
    <aside
      className={'viewer-analysis-hud' + (collapsed ? ' is-collapsed' : '')}
      hidden={hidden}
      aria-label={t('Analysis HUD')}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
          event.preventDefault();
          setCollapsed(true);
          collapse.current?.focus();
        }
      }}
    >
      <header className="analysis-hud-heading">
        <div>
          <strong>{player?.name || t('Selected player')}</strong>
          <small>{t(active === 'inputs' ? 'Recorded inputs' : 'Economy and loadouts')}</small>
        </div>
        <button
          ref={collapse}
          className="icon-button"
          aria-label={t(collapsed ? 'Expand analysis HUD' : 'Collapse analysis HUD')}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
        >
          {collapsed ? <ChevronUp size={17} /> : <ChevronDown size={17} />}
        </button>
        <button className="icon-button" aria-label={t('Close analysis HUD')} onClick={onClose}>
          <X size={18} />
        </button>
      </header>
      {!collapsed && (
        <>
          {settings.inputs && settings.economy && (
            <div
              className="analysis-hud-tabs"
              role="tablist"
              aria-label={t('Analysis view')}
              onKeyDown={(event) => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                const next =
                  event.key === 'Home'
                    ? 'inputs'
                    : event.key === 'End'
                      ? 'economy'
                      : active === 'inputs'
                        ? 'economy'
                        : 'inputs';
                setActive(next);
                tabButtons.current[next]?.focus();
              }}
            >
              <button
                role="tab"
                id="analysis-inputs-tab"
                aria-controls="analysis-hud-panel"
                aria-selected={active === 'inputs'}
                tabIndex={active === 'inputs' ? 0 : -1}
                ref={(element) => {
                  tabButtons.current.inputs = element;
                }}
                onClick={() => setActive('inputs')}
              >
                <Keyboard size={16} />
                {t('Inputs')}
              </button>
              <button
                role="tab"
                id="analysis-economy-tab"
                aria-controls="analysis-hud-panel"
                aria-selected={active === 'economy'}
                tabIndex={active === 'economy' ? 0 : -1}
                ref={(element) => {
                  tabButtons.current.economy = element;
                }}
                onClick={() => setActive('economy')}
              >
                <Wallet size={16} />
                {t('Economy')}
              </button>
            </div>
          )}
          <div
            className="analysis-hud-content"
            id="analysis-hud-panel"
            role={settings.inputs && settings.economy ? 'tabpanel' : undefined}
            aria-labelledby={
              settings.inputs && settings.economy ? 'analysis-' + active + '-tab' : undefined
            }
          >
            {active === 'inputs' ? (
              <PlayerInputs
                state={frame.players.find((player) => player.id === selected)}
                layout={settings.inputLayout}
              />
            ) : (
              <MatchEconomy
                players={data.players}
                frame={frame}
                selected={selected}
                onSelect={onSelect}
              />
            )}
          </div>
        </>
      )}
    </aside>
  );
}
