import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { Check, ChevronDown, ChevronUp, Keyboard, MoreHorizontal, X } from 'lucide-react';
import { t } from '../i18n';
import type { Frame, Playback } from '../types';
import type { ViewerSettings } from '../playback';
import { ActionMenu } from './Controls';
import PlayerInputs from './PlayerInputs';
import MatchEconomy from './MatchEconomy';
import './review-hud.css';

/** Match context stays at the edges; the middle is reserved for the camera. */
export default function ReviewHud({
  data,
  frame,
  selected,
  settings,
  hidden,
  onSelect,
  onCloseInputs,
}: {
  data: Playback;
  frame: Frame;
  selected: string;
  settings: ViewerSettings;
  hidden: boolean;
  onSelect: (id: string) => void;
  onCloseInputs: () => void;
}) {
  const [inputCollapsed, setInputCollapsed] = useState(false);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const [inputHeight, setInputHeight] = useState(134);
  const inputPanel = useRef<HTMLElement>(null);
  const inputToggle = useRef<HTMLButtonElement>(null);
  const contentId = useId();
  const player = data.players.find((player) => player.id === selected);
  useEffect(() => {
    const panel = inputPanel.current;
    if (!panel || hidden || !settings.inputs) return;
    const observer = new ResizeObserver(([entry]) => {
      const height = entry.borderBoxSize[0]?.blockSize ?? panel.getBoundingClientRect().height;
      setInputHeight(Math.ceil(height));
    });
    observer.observe(panel);
    return () => observer.disconnect();
  }, [hidden, settings.inputs]);
  if (!settings.inputs && !settings.economy) return null;
  return (
    <aside
      className="viewer-review-hud"
      data-economy={settings.economy}
      data-inputs={settings.inputs}
      hidden={hidden}
      aria-label={t('Analysis HUD')}
      style={{ '--review-input-height': `${inputHeight}px` } as CSSProperties}
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
        <section
          ref={inputPanel}
          className={'review-inputs-panel' + (inputCollapsed ? ' is-collapsed' : '')}
          aria-label={t('Recorded inputs')}
          onKeyDown={(event) => {
            if (
              event.key !== 'Escape' ||
              event.defaultPrevented ||
              (event.target as HTMLElement).closest('[role="menu"]')
            )
              return;
            event.preventDefault();
            setInputCollapsed(true);
            inputToggle.current?.focus();
          }}
        >
          <header className="review-inputs-header">
            <button
              ref={inputToggle}
              type="button"
              className="review-input-toggle"
              aria-expanded={!inputCollapsed}
              aria-controls={contentId}
              aria-label={t(inputCollapsed ? 'Expand input display' : 'Collapse input display')}
              onClick={() => setInputCollapsed((value) => !value)}
            >
              <Keyboard size={14} />
              <span title={player?.name}>{player?.name || t('Selected player')}</span>
              {inputCollapsed ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            </button>
            <ActionMenu
              label={t('Input display options')}
              trigger={
                <button
                  type="button"
                  className="icon-button"
                  aria-label={t('Input display options')}
                >
                  <MoreHorizontal size={17} />
                </button>
              }
              items={[
                {
                  id: 'details',
                  label: t('Input details'),
                  icon: detailsExpanded ? <Check size={15} /> : undefined,
                  onSelect: () => {
                    setDetailsExpanded((value) => !value);
                    setInputCollapsed(false);
                  },
                },
                {
                  id: 'close',
                  label: t('Hide inputs'),
                  icon: <X size={15} />,
                  separatorBefore: true,
                  onSelect: onCloseInputs,
                },
              ]}
            />
          </header>
          {!inputCollapsed && (
            <div id={contentId} className="review-inputs-body">
              <PlayerInputs
                state={frame.players.find((player) => player.id === selected)}
                layout={settings.inputLayout}
                compact
                detailsExpanded={detailsExpanded}
              />
            </div>
          )}
        </section>
      )}
    </aside>
  );
}
