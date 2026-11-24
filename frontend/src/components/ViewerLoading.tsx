import { useSyncExternalStore, type ReactNode } from 'react';
import { t } from '../i18n';
import type { ModelProgressSource } from '../model-cache';

const noProgress = () => undefined;
const noSubscription = () => () => {};

export default function ViewerLoading({
  label,
  back,
  detail,
  failed = false,
  model,
  children,
}: {
  label: string;
  back: ReactNode;
  detail?: ReactNode;
  failed?: boolean;
  model?: ModelProgressSource;
  children?: ReactNode;
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
      {back}
      <div className="viewer-loading-body">
        <div className="viewer-loading-panel">
          <div className="viewer-loading-status">
            <div role={failed && detail ? undefined : failed ? 'alert' : 'status'}>
              <h1>{description}</h1>
            </div>
            {percentText && (
              <span className="viewer-loading-percent" aria-hidden="true">
                {percentText}
              </span>
            )}
          </div>
          {!failed && (
            <div
              className="viewer-loading-track"
              role="progressbar"
              aria-label={description}
              aria-valuenow={percent}
              data-indeterminate={percent === undefined || undefined}
            >
              <span style={percent === undefined ? undefined : { width: `${percent}%` }} />
            </div>
          )}
          {detail && <p role={failed ? 'alert' : undefined}>{detail}</p>}
          {children}
        </div>
      </div>
    </div>
  );
}
