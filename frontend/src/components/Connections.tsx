import { t } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, Link2 } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useApp } from '../context';
import { ProviderBrandNotice, ProviderLogo } from './ProviderBrand';
import { useConfirm } from './Confirmation';
import SteamSyncSettings from './SteamSyncSettings';
export default function Connections() {
  const { user, config, refresh, notify, signIn } = useApp();
  const confirm = useConfirm();
  const [params] = useSearchParams();
  const [busy, setBusy] = useState(''),
    [error, setError] = useState<{ at: 'steam' | 'faceit'; message: string }>();
  const steam = user?.identities?.find((i) => i.provider === 'steam'),
    faceit = user?.identities?.find((i) => i.provider === 'faceit');
  const faceitVerification = user?.match_sources?.faceit_verification;
  const canVerifyFaceit = faceitVerification === 'ready';
  const faceitUnavailable = !faceitVerification || faceitVerification === 'unavailable';
  const identity = useRef(user?.id);
  identity.current = user?.id;
  const active = useRef(true);
  const pending = useRef<object | null>(null);
  useEffect(() => {
    active.current = true;
    setBusy('');
    setError(undefined);
    return () => {
      active.current = false;
      pending.current = null;
    };
  }, [user?.id]);
  async function task(name: string, fn: (current: () => boolean) => Promise<void>) {
    if (!user || !active.current || pending.current) return;
    const attempt = {};
    pending.current = attempt;
    const current = () =>
      active.current && identity.current === user.id && pending.current === attempt;
    setBusy(name);
    setError(undefined);
    try {
      await fn(current);
    } catch (e) {
      if (current())
        setError({ at: name === 'steam-link' ? 'steam' : 'faceit', message: (e as Error).message });
    } finally {
      if (current()) {
        pending.current = null;
        setBusy('');
      }
    }
  }
  const notice = (at: 'steam' | 'faceit') =>
    error?.at === at && (
      <p role="alert" className="error notice">
        {t(error.message)}
      </p>
    );
  return (
    <>
      {!user ? (
        <div className="inline-state">
          <h2>{t('Your accounts, in one place.')}</h2>
          <p>{t('Sign in to connect Steam and verify your FACEIT profile.')}</p>
          <button className="button primary" onClick={signIn}>
            {t('Sign in')}
          </button>
        </div>
      ) : (
        <>
          {params.get('steam') === 'cancelled' && !error && (
            <p role="status">{t('Steam linking was cancelled. Start again.')}</p>
          )}
          <div className="settings-section">
            <div>
              <h2 className="provider-title">
                <ProviderLogo provider="steam" />
                {t('Steam')}
              </h2>
              <p>
                {t(
                  'Sign in through Steam to verify your identity. Your Steam password stays with Steam.',
                )}
              </p>
              <span className="tag">
                {steam ? (
                  <>
                    <Check size={13} />
                    {t('Connected')}
                  </>
                ) : config.steam_enabled ? (
                  t('Available')
                ) : (
                  t('Not enabled on this instance')
                )}
              </span>
            </div>
            <div className="settings-panel">
              <div className="panel-heading">
                <h3>{t('Steam identity')}</h3>
                <Link2 size={18} />
              </div>
              {notice('steam')}
              <p>
                {steam
                  ? t('Steam ID {{v0}}', { v0: steam.subject })
                  : t(
                      'Link your Steam account to use match discovery and verify your FACEIT account.',
                    )}
              </p>
              {!config.steam_enabled && (
                <>
                  <p role="status">{t('Steam is not enabled on this instance.')}</p>
                  {Boolean(user.is_admin) && (
                    <p className="muted">
                      {t('Turn on Steam sign-in in Administration, or set STEAM_ENABLED=true.')}
                    </p>
                  )}
                </>
              )}
              <div className="actions">
                {config.steam_enabled && (
                  <button
                    type="button"
                    className="button provider-steam-link"
                    disabled={!!busy}
                    onClick={() =>
                      void task('steam-link', async (current) => {
                        const result = await api<{ location: string }>('/api/auth/steam/link', {
                          method: 'POST',
                        });
                        if (current()) window.location.assign(result.location);
                      })
                    }
                  >
                    <ProviderLogo provider="steam" />
                    <span>{steam ? t('Verify Steam again') : t('Connect Steam')}</span>
                  </button>
                )}
                {user.match_sources?.steam && <ViewMatches source="steam" />}
              </div>
              {steam && (
                <SteamSyncSettings
                  key={user.id + ':' + steam.subject}
                  enabled={config.steam_enabled && (!user.is_admin || !!config.steam_discovery)}
                  admin={Boolean(user.is_admin)}
                />
              )}
            </div>
          </div>
          <div className="settings-section">
            <div>
              <h2 className="provider-title">
                <ProviderLogo provider="faceit" />
                {t('FACEIT')}
              </h2>
              {faceit && (
                <span className="tag">
                  <Check size={13} />
                  {t('Connected')}
                </span>
              )}
            </div>
            <div className="settings-panel">
              <div className="panel-heading">
                <h3>{t('FACEIT identity')}</h3>
                <Link2 size={18} />
              </div>
              {notice('faceit')}
              {!error || error.at !== 'faceit' ? (
                <p role={faceitUnavailable ? 'status' : undefined}>
                  {t(
                    faceitUnavailable
                      ? 'This instance does not have everything needed for FACEIT matches.'
                      : faceit
                        ? 'Your FACEIT profile is verified.'
                        : canVerifyFaceit
                          ? 'Verify the FACEIT account linked to your Steam account.'
                          : 'Connect Steam first, then verify the FACEIT account linked to it.',
                  )}
                </p>
              ) : null}
              {(canVerifyFaceit || user.match_sources?.faceit) && (
                <div className="actions">
                  {canVerifyFaceit && (
                    <button
                      className="button provider-faceit-link"
                      disabled={!!busy}
                      onClick={() =>
                        void task('faceit-link', async (current) => {
                          await api('/api/connections/faceit/link', { method: 'POST' });
                          await refresh();
                          if (current()) notify('FACEIT profile verified.');
                        })
                      }
                    >
                      <ProviderLogo provider="faceit" />
                      {busy === 'faceit-link'
                        ? t('Verifying…')
                        : faceit
                          ? t('Verify again')
                          : t('Verify FACEIT')}
                    </button>
                  )}
                  {user.match_sources?.faceit && <ViewMatches source="faceit" />}
                </div>
              )}
              {faceitUnavailable && user.is_admin && (
                <p>
                  {config.faceit_enabled
                    ? t('Set FACEIT_API_KEY on the server, then restart the web service.')
                    : t(
                        'Turn on FACEIT integration in Administration, or set FACEIT_ENABLED=true.',
                      )}
                </p>
              )}
              {faceit && (
                <button
                  className="button"
                  disabled={!!busy}
                  onClick={() =>
                    void task('faceit-remove', async (current) => {
                      if (
                        !(await confirm({
                          title: t('Remove FACEIT connection'),
                          description: t(
                            'Remove the linked FACEIT account? Added demos stay in your library.',
                          ),
                          confirmLabel: t('Remove FACEIT connection'),
                          tone: 'danger',
                        })) ||
                        !current()
                      )
                        return;
                      await api('/api/connections/faceit/link', { method: 'DELETE' });
                      await refresh();
                    })
                  }
                >
                  {t('Remove FACEIT connection')}
                </button>
              )}
            </div>
          </div>
          <ProviderBrandNotice />
        </>
      )}
    </>
  );
}

function ViewMatches({ source }: { source: 'steam' | 'faceit' }) {
  return (
    <Link className="button" to={'/library?source=' + source}>
      {t('View matches')} <ArrowUpRight size={16} aria-hidden="true" />
    </Link>
  );
}
