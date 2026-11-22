import { useSyncExternalStore } from 'react';
import { t } from '../i18n';
import type { ModelProgressSource } from '../model-cache';

const noProgress = () => undefined;
const noSubscription = () => () => {};

export default function ViewerLoading({
  label,
  map,
  model,
}: {
  label: string;
  map?: string;
  model?: ModelProgressSource;
}) {
  const progress = useSyncExternalStore(
    model?.subscribe ?? noSubscription,
    model?.snapshot ?? noProgress,
  );
  const description = t(progress === 'preparing' ? 'Preparing 3D map…' : label);
  const percent = typeof progress === 'number' ? progress : undefined;
  const percentText =
    percent === undefined
      ? undefined
      : new Intl.NumberFormat(document.documentElement.lang, { style: 'percent' }).format(
          percent / 100,
        );
  return (
    <div className="viewer-map-loading">
      <div className="viewer-loading-panel">
        {map && <h1>{map}</h1>}
        <div className="viewer-loading-status">
          <span role="status">{description}</span>
          {percentText && (
            <span className="viewer-loading-percent" aria-hidden="true">
              {percentText}
            </span>
          )}
        </div>
        <div
          className="viewer-loading-track"
          role="progressbar"
          aria-label={description}
          aria-valuenow={percent}
          data-indeterminate={percent === undefined || undefined}
        >
          <span style={percent === undefined ? undefined : { width: `${percent}%` }} />
        </div>
      </div>
    </div>
  );
}
