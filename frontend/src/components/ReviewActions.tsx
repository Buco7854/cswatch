import type { ReactNode } from 'react';
import { t } from '../i18n';
import './review-actions.css';

export type ReviewAction = {
  id: string;
  label: string;
  title: string;
  icon: ReactNode;
  run: () => void;
};

/** Short recorded-moment suggestions remain usable while viewing chrome fades. */
export default function ReviewActions({ actions }: { actions: ReviewAction[] }) {
  if (!actions.length) return null;
  return (
    <div className="viewer-context-actions" role="group" aria-label={t('Moment shortcuts')}>
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
          <span>{action.label}</span>
        </button>
      ))}
    </div>
  );
}
