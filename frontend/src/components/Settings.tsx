import type { AdminAddressIssue } from '../../../shared/admin-network';
import { t, locale } from '../i18n';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { SwitchRow } from './Controls';
import type { MapPreparationDiagnostics } from '../../../shared/map-acquisition';
import type { PresentationKind, PresentationStatus } from '../../../shared/presentation-assets';
import { api, sessionDeadline } from '../api';
import { useApp } from '../context';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { hasPermission } from '../../../shared/roles.mjs';
import { authReturnPath } from '../auth-navigation';
import { useAction } from '../useAction';
import { ActionError, CopyValue, roleLabel, SecuritySection } from './AuthControls';
import AccountSecurity from './AccountSecurity';
import { AccountEmail } from './AccountEmail';
import AccountSessions from './AccountSessions';
import { StepUpProvider, SteamStepUpNotice, useStepUp } from './StepUp';
import { ConfirmationProvider } from './Confirmation';
import { AdminUsers, AdminAudit, MfaPolicy, type Policy } from './AdminAccounts';
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
  email_delivery_enabled: 'Email verification and password recovery',
};
type AdminData = {
  mapReadiness?: MapPreparationDiagnostics;
  presentationAssets?: PresentationStatus;
  flags: Record<string, { value: boolean; locked: boolean }>;
  mfa_required_roles: Policy;
  email_delivery_configured?: boolean;
  queue: { status: string; count: number }[];
};
type FlagDrafts = Partial<Record<string, boolean>>;
type SettingsSnapshot = { data: AdminData | null; drafts: FlagDrafts };
const emptySettings: SettingsSnapshot = { data: null, drafts: {} };

export function Account({
  section = 'security',
  enrollment = false,
}: {
  section?: 'security' | 'connections' | 'sessions';
  enrollment?: boolean;
}) {
  const { user, session, signOut: logout } = useApp();
  const navigate = useNavigate();
  const { search } = useLocation();
  const signOut = useAction();
  const title = useRef<HTMLHeadingElement>(null);
  const limited = session.stage === 'enroll';
  const destination = authReturnPath(new URLSearchParams(search).get('returnTo'));
  useEffect(() => {
    if (enrollment) title.current?.focus();
  }, [enrollment]);
  if (enrollment)
    return (
      <div className="auth-enrollment">
        <header className="auth-intro">
          <h1 ref={title} tabIndex={-1}>
            {t('Secure your account')}
          </h1>
          <p>
            {t(
              'This account needs a second factor. Add a passkey or an authenticator app to continue.',
            )}
          </p>
        </header>
        {limited && session.username && (
          <CopyValue wrap label={t('Your sign-in username')} value={session.username} />
        )}
        <AccountSecurity
          key={limited ? session.username : user?.username}
          enrollment
          onComplete={() => navigate(destination, { replace: true })}
        />
        <button
          className="button auth-secondary"
          type="button"
          disabled={signOut.busy}
          onClick={() => void signOut.run(() => logout({ returnTo: destination }))}
        >
          {t('Sign out')}
        </button>
        <ActionError error={signOut.error} />
      </div>
    );
  if (!user) return null;
  return (
    <>
      <header className="page-heading">
        <h1>
          {t(
            section === 'connections'
              ? 'Connected accounts'
              : section === 'sessions'
                ? 'Sessions'
                : 'Account settings',
          )}
        </h1>
      </header>
      <nav className="account-tabs" aria-label={t('Account settings')}>
        <NavLink end to="/account">
          {t('Your account')}
        </NavLink>
        <NavLink to="/account/sessions">{t('Sessions')}</NavLink>
        <NavLink to="/account/connections">{t('Connected accounts')}</NavLink>
      </nav>
      {section === 'connections' ? (
        <Connections key={user.id} />
      ) : section === 'sessions' ? (
        <AccountSessions key={user.id} />
      ) : (
        <>
          <SecuritySection title={t('Your account')}>
            <div className="settings-panel security-panel">
              <div className="account-identity">
                <h3>{user.display_name || user.username}</h3>
                <span className="member-role">{roleLabel(user.role)}</span>
              </div>
              <CopyValue wrap label={t('Your sign-in username')} value={user.username} />
            </div>
          </SecuritySection>
          <SecuritySection title={t('Email address')}>
            <div className="settings-panel security-panel">
              <AccountEmail key={user.id} />
            </div>
          </SecuritySection>
          <AccountSecurity key={user.id} enrollment={false} onComplete={() => {}} />
        </>
      )}
    </>
  );
}
const adminAddressMessages: Record<AdminAddressIssue, string> = {
  socket_unavailable: 'The server could not read the connection address.',
  untrusted_proxy:
    'The connection forwarded client information but its address is outside TRUSTED_PROXY_IPS. Check the address of your reverse proxy.',
  missing_address:
    'The proxy forwarded request information without a client address. Configure it to set X-Real-IP or X-Forwarded-For.',
  unsupported_header:
    'An unsupported client address header was received. Configure the proxy to send client addresses using X-Real-IP or X-Forwarded-For.',
  duplicate_header:
    'A forwarding header was received more than once. Check which proxies set that header.',
  invalid_address:
    'The proxy sent an invalid client address or forwarding chain. Check X-Real-IP and X-Forwarded-For.',
  conflicting_addresses:
    'X-Real-IP and X-Forwarded-For identify different clients. Check how each proxy sets these headers.',
};
function AdminAccessNotice() {
  const { config, user } = useApp();
  const admin = hasPermission(user?.role, 'admin');
  const diagnostic = config.admin_network_diagnostic;
  return (
    <div className="notice" role="alert">
      <strong>
        {t(
          admin
            ? 'Administration is unavailable from this network.'
            : 'Administrator access required.',
        )}
      </strong>
      {admin && config.admin_network_denial === 'outside_network' && (
        <p>
          {t(
            'Use a network listed in ADMIN_ALLOWED_IPS or ask the operator to check the allowed client networks.',
          )}
        </p>
      )}
      {admin && diagnostic && (
        <>
          {diagnostic.issue && <p>{t(adminAddressMessages[diagnostic.issue])}</p>}
          <dl className="security-metadata">
            <div>
              <dt>{t('Client IP address')}</dt>
              <dd>{diagnostic.client ?? t('Unverified')}</dd>
            </div>
            <div>
              <dt>{t('Connection address')}</dt>
              <dd>{diagnostic.connection ?? t('Unavailable')}</dd>
            </div>
          </dl>
        </>
      )}
    </div>
  );
}

