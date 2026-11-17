import type { ReactNode } from 'react';
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
  if (!actions.length) return null;
  return (
    <div className="viewer-context-actions" role="group" aria-label={t('Moment shortcuts')}>
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
