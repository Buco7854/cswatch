import type { MapIdentity } from '../../../shared/map-acquisition';
import type { DemoMapSummary } from '../demo-map-assets';
import { locale, t } from '../i18n';
import './map-details.css';

/** Raw recorded header evidence and prepared source provenance stay distinct. */
export default function MapDetails({
  acquisition,
  recorded,
}: {
  acquisition: DemoMapSummary;
  recorded?: MapIdentity;
}) {
  const latest = acquisition.latest;
  const identity = [
    ['Recorded map', recorded?.map],
    ['Recorded build', recorded?.buildNum],
    ['Recorded protocol', recorded?.patchVersion],
    ['Demo version GUID', recorded?.demoVersionGuid],
    [
      'Recorded add-ons',
      recorded?.addonPresence === 'none'
        ? t('No add-ons recorded')
        : recorded?.addonPresence === 'present'
          ? t('Add-ons recorded')
          : recorded?.addonPresence === 'own'
            ? t("The map's own community add-on")
            : undefined,
    ],
  ] as const;
  return (
    <section
      className="viewer-map-provenance viewer-option-note"
      data-map-verification={acquisition.verification}
    >
      <h4>{t('Map provenance')}</h4>
      <p>
        {t(
          acquisition.verification === 'latest-official'
            ? 'This is the latest official map, not a verified historical match. Its layout may differ from this recording.'
            : acquisition.verification === 'operator-approved'
              ? 'This pack matches an operator-approved map identity. Approval is not cryptographic proof of the recording’s geometry.'
              : acquisition.verification === 'version-unverified'
                ? 'This operator-installed pack has not been matched to the recorded map version.'
                : 'No verified map pack is available for this recording.',
        )}
      </p>
      <details className="viewer-map-details">
        <summary>{t('Version details')}</summary>
        <dl>
          {identity.map(([label, value]) => (
            <div key={label}>
              <dt>{t(label)}</dt>
              <dd>{value ?? t('Not recorded')}</dd>
            </div>
          ))}
        </dl>
        {recorded?.conflicted && (
          <p>{t('The recording contains conflicting map identity evidence.')}</p>
        )}
        <p>
          {t(
            'Recorded build and protocol values are header evidence. They do not identify a Steam manifest or prove the map layout.',
          )}
        </p>
        {latest && (
          <dl>
            <div>
              <dt>{t('Official inventory checked')}</dt>
              <dd>{new Date(latest.inventoryUpdatedAt * 1000).toLocaleString(locale())}</dd>
            </div>
            <div>
              <dt>{t('Steam app / depot')}</dt>
              <dd>
                {latest.selection.appId} / {latest.selection.depotId}
              </dd>
            </div>
            <div>
              <dt>{t('Selected Steam manifest')}</dt>
              <dd>{latest.selection.manifest}</dd>
            </div>
            {latest.source && (
              <div>
                <dt>{t('Prepared map SHA-256')}</dt>
                <dd>{latest.source.mapSha256}</dd>
              </div>
            )}
          </dl>
        )}
        {acquisition.acquisition === 'ready' && acquisition.packId && (
          <dl>
            <div>
              <dt>{t('Content pack')}</dt>
              <dd>{acquisition.packId}</dd>
            </div>
          </dl>
        )}
      </details>
    </section>
  );
}
