import { useTranslation } from 'react-i18next';
import { memo, useEffect, useId, useRef, type ReactNode } from 'react';
import { Crosshair, Eye, Keyboard, MapPin, Skull, X } from 'lucide-react';
import { useWorkspaceDialog } from '../context';
import { t } from '../i18n';
import { equipmentName } from '../equipment-display';
import EquipmentGlyph from './EquipmentGlyph';
import ReviewEventGlyph from './ReviewEventGlyph';
import './review-feed.css';

type ReviewFeedPlayer = { id: string; name: string; team?: number };
type RecordedRow = {
  id: string;
  tick: number;
  timeLabel: string;
  actor: ReviewFeedPlayer;
  weapon?: string;
};
type ReviewFeedKill = RecordedRow & {
  target: ReviewFeedPlayer;
  headshot?: boolean;
  canReplayAttacker: boolean;
  canReplayVictim: boolean;
};
type ReviewFeedUtility = RecordedRow & {
  canReplayThrow: boolean;
  canViewLanding: boolean;
  inputBadges?: ReactNode;
};
export type ReviewFeedTab = 'kills' | 'utility';

function PlayerName({ player }: { player: ReviewFeedPlayer }) {
  return (
    <strong className="review-feed-player" data-team={player.team} title={player.name}>
      {player.name || t('Unknown player')}
    </strong>
  );
}

/** Domain association, exact seek targets and recorded input availability belong
 * to the caller. This panel only presents those recorded rows and actions. */
