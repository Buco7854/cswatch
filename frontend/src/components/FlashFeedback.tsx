import { t } from '../i18n';
import type { ViewerSettings } from '../playback';
import './spectator-hud.css';

export default function FlashFeedback({
  presentation,
}: {
  presentation: Exclude<ViewerSettings['flashFeedback'], 'off'>;
}) {
  return (
    <div className="spectator-flash">
      {presentation !== 'indicator' && (
        <div className="spectator-flash-tint" data-strength={presentation} aria-hidden="true" />
      )}
      <div className="spectator-flash-label" role="status">
        {t('Flashed')}
      </div>
    </div>
  );
}
