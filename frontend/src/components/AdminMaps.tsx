import { useCallback, useEffect, useRef, useState } from 'react';
import { LoaderCircle, RefreshCw, Trash2 } from 'lucide-react';
import type { ManagedMap, ManagedMaps } from '../../../shared/map-acquisition';
import { api } from '../api';
import { useApp } from '../context';
import { t } from '../i18n';
import { useConfirm } from './Confirmation';
import './admin-maps.css';

export default function AdminMaps() {
  const { user, notify } = useApp();
  const confirm = useConfirm();
  const [data, setData] = useState<ManagedMaps>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string>();
  const scope = useRef({ active: true });
  const currentIdentity = useRef(user?.id);
  currentIdentity.current = user?.id;
  const request = useRef<AbortController | null>(null);
  const mutation = useRef<AbortController | null>(null);
  const action = useRef<object | null>(null);
  const polls = useRef(0);
  const load = useCallback(async () => {
    const current = scope.current,
      identity = currentIdentity.current;
    if (!current.active) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const live = () =>
      current.active && currentIdentity.current === identity && request.current === controller;
    setLoading(true);
    try {
      const result = await api<ManagedMaps>('/api/admin/maps', { signal: controller.signal });
      if (!live()) return;
      setData(result);
      setError('');
    } catch (failure) {
      if (live() && !controller.signal.aborted) setError((failure as Error).message);
    } finally {
      if (live()) {
        request.current = null;
        setLoading(false);
      }
    }
  }, []);
  useEffect(() => {
    const current = { active: true };
    scope.current = current;
    action.current = null;
    polls.current = 0;
    setData(undefined);
    setError('');
    setBusy(undefined);
    if (user?.is_admin) void load();
    return () => {
      current.active = false;
      request.current?.abort();
      mutation.current?.abort();
    };
  }, [user?.id, user?.is_admin, load]);
  useEffect(() => {
    if (!data?.maps.some((map) => map.removal === 'queued') || polls.current >= 12) return;
    const timer = setTimeout(() => {
      polls.current++;
      void load();
    }, 5000);
    return () => clearTimeout(timer);
  }, [data, load]);
  async function remove(map: ManagedMap) {
    if (action.current || !user?.is_admin) return;
    const current = scope.current,
      identity = user.id,
      attempt = {};
    action.current = attempt;
    const live = () =>
      current.active && currentIdentity.current === identity && action.current === attempt;
    try {
      const accepted = await confirm({
        title: t('Delete {{map}}?', { map: map.map }),
        description: t(
          'This removes the map, radar and landscape for every demo using this snapshot. Demo recordings are kept.',
        ),
        confirmLabel: t('Delete map'),
        tone: 'danger',
      });
      if (!accepted || !live()) return;
      setBusy(map.packId);
      setError('');
      const controller = new AbortController();
      mutation.current = controller;
      await api(`/api/admin/maps/${map.packId}`, {
        method: 'DELETE',
        body: JSON.stringify({ version: map.version }),
        signal: controller.signal,
      });
      if (!live()) return;
      polls.current = 0;
      notify(t('Map deletion queued.'));
      await load();
    } catch (failure) {
      if (live()) setError((failure as Error).message);
    } finally {
      if (live()) {
        action.current = null;
        mutation.current = null;
        setBusy(undefined);
      }
    }
  }
  return (
    <section
      className="settings-section managed-maps-section"
      aria-labelledby="installed-maps-title"
    >
      <div>
        <h2 id="installed-maps-title">{t('Installed maps')}</h2>
        <p>
          {t(
            'Manage map snapshots prepared by this instance. Deleting a map keeps your demo recordings.',
          )}
        </p>
      </div>
      <div className="settings-panel managed-maps-panel" aria-busy={loading}>
        <div className="panel-heading">
          <h3>{t('Prepared snapshots')}</h3>
          <button
            type="button"
            className="icon-button"
            aria-label={t('Refresh installed maps')}
            disabled={loading || Boolean(busy)}
            onClick={() => {
              polls.current = 0;
              void load();
            }}
          >
            <RefreshCw size={16} className={loading ? 'spin' : undefined} />
          </button>
        </div>
        {error && (
          <p className="error" role="alert">
            {t(error)}
          </p>
        )}
        {!data ? (
          <p role="status">
            {t(
              loading
                ? 'Loading installed maps…'
                : 'Map management is unavailable. Check the assets service.',
            )}
          </p>
        ) : (
          <>
            {data.maps.length ? (
              <ul className="managed-map-list">
                {data.maps.map((map) => (
                  <li key={map.packId}>
                    <div className="managed-map-identity">
                      <strong>{map.map}</strong>
                      <span title={t('Steam snapshot {{manifest}}', { manifest: map.manifest })}>
                        Steam <span className="managed-map-manifest">{map.manifest}</span>
                      </span>
                      {map.removal === 'queued' && (
                        <small role="status">
                          {t('Waiting for the assets service to delete this map.')}
                        </small>
                      )}
                      {map.removal === 'failed' && (
                        <small className="error">
                          {t('Map deletion failed. Check the assets service, then try again.')}
                        </small>
                      )}
                    </div>
                    <button
                      type="button"
                      className="button managed-map-delete"
                      aria-label={t('Delete {{map}}', { map: map.map })}
                      disabled={Boolean(busy) || map.removal === 'queued' || !data.workerAvailable}
                      onClick={() => void remove(map)}
                    >
                      {busy === map.packId || map.removal === 'queued' ? (
                        <LoaderCircle size={16} className="spin" aria-hidden="true" />
                      ) : (
                        <Trash2 size={16} aria-hidden="true" />
                      )}
                      <span className="managed-map-delete-label">
                        {t(
                          map.removal === 'queued'
                            ? 'Deleting…'
                            : map.removal === 'failed'
                              ? 'Try again'
                              : 'Delete',
                        )}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : !data.operatorMaps?.length ? (
              <p>{t('No managed maps installed yet.')}</p>
            ) : null}
            {Boolean(data.operatorMaps?.length) && (
              <div className="operator-map-list">
                <h4>{t('Operator-managed maps')}</h4>
                <p>
                  {t('Manual installations are managed on the server to preserve operator files.')}
                </p>
                <ul>
                  {data.operatorMaps!.map(({ map }) => (
                    <li key={map}>
                      <strong>{map}</strong>
                      <span>{t('Managed on the server')}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {!data.workerAvailable && data.maps.length > 0 && (
              <p className="managed-map-worker-note">
                {t('Start the assets service before deleting a map.')}
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}