function ReviewFeed({
  kills,
  utilities,
  activeTab,
  onTabChange,
  onReplayKill,
  onReviewUtility,
  onSeek,
  onOpenInputs,
  onClose,
  chromeVisible = true,
  focusOnOpen = false,
  modal = false,
}: {
  kills: readonly ReviewFeedKill[];
  utilities: readonly ReviewFeedUtility[];
  activeTab: ReviewFeedTab;
  onTabChange: (tab: ReviewFeedTab) => void;
  onReplayKill: (id: string, perspective: 'attacker' | 'victim') => void;
  onReviewUtility: (id: string, mode: 'throw' | 'landing') => void;
  onSeek?: (tick: number) => void;
  onOpenInputs?: (id: string) => void;
  onClose?: () => void;
  chromeVisible?: boolean;
  focusOnOpen?: boolean;
  modal?: boolean;
}) {
  useTranslation();
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  useWorkspaceDialog(dialog, modal);
  useEffect(() => {
    if (focusOnOpen) tabs.current[activeTab === 'kills' ? 0 : 1]?.focus();
  }, [focusOnOpen]);
  const items = activeTab === 'kills' ? kills : utilities;
  const content = (
    <section
      className="review-feed"
      data-viewer-chrome
      inert={!chromeVisible}
      aria-hidden={!chromeVisible}
      aria-label={t('Round review')}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && onClose) {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="review-feed-heading">
        <div
          className="review-feed-tabs"
          role="tablist"
          aria-label={t('Round review')}
          onKeyDown={(event) => {
            const index = activeTab === 'kills' ? 0 : 1;
            const next =
              event.key === 'ArrowRight' || event.key === 'ArrowLeft'
                ? 1 - index
                : event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? 1
                    : undefined;
            if (next === undefined) return;
            event.preventDefault();
            onTabChange(next === 0 ? 'kills' : 'utility');
            tabs.current[next]?.focus();
          }}
        >
          {(['kills', 'utility'] as const).map((tab, index) => (
            <button
              key={tab}
              ref={(element) => {
                tabs.current[index] = element;
              }}
              type="button"
              role="tab"
              id={`${id}-${tab}`}
              aria-controls={`${id}-panel`}
              aria-selected={activeTab === tab}
              tabIndex={activeTab === tab ? 0 : -1}
              onClick={() => onTabChange(tab)}
            >
              {t(tab === 'kills' ? 'Kills' : 'Utility')}{' '}
              <span className="num">{tab === 'kills' ? kills.length : utilities.length}</span>
            </button>
          ))}
        </div>
        {onClose && (
          <button
            type="button"
            className="review-feed-close"
            onClick={onClose}
            aria-label={t('Close round review')}
            title={t('Close round review')}
          >
            <X size={16} />
          </button>
        )}
      </div>
      <div
        className="review-feed-list"
        role="tabpanel"
        id={`${id}-panel`}
        aria-labelledby={`${id}-${activeTab}`}
        key={activeTab}
      >
        {items.length ? (
          <ol>
            {items.map((item) => {
              const weapon = item.weapon ? equipmentName(item.weapon) : t('Weapon unavailable');
              const kill = activeTab === 'kills' ? (item as ReviewFeedKill) : null;
              const utility = activeTab === 'utility' ? (item as ReviewFeedUtility) : null;
              const summary = (
                <>
                  <time className="review-feed-time num">{item.timeLabel}</time>
                  <span className="review-feed-event-people">
                    <PlayerName player={item.actor} />
                    <span className="review-feed-weapon" title={weapon}>
                      <EquipmentGlyph item={item.weapon} />
                      <span className="visually-hidden">{weapon}</span>
                      {kill?.headshot && (
                        <span role="img" aria-label={t('Headshot')}>
                          <ReviewEventGlyph event={{ type: 'kill' }} detail="headshot" size={12} />
                        </span>
                      )}
                    </span>
                    {kill && <PlayerName player={kill.target} />}
                  </span>
                </>
              );
              return (
                <li key={item.id} className="review-feed-row" data-event-id={item.id}>
                  <div className="review-feed-event">
                    {onSeek ? (
                      <button
                        type="button"
                        className="review-feed-summary"
                        onClick={() => onSeek(item.tick)}
                        aria-label={[
                          t('Review event at {{time}}', { time: item.timeLabel }),
                          item.actor.name || t('Unknown player'),
                          weapon,
                          kill?.target.name,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      >
                        {summary}
                      </button>
                    ) : (
                      <div className="review-feed-summary">{summary}</div>
                    )}
                    <div className="review-feed-actions">
                      {kill?.canReplayAttacker && (
                        <button
                          type="button"
                          onClick={() => onReplayKill(item.id, 'attacker')}
                          aria-label={t('Replay kill from {{player}}’s perspective', {
                            player: item.actor.name || t('Unknown player'),
                          })}
                          title={t('Replay kill from {{player}}’s perspective', {
                            player: item.actor.name || t('Unknown player'),
                          })}
                        >
                          <Crosshair size={16} />
                        </button>
                      )}
                      {kill?.canReplayVictim && (
                        <button
                          type="button"
                          onClick={() => onReplayKill(item.id, 'victim')}
                          aria-label={t('Replay death from {{player}}’s perspective', {
                            player: kill.target.name || t('Unknown player'),
                          })}
                          title={t('Replay death from {{player}}’s perspective', {
                            player: kill.target.name || t('Unknown player'),
                          })}
                        >
                          <Skull size={16} />
                        </button>
                      )}
                      {utility?.canReplayThrow && (
                        <button
                          type="button"
                          onClick={() => onReviewUtility(item.id, 'throw')}
                          aria-label={t('View {{player}}’s grenade throw', {
                            player: item.actor.name || t('Unknown player'),
                          })}
                          title={t('View {{player}}’s grenade throw', {
                            player: item.actor.name || t('Unknown player'),
                          })}
                        >
                          <Eye size={16} />
                        </button>
                      )}
                      {utility?.canViewLanding && (
                        <button
                          type="button"
                          onClick={() => onReviewUtility(item.id, 'landing')}
                          aria-label={t('View grenade landing')}
                          title={t('View grenade landing')}
                        >
                          <MapPin size={16} />
                        </button>
                      )}
                      {utility?.inputBadges && onOpenInputs && (
                        <button
                          type="button"
                          onClick={() => onOpenInputs(item.id)}
                          aria-label={t('Show {{player}}’s recorded inputs', {
                            player: item.actor.name || t('Unknown player'),
                          })}
                          title={t('Show {{player}}’s recorded inputs', {
                            player: item.actor.name || t('Unknown player'),
                          })}
                        >
                          <Keyboard size={16} />
                        </button>
                      )}
                    </div>
                  </div>
                  {utility?.inputBadges && (
                    <div className="review-feed-inputs">{utility.inputBadges}</div>
                  )}
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="review-feed-empty">
            {t(
              activeTab === 'kills'
                ? 'No kills recorded in this round.'
                : 'No utility throws recorded in this round.',
            )}
          </p>
        )}
      </div>
    </section>
  );
  if (!modal) return content;
  return (
    <dialog
      ref={dialog}
      className="review-feed-dialog"
      aria-label={t('Round review')}
      onCancel={(event) => {
        event.preventDefault();
        onClose?.();
      }}
      onClick={(event) => {
        if (modal && event.target === dialog.current) onClose?.();
      }}
    >
      {content}
    </dialog>
  );
}

export default memo(ReviewFeed);