export function Admin() {
  const { user, config, refresh, isAdminAvailable } = useApp();
  const { search } = useLocation();
  const query = new URLSearchParams(search);
  const section = query.get('section');
  const [access, setAccess] = useState<{ checked: boolean; error?: string }>({ checked: false });
  const [revision, recheck] = useReducer((current: number) => current + 1, 0);
  const current = section === 'users' || section === 'audit' ? section : 'settings';
  useEffect(() => {
    if (!config.admin_access) return;
    let active = true;
    void refresh().then(
      () => {
        if (active) setAccess({ checked: true });
      },
      (error: Error) => {
        if (active) setAccess({ checked: true, error: error.message });
      },
    );
    return () => {
      active = false;
    };
  }, [config.admin_access, refresh, revision]);
  return (
    <>
      <header className="page-heading">
        <div>
          <h1>{t('Instance administration')}</h1>
        </div>
      </header>
      {!config.admin_access ? (
        <div className="admin-access-denied">
          <AdminAccessNotice />
          <Link className="button" to="/library">
            {t('Back to library')}
          </Link>
        </div>
      ) : !access.checked ? (
        <p role="status">{t('Loading…')}</p>
      ) : access.error ? (
        <>
          <ActionError error={access.error} />
          <button
            className="button"
            onClick={() => {
              setAccess({ checked: false });
              recheck();
            }}
          >
            {t('Retry')}
          </button>
        </>
      ) : (
        <ConfirmationProvider identity={user?.id}>
          <StepUpProvider allowed={() => isAdminAvailable(user?.id)}>
            <nav className="account-tabs" aria-label={t('Administration')}>
              <Link
                to="/admin"
                aria-current={current === 'settings' ? 'page' : false}
                className={current === 'settings' ? 'active' : ''}
              >
                {t('Instance settings')}
              </Link>
              <Link
                to="/admin?section=users"
                aria-current={current === 'users' ? 'page' : false}
                className={current === 'users' ? 'active' : ''}
              >
                {t('Users')}
              </Link>
              <Link
                to="/admin?section=audit"
                aria-current={current === 'audit' ? 'page' : false}
                className={current === 'audit' ? 'active' : ''}
              >
                {t('Security events')}
              </Link>
            </nav>
            {current === 'users' ? (
              <AdminUsers key={user?.id} />
            ) : current === 'audit' ? (
              <AdminAudit key={user?.id} />
            ) : (
              <InstanceSettings key={user?.id} />
            )}
          </StepUpProvider>
        </ConfirmationProvider>
      )}
    </>
  );
}
function InstanceSettings() {
  const { user, config, notify, refresh, isAdminAvailable } = useApp();
  const verifySettings = useStepUp('instance-settings');
  const verifyAssetRetry = useStepUp('asset-retry');
  const [{ data, drafts }, setSettings] = useState(emptySettings);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true);
  const [retryingAsset, setRetryingAsset] = useState<PresentationKind>();
  const currentIdentity = useRef(user?.id);
  currentIdentity.current = user?.id;
  const request = useRef<AbortController | null>(null);
  const scope = useRef({ active: true });
  const latestSettings = useRef(emptySettings);
  const updateSettings = useCallback((next: SettingsSnapshot) => {
    latestSettings.current = next;
    setSettings(next);
  }, []);
  const load = useCallback(
    async (policyContext?: string) => {
      const live = () => isAdminAvailable(user?.id, policyContext);
      if (!live()) return;
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      setLoading(true);
      setError('');
      try {
        const next = await api<AdminData>(
          '/api/admin',
          { signal: sessionDeadline(controller.signal) },
          policyContext,
        );
        if (controller.signal.aborted || !live()) return;
        const edits = Object.entries(latestSettings.current.drafts).filter(([key, value]) => {
          const saved = next.flags[key];
          return saved && !saved.locked && saved.value !== value;
        });
        updateSettings({ data: next, drafts: Object.fromEntries(edits) });
        return next;
      } catch (failure) {
        if (controller.signal.aborted || !live()) return;
        if (policyContext !== undefined) throw failure;
        setError((failure as Error).message);
      } finally {
        if (request.current === controller) {
          request.current = null;
          setLoading(false);
        }
      }
    },
    [isAdminAvailable, updateSettings, user?.id],
  );
  useEffect(() => {
    const current = { active: true };
    scope.current = current;
    updateSettings(emptySettings);
    setBusy(false);
    setRetryingAsset(undefined);
    setError('');
    if (config.admin_access) void load();
    return () => {
      current.active = false;
      request.current?.abort();
    };
  }, [user?.id, config.admin_access, load, updateSettings]);
  function editFlag(key: string, value: boolean) {
    const { data, drafts } = latestSettings.current;
    const saved = data?.flags[key];
    if (!saved || saved.locked) return;
    const edits = { ...drafts };
    if (saved.value === value) delete edits[key];
    else edits[key] = value;
    updateSettings({ data, drafts: edits });
  }
  const dirty = Object.keys(drafts).length > 0;
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!dirty || busy) return;
    const current = scope.current;
    const live = (csrf: string) => current.active && isAdminAvailable(user?.id, csrf);
    setBusy(true);
    setError('');
    try {
      const csrf = await verifySettings();
      if (!csrf || !live(csrf)) return;
      // A policy or diagnostics read can settle while the step-up is open.
      const changes = latestSettings.current.drafts;
      if (!Object.keys(changes).length) return;
      await api('/api/admin', { method: 'PATCH', body: JSON.stringify(changes) }, csrf);
      if (!live(csrf)) return;
      await refresh();
      if (!live(csrf)) return;
      await load();
      if (!live(csrf)) return;
      notify(t('Instance settings saved.'));
    } catch (e) {
      if (current.active) setError((e as Error).message);
    } finally {
      if (current.active) setBusy(false);
    }
  }
  async function retryAsset(kind: PresentationKind) {
    if (busy || !user || !config.admin_access) return;
    const current = scope.current,
      identity = user.id;
    const live = (csrf?: string) =>
      current.active && currentIdentity.current === identity && isAdminAvailable(identity, csrf);
    setBusy(true);
    setRetryingAsset(kind);
    setError('');
    try {
      const csrf = await verifyAssetRetry();
      if (!csrf || !live(csrf)) return;
      await api(
        `/api/admin/assets/presentation/${kind}/retry`,
        { method: 'POST', body: '{}' },
        csrf,
      );
      if (!live(csrf)) return;
      await load();
      if (live(csrf)) notify(t('Asset preparation retry queued.'));
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
      {error && (
        <div className="member-inline-error" role="alert">
          <p className="error">{t(error)}</p>
          <button className="button" onClick={() => void load()} disabled={loading || busy}>
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
              <h2 id="instance-access-heading">{t('Access & providers')}</h2>
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
            <form
              aria-labelledby="instance-access-heading"
              className="settings-panel admin-policy-panel"
              onSubmit={save}
            >
              <SteamStepUpNotice action="instance-settings" />
              <div className="admin-policy-rows">
                {Object.entries(data.flags).map(([key, flag]) => (
                  <SwitchRow
                    key={key}
                    label={t(names[key])}
                    locked={flag.locked}
                    checked={drafts[key] ?? flag.value}
                    disabled={
                      busy ||
                      (key === 'email_delivery_enabled' && data.email_delivery_configured === false)
                    }
                    onChange={(checked) => editFlag(key, checked)}
                  />
                ))}
              </div>
              {data.email_delivery_configured === false && (
                <p className="muted">
                  {t(
                    'Configure SMTP on the server to enable verification and password reset emails.',
                  )}
                </p>
              )}
              <div className="form-actions">
                <button className="button primary" disabled={busy || !dirty}>
                  {busy ? t('Saving…') : t('Save settings')}
                </button>
              </div>
            </form>
          </div>
          <MfaPolicy
            policy={data.mfa_required_roles}
            reload={async (csrf) => (await load(csrf))?.mfa_required_roles}
          />
          <SteamStepUpNotice action="asset-retry" />
          <AdminMapReadiness
            data={data.mapReadiness}
            presentation={data.presentationAssets}
            retryingAsset={retryingAsset}
            retryAsset={(kind) => void retryAsset(kind)}
            refreshing={loading || busy}
            refresh={() => void load()}
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
          </div>
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
  );
}
