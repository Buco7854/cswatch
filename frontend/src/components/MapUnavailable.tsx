import { t } from '../i18n';
import type { MapUnavailableReason } from '../map-availability';
import './map-unavailable.css';
export type MapUnavailableAction = { label: string; onClick: () => void; disabled?: boolean };
export default function MapUnavailable({
  reason = 'missing',
  notice,
  action,
}: {
  reason?: MapUnavailableReason;
  notice?: { title: string; description: string };
  action?: MapUnavailableAction;
}) {
  const title =
    reason === 'loading'
      ? 'Loading map assets…'
      : reason === 'overview'
        ? 'Map overview unavailable'
        : 'Map unavailable';
  const description =
    reason === 'loading'
      ? 'Checking the map assets installed on this instance.'
      : reason === 'overview'
        ? 'No calibrated overview is installed. Choose a 3D camera to view this map.'
        : reason === 'renderer-error'
          ? 'This device could not render the 3D map and no usable overview is installed.'
          : reason === 'model-error'
            ? 'The 3D map could not be loaded and no usable overview is installed.'
            : reason === 'overview-error'
              ? 'The installed map overview could not be loaded. Reopen the viewer to retry.'
              : reason === 'discovery-error'
                ? 'Map assets could not be checked. Reopen the viewer to retry.'
                : 'This demo does not include map artwork. The instance administrator needs to install this map’s assets.';
  return (
    <div
      className="map-unavailable"
      data-map-unavailable={reason}
      role="status"
      aria-label={t(notice?.title || title)}
    >
      <div>
        <h2>{t(notice?.title || title)}</h2>
        <p>{t(notice?.description || description)}</p>
        {action && (
          <button
            className="button primary map-unavailable-action"
            disabled={action.disabled}
            onClick={action.onClick}
          >
            {t(action.label)}
          </button>
        )}
      </div>
    </div>
  );
}
