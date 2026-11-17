import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { t } from '../i18n';
import './review-actions.css';

export type ReviewAction = {
  id: string;
  label: string;
  shortLabel?: string;
  title: string;
  icon: ReactNode;
  run: () => void;
};

/** Short recorded-moment suggestions remain usable while viewing chrome fades. */
export default function ReviewActions({
  actions,
  heading,
}: {
  actions: ReviewAction[];
  heading?: ReactNode;
}) {
  const card = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = card.current;
    const viewer = element?.closest<HTMLElement>('.viewer-frame');
    if (!element || !viewer) return;
    const update = () =>
      viewer.style.setProperty(
        '--review-actions-gap',
        `${element.getBoundingClientRect().height + 12}px`,
      );
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(element);
    window.addEventListener('resize', update);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
      viewer.style.removeProperty('--review-actions-gap');
    };
  }, [actions.length]);
  if (!actions.length) return null;
  return (
    <div
      ref={card}
      className="viewer-context-actions"
      role="group"
      aria-label={t('Moment shortcuts')}
    >
      {heading && <div className="review-moment-heading">{heading}</div>}
      <div className="review-moment-buttons">
        {actions.map((action) => (
          <button
            key={action.id}
            type="button"
            className="review-action"
            aria-label={action.label}
            title={action.title}
            onClick={action.run}
          >
            {action.icon}
            <span>{action.shortLabel || action.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
