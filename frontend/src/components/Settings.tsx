import { t, locale } from '../i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { LockKeyhole } from 'lucide-react';
import type { MapPreparationDiagnostics } from '../../../shared/map-acquisition';
import type { PresentationKind, PresentationStatus } from '../../../shared/presentation-assets';
import { api } from '../api';
import { useApp } from '../context';
import { NavLink } from 'react-router-dom';
import Connections from './Connections';
import AdminMapReadiness from './AdminMapReadiness';
import AdminMaps from './AdminMaps';
const names: Record<string, string> = {
  public_access: 'Public access',
  registrations_enabled: 'New registrations',
  guest_uploads_enabled: 'Guest demo uploads',
  auto_official_maps_enabled: 'Automatic official map preparation',
  steam_enabled: 'Steam sign-in',
  faceit_enabled: 'FACEIT integration',
  transcription_enabled: 'Local speech transcription',
};
type AdminData = {
  mapReadiness?: MapPreparationDiagnostics;
  presentationAssets?: PresentationStatus;
  flags: Record<string, { value: boolean; locked: boolean }>;
  users: { id: string; username: string; is_admin: boolean; created_at: number }[];
  queue: { status: string; count: number }[];
  audit: { action: string; created_at: number }[];
};
export function Account({ section = 'security' }: { section?: 'security' | 'connections' }) {
  const { user, signIn, refresh, notify } = useApp();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const scope = useRef({ active: true });
  const pending = useRef<object | null>(null);
  const currentIdentity = useRef(user?.id);
  currentIdentity.current = user?.id;
  useEffect(() => {
    const current = { active: true };
    scope.current = current;
    pending.current = null;
    setBusy(false);
    setError('');
    return () => {
      current.active = false;
    };
  }, [user?.id, section]);
  async function change(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending.current || !scope.current.active || !user) return;
    const current = scope.current,
      identity = user.id,
      attempt = {};
    pending.current = attempt;
    const isCurrent = () =>
      current.active && pending.current === attempt && currentIdentity.current === identity;
    setBusy(true);
    setError('');
    const form = e.currentTarget;
    const fd = new FormData(form);
    let failure: Error | undefined;
    try {
      await api('/api/auth/password', {
        method: 'POST',
        body: JSON.stringify(Object.fromEntries(fd)),
      });
    } catch (error) {
      failure = error as Error;
    }
    // A committed password mutation replaces the session cookie, even after
    // leaving this form or losing its response. Only an authoritative session
    // refresh publishes identity and CSRF together, never this response's token.
    try {
      await refresh();
    } catch (error) {
      failure ??= error as Error;
    }
    try {
      if (!isCurrent()) return;
      if (failure) setError(failure.message);
      else {
        form.reset();
        notify(t('Password updated. Other sessions have been signed out.'));
      }
    } finally {
      if (isCurrent()) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <>
      <header className="page-heading">
        <div>
          <h1>{t('Account settings')}</h1>
          <p>{t('Your identity and security.')}</p>
        </div>
      </header>
      <nav className="account-tabs" aria-label={t('Account settings')}>
        <NavLink end to="/account">
          {t('Your account')}
        </NavLink>
        <NavLink to="/account/connections">{t('Connected accounts')}</NavLink>
      </nav>
      {!user ? (
        <button className="button primary" onClick={signIn}>
          {t('Sign in')}
        </button>
      ) : section === 'connections' ? (
        <Connections embedded />
      ) : (
        <>
          <div className="settings-section">
            <div>
              <h2>{t('Your account')}</h2>
              <p>
                {t('Signed in as')} {user.username}.
              </p>
            </div>
            <div className="settings-panel">
              <h3>{t('Connected identities')}</h3>
              <p>
                {user.identities?.length
                  ? user.identities
                      .map((i) => (i.provider === 'steam' ? t('Steam') : 'FACEIT'))
                      .join(' · ')
                  : t('No external accounts linked.')}
              </p>
              <NavLink className="button" to="/account/connections">
                {t('Manage connections')}
              </NavLink>
            </div>
          </div>
          <div className="settings-section">
            <div>
              <h2>{t('Password')}</h2>
              <p>
                {t(
                  'Changing your password signs out all other sessions. Steam-only accounts can set a password here.',
                )}
              </p>
              <p>
                {t(
                  'For account recovery, contact this instance’s administrator. Passwords are never sent by email.',
                )}
              </p>
            </div>
            <form className="settings-panel" onSubmit={change}>
              <label>
                {t('Current password')}
                <input
                  name="current_password"
                  type="password"
                  maxLength={128}
                  autoComplete="current-password"
                />
              </label>
              <label>
                {t('New password')}
                <input
                  name="new_password"
                  type="password"
                  minLength={12}
                  maxLength={128}
                  required
                  autoComplete="new-password"
                  aria-describedby="new-password-help"
                />
              </label>
              <small id="new-password-help">{t('12–128 characters. Use a unique password.')}</small>
              {error && (
                <p className="error" role="alert">
                  {t(error)}
                </p>
              )}
              <button className="button primary" disabled={busy}>
                {busy ? t('Updating…') : t('Update password')}
              </button>
            </form>
          </div>
        </>
      )}
    </>
  );
}
export function Admin() {
  const { user, config, notify, refresh } = useApp();
  const [data, setData] = useState<AdminData | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true);
  const [retryingAsset, setRetryingAsset] = useState<PresentationKind>();
  const currentIdentity = useRef(user?.id);
  currentIdentity.current = user?.id;
  const request = useRef<AbortController | null>(null);
  const scope = useRef({ active: true });
  const load = useCallback(async (preserveFlags = false) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError('');
    try {
      const next = await api<AdminData>('/api/admin', { signal: controller.signal });
      if (!controller.signal.aborted)
        setData((previous) =>
          preserveFlags && previous
            ? {
                ...next,
                flags: Object.fromEntries(
                  Object.entries(next.flags).map(([key, flag]) => [
                    key,
                    flag.locked || !previous.flags[key] || previous.flags[key].locked
                      ? flag
                      : { ...flag, value: previous.flags[key].value },
                  ]),
                ),
              }
            : next,
        );
    } catch (failure) {
      if (!controller.signal.aborted) setError((failure as Error).message);
    } finally {
      if (request.current === controller) {
        request.current = null;
        setLoading(false);
      }
    }
  }, []);
  useEffect(() => {
    const current = { active: true };
    scope.current = current;
    setData(null);
    setBusy(false);
    setRetryingAsset(undefined);
    setError('');
    if (user?.is_admin) void load();
    return () => {
      current.active = false;
      request.current?.abort();
    };
  }, [user?.id, user?.is_admin, load]);
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!data || busy) return;
    const current = scope.current;
    setBusy(true);
    setError('');
    try {
      await api('/api/admin', {
        method: 'PATCH',
        body: JSON.stringify(
          Object.fromEntries(Object.entries(data.flags).map(([k, v]) => [k, v.value])),
        ),
      });
      if (!current.active) return;
      await refresh();
      if (!current.active) return;
      await load();
      if (!current.active) return;
      notify(t('Instance settings saved.'));
    } catch (e) {
      if (current.active) setError((e as Error).message);
    } finally {
      if (current.active) setBusy(false);
    }
  }
  async function retryAsset(kind: PresentationKind) {
    if (busy || !user?.is_admin) return;
    const current = scope.current,
      identity = user.id;
    const live = () => current.active && currentIdentity.current === identity;
    setBusy(true);
    setRetryingAsset(kind);
    setError('');
    try {
      await api(`/api/admin/assets/presentation/${kind}/retry`, { method: 'POST', body: '{}' });
      if (!live()) return;
      await load(true);
      if (live()) notify(t('Asset preparation retry queued.'));
    } catch (failure) {
      if (live()) setError((failure as Error).message);
    } finally {
      if (live()) {
        setBusy(false);
        setRetryingAsset(undefined);
      }
    }
  }
  const revision = config.build?.revision;
  const validRevision = typeof revision === 'string' && /^[0-9a-f]{40}$/.test(revision);
  const buildDate = config.build?.builtAt ? new Date(config.build.builtAt) : null;
  return (
    <>
      <header className="page-heading">
        <div>
          <h1>{t('Instance administration')}</h1>
          <p>{t('Access, identity providers, and processing.')}</p>
        </div>
      </header>
      {!user?.is_admin ? (
        <p role="alert">{t('Administrator access required.')}</p>
      ) : (
        <>
          {error && (
            <div className="member-inline-error" role="alert">
              <p className="error">{t(error)}</p>
              <button
                className="button"
                onClick={() => void load(Boolean(data))}
                disabled={loading || busy}
              >
                {t('Try again')}
              </button>
            </div>
          )}
          {loading && !data && (
            <p className="member-loading" role="status">
              {t('Loading instance settings…')}
            </p>
          )}
          {data && (
            <>
              <div className="settings-section">
                <div>
                  <h2>{t('Access & providers')}</h2>
                  <p>
                    {t(
                      'Environment values take precedence. Unset an environment variable to control that setting here.',
                    )}
                  </p>
                  <p>
                    {t(
                      'Provider API keys are configured through the environment and are never exposed in this interface.',
                    )}
                  </p>
                </div>
                <form className="settings-panel admin-policy-panel" onSubmit={save}>
                  <div className="admin-policy-rows">
                    {Object.entries(data.flags).map(([key, flag]) => (
                      <label className="toggle-row" key={key}>
                        <span>
                          {t(names[key])}
                          {flag.locked && (
                            <small>
                              <LockKeyhole size={12} aria-hidden="true" />
                              {t('Managed by environment')}
                            </small>
                          )}
                        </span>
                        <input
                          type="checkbox"
                          role="switch"
                          checked={flag.value}
                          disabled={flag.locked || busy}
                          onChange={(e) =>
                            setData({
                              ...data,
                              flags: { ...data.flags, [key]: { ...flag, value: e.target.checked } },
                            })
                          }
                        />
                      </label>
                    ))}
                  </div>
                  <div className="form-actions">
                    <button className="button primary" disabled={busy}>
                      {busy ? t('Saving…') : t('Save settings')}
                    </button>
                  </div>
                </form>
              </div>
              <AdminMapReadiness
                data={data.mapReadiness}
                presentation={data.presentationAssets}
                retryingAsset={retryingAsset}
                retryAsset={(kind) => void retryAsset(kind)}
                refreshing={loading || busy}
                refresh={() => void load(true)}
              />
              <AdminMaps />
              <div className="admin-grid">
                <section className="settings-panel">
                  <h2>{t('Processing queue')}</h2>
                  {data.queue.length ? (
                    data.queue.map((q) => (
                      <div className="kv-row" key={t(q.status)}>
                        <span>{t(q.status)}</span>
                        <span className="num">{q.count}</span>
                      </div>
                    ))
                  ) : (
                    <p>{t('No demos submitted yet.')}</p>
                  )}
                  <p className="muted">
                    {t('A separate worker processes demos. Run both Compose services.')}
                  </p>
                </section>
                <section className="settings-panel">
                  <h2>{t('Accounts')}</h2>
                  <p>
                    {data.users.length} {t('most recent accounts')}
                  </p>
                  {data.users.map((u) => (
                    <div className="kv-row" key={u.id}>
                      <span>{u.username}</span>
                      <span className="member-role">{u.is_admin ? t('Admin') : t('Member')}</span>
                    </div>
                  ))}
                </section>
              </div>
              <section className="audit-panel">
                <h2>{t('Recent security events')}</h2>
                {data.audit.length ? (
                  data.audit.map((a, i) => (
                    <div className="kv-row" key={i}>
                      <span>{a.action.replaceAll('.', ' · ')}</span>
                      <time dateTime={new Date(a.created_at * 1000).toISOString()}>
                        {new Date(a.created_at * 1000).toLocaleString(locale())}
                      </time>
                    </div>
                  ))
                ) : (
                  <p>{t('No security events yet.')}</p>
                )}
              </section>
              <dl className="instance-build">
                <div>
                  <dt>{t('Application revision')}</dt>
                  <dd>
                    {validRevision ? (
                      <a
                        href={'https://github.com/Buco7854/cswatch/commit/' + revision}
                        target="_blank"
                        rel="noreferrer"
                        title={revision}
                      >
                        {revision.slice(0, 8)}
                      </a>
                    ) : (
                      t('Unavailable')
                    )}
                  </dd>
                </div>
                <div>
                  <dt>{t('Built')}</dt>
                  <dd>
                    {buildDate && Number.isFinite(buildDate.getTime()) ? (
                      <time dateTime={buildDate.toISOString()}>
                        {buildDate.toLocaleString(locale())}
                      </time>
                    ) : (
                      t('Unavailable')
                    )}
                  </dd>
                </div>
              </dl>
            </>
          )}
        </>
      )}
    </>
  );
}
