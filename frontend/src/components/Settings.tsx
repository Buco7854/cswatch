import { t, locale } from '../i18n';
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, setCsrf } from '../api';
import { useApp } from '../context';
import { NavLink } from 'react-router-dom';
import Connections from './Connections';
const names: Record<string, string> = {
  public_access: 'Public access',
  registrations_enabled: 'New registrations',
  steam_enabled: 'Steam sign-in',
  faceit_enabled: 'FACEIT integration',
  transcription_enabled: 'Local speech transcription',
};
type AdminData = {
  flags: Record<string, { value: boolean; locked: boolean }>;
  users: { id: string; username: string; is_admin: boolean; created_at: number }[];
  queue: { status: string; count: number }[];
  audit: { action: string; created_at: number }[];
};
export function Account({ section = 'security' }: { section?: 'security' | 'connections' }) {
  const { user, signIn, refresh, notify } = useApp();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function change(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const form = e.currentTarget;
    const fd = new FormData(form);
    try {
      const r = await api<{ csrf: string }>('/api/auth/password', {
        method: 'POST',
        body: JSON.stringify(Object.fromEntries(fd)),
      });
      setCsrf(r.csrf);
      await refresh();
      form.reset();
      notify(t('Password updated. Other sessions have been signed out.'));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
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
  const { user, notify, refresh } = useApp();
  const [data, setData] = useState<AdminData | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (user?.is_admin)
      api<AdminData>('/api/admin')
        .then(setData)
        .catch((e) => setError(e.message));
  }, [user]);
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!data) return;
    setBusy(true);
    try {
      await api('/api/admin', {
        method: 'PATCH',
        body: JSON.stringify(
          Object.fromEntries(Object.entries(data.flags).map(([k, v]) => [k, v.value])),
        ),
      });
      await refresh();
      notify(t('Instance settings saved.'));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
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
            <p role="alert" className="error">
              {t(error)}
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
                <form className="settings-panel" onSubmit={save}>
                  {Object.entries(data.flags).map(([key, flag]) => (
                    <label className="toggle-row" key={key}>
                      <span>
                        {t(names[key])}
                        <small>
                          {flag.locked
                            ? t('Managed by environment')
                            : flag.value
                              ? t('Enabled')
                              : t('Disabled')}
                        </small>
                      </span>
                      <input
                        type="checkbox"
                        role="switch"
                        checked={flag.value}
                        disabled={flag.locked}
                        onChange={(e) =>
                          setData({
                            ...data,
                            flags: { ...data.flags, [key]: { ...flag, value: e.target.checked } },
                          })
                        }
                      />
                    </label>
                  ))}
                  <button className="button primary" disabled={busy}>
                    {busy ? t('Saving…') : t('Save settings')}
                  </button>
                </form>
              </div>
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
                      <span>{u.is_admin ? t('Admin') : t('Member')}</span>
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
                      <span>{new Date(a.created_at * 1000).toLocaleString(locale())}</span>
                    </div>
                  ))
                ) : (
                  <p>{t('No security events yet.')}</p>
                )}
              </section>
            </>
          )}
        </>
      )}
    </>
  );
}
