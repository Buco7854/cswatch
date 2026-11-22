import { t } from '../i18n';
import type { ViewerSettings } from '../playback';
import './spectator-hud.css';

export default function FlashFeedback({
  presentation,
  opacity,
}: {
  presentation: Exclude<ViewerSettings['flashFeedback'], 'off'>;
  opacity: number;
}) {
  return (
    <div className="spectator-flash">
      {presentation !== 'indicator' && (
        <div
          className="spectator-flash-tint"
          data-strength={presentation}
          style={{ opacity: presentation === 'strong' ? opacity : opacity * 0.28 }}
          aria-hidden="true"
        />
      )}
      <div className="spectator-flash-label" role="status">
        {t('Flashed')}
      </div>
    </div>
  );
}
