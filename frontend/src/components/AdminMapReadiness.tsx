import { RefreshCw } from 'lucide-react';
import type {
  MapPreparationDiagnostics,
  MapInventoryFailure,
} from '../../../shared/map-acquisition';
import { t, locale } from '../i18n';

const inventoryHelp: Record<MapInventoryFailure['code'], string> = {
  storage_limit: 'Free space or increase the asset storage quota.',
  storage_unavailable: 'Check that the asset volumes are mounted and writable.',
  access_denied: 'Check the asset volume permissions and Steam access.',
  network_unavailable: 'Check outbound network access and DNS for the assets service.',
  toolchain_failed: 'The asset tools could not be downloaded or verified.',
  steam_rate_limited: 'Steam rate-limited this instance. The worker will retry after the cooldown.',
  steam_unavailable: 'The Steam inventory request failed. Check the assets service logs.',
  metadata_invalid: 'Steam returned an unsupported inventory. Update the assets image.',
  publication_failed: 'The official inventory could not be saved. Check the shared job volume.',
  timeout: 'The inventory request timed out. Check network access and service resources.',
  interrupted: 'Inventory discovery was interrupted. Keep the assets service running.',
};

export default function AdminMapReadiness({
  data,
  refreshing,
  refresh,
}: {
  data?: MapPreparationDiagnostics;
  refreshing: boolean;
  refresh: () => void;
}) {
  const timestamp = data?.inventory.updatedAt;
  const failure = data?.worker.inventoryFailure;
  const retryDate = failure ? new Date(failure.retryAt * 1000) : null;
  const retryScheduled = Boolean(
    data?.worker.available &&
    failure &&
    failure.retryAt > Date.now() / 1000 &&
    retryDate &&
    Number.isFinite(retryDate.getTime()),
  );
  return (
    <section
      className="settings-section map-preparation-section"
      aria-labelledby="map-preparation-title"
    >
      <div>
        <h2 id="map-preparation-title">{t('Map preparation')}</h2>
        <p>{t('Automatic preparation needs the asset worker and an official map inventory.')}</p>
        <p>
          {t('Historical approvals are optional. Latest official maps use the worker inventory.')}
        </p>
      </div>
      <div className="settings-panel map-readiness-panel" aria-busy={refreshing}>
        <div className="panel-heading">
          <h3>{t('Service status')}</h3>
          <button
            type="button"
            className="icon-button"
            aria-label={t('Refresh map status')}
            onClick={refresh}
            disabled={refreshing}
          >
            <RefreshCw size={16} className={refreshing ? 'spin' : undefined} />
          </button>
        </div>
        <dl className="readiness-details">
          <div>
            <dt>{t('Automatic official map preparation')}</dt>
            <dd>{data ? t(data.enabled ? 'Enabled' : 'Disabled') : t('Unavailable')}</dd>
          </div>
          <div>
            <dt>{t('Asset worker')}</dt>
            <dd>
              <span
                className="member-status"
                data-state={data?.worker.available ? 'ready' : 'unavailable'}
              >
                {t(data?.worker.available ? 'Available' : 'Unavailable')}
              </span>
            </dd>
          </div>
          <div>
            <dt>{t('Official inventory')}</dt>
            <dd>
              {t(
                data?.inventory.status === 'fresh'
                  ? 'Up to date'
                  : data?.inventory.status === 'stale'
                    ? 'Refresh needed'
                    : 'Unavailable',
              )}
              {data && data.inventory.status !== 'unavailable' && (
                <small>
                  {t('Maps listed: {{number}}', {
                    number: data.inventory.mapCount.toLocaleString(locale()),
                  })}
                </small>
              )}
            </dd>
          </div>
          <div>
            <dt>{t('Historical approvals')}</dt>
            <dd>
              {data?.catalog.status === 'configured'
                ? data.catalog.entries.toLocaleString(locale())
                : data?.catalog.status === 'empty'
                  ? t('None configured')
                  : t('Unavailable')}
            </dd>
          </div>
        </dl>
        {typeof timestamp === 'number' && Number.isFinite(timestamp) && (
          <p className="readiness-timestamp">
            {t('Inventory updated {{date}}', {
              date: new Date(timestamp * 1000).toLocaleString(locale()),
            })}
          </p>
        )}
        {failure && (
          <div className="readiness-failure" role="status">
            <p>{t('Official inventory discovery failed.')}</p>
            <p>{t(inventoryHelp[failure.code] || 'Check the assets service logs.')}</p>
            <p>{t('Diagnostic code: {{code}}', { code: `${failure.phase}/${failure.code}` })}</p>
            {retryScheduled && retryDate && (
              <p>
                {t('Next inventory check: {{date}}', {
                  date: retryDate.toLocaleString(locale()),
                })}
              </p>
            )}
          </div>
        )}
        {data && (!data.worker.available || data.inventory.status !== 'fresh') && (
          <div className="readiness-help">
            <p>
              {t('Update and start the assets service. Its image is separate from the web app.')}
            </p>
            <code>{'docker compose pull assets\ndocker compose up -d assets'}</code>
          </div>
        )}
      </div>
    </section>
  );
}
