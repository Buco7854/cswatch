import { t } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, Link2 } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useApp } from '../context';
import { ProviderBrandNotice, ProviderLogo } from './ProviderBrand';
import { reconcile, steamRedirect } from '../auth-actions';
import { SteamStepUpNotice, useStepUp } from './StepUp';
import { useConfirm } from './Confirmation';
import SteamSyncSettings from './SteamSyncSettings';
export default function Connections() {
  const { user, config, refresh, notify } = useApp();
  const verifySteam = useStepUp('steam');
  const verifyFaceit = useStepUp('faceit');
  const confirm = useConfirm();
  const [params] = useSearchParams();
  const [busy, setBusy] = useState(''),
    [error, setError] = useState<{ at: 'steam' | 'faceit'; message: string }>();
  const steamResult = params.get('steam');
  const cancelled = steamResult === 'cancelled';
  const steamNotice =
    error?.at !== 'steam' &&
    (cancelled
      ? t('Steam linking was cancelled. Start again.')
      : steamResult === 'link-conflict'
        ? t(
            'This Steam account could not be linked. Check which Steam account you’re using and try again.',
          )
        : steamResult === 'link-verification-failed'
          ? t('Steam could not verify your identity. Try the action again.')
          : '');
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
        setError({
          at: name.startsWith('steam-') ? 'steam' : 'faceit',
          message: (e as Error).message,
        });
    } finally {
      if (current()) {
        pending.current = null;
        setBusy('');
      }
    }
  }
  async function unlink(provider: 'steam' | 'faceit') {
    const name = t(provider === 'steam' ? 'Steam' : 'FACEIT');
    if (
      !(await confirm({
        title: t('Unlink {{v0}}?', { v0: name }),
        description:
          provider === 'steam'
            ? t(
                'Steam sign-in and Steam match discovery will stop. Any linked FACEIT profile will also be disconnected.',
              )
            : t('FACEIT match access will stop for this account.'),
        confirmLabel: t('Unlink account'),
        tone: 'danger',
      }))
    )
      return;
    await task(provider + '-unlink', async (current) => {
      const csrf = await (provider === 'steam' ? verifySteam : verifyFaceit)();
      if (!csrf || !current()) return;
      await reconcile(
        api(
          provider === 'steam' ? '/api/auth/steam/link' : '/api/connections/faceit/link',
          {
            method: 'DELETE',
          },
          csrf,
        ),
        refresh,
      );
      if (current()) {
        notify('Account unlinked.');
      }
    });
  }
  const notice = (at: 'steam' | 'faceit') =>
    error?.at === at && (
      <p role="alert" className="error notice">
        {t(error.message)}
      </p>
    );
  if (!user) return null;
  return (
    <>
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
          <SteamStepUpNotice action="steam" />
          <p>
            {steam
              ? t('Steam ID {{v0}}', { v0: steam.subject })
              : t('Link your Steam account to use match discovery and verify your FACEIT account.')}
          </p>
          {!config.steam_enabled && (
            <>
              <p role="status">{t('Steam is not enabled on this instance.')}</p>
              {config.admin_access && (
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
                aria-describedby={steamNotice ? 'steam-link-result' : undefined}
                onClick={() =>
                  void task('steam-link', async (current) => {
                    const csrf = await verifySteam();
                    if (!csrf || !current()) return;
                    await steamRedirect('steam/link', current, undefined, csrf);
                  })
                }
              >
                <ProviderLogo provider="steam" />
                <span>{steam ? t('Verify Steam again') : t('Connect Steam')}</span>
              </button>
            )}
            {steam && (
              <button
                type="button"
                className="button"
                disabled={!!busy}
                onClick={() => void unlink('steam')}
              >
                {t('Unlink Steam')}
              </button>
            )}
            {user.match_sources?.steam && <ViewMatches source="steam" />}
          </div>
          {notice('steam')}
          {steamNotice && (
            <p
              id="steam-link-result"
              className={cancelled ? undefined : 'error notice'}
              role={cancelled ? 'status' : 'alert'}
            >
              {steamNotice}
            </p>
          )}
          {steam && (
            <SteamSyncSettings key={user.id + ':' + steam.subject} admin={config.admin_access} />
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
          <SteamStepUpNotice action="faceit" />
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
                      const csrf = await verifyFaceit();
                      if (!csrf || !current()) return;
                      await reconcile(
                        api('/api/connections/faceit/link', { method: 'POST' }, csrf),
                        refresh,
                      );
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
          {faceitUnavailable && config.admin_access && (
            <p>
              {config.faceit_enabled
                ? t('Set FACEIT_API_KEY on the server, then restart the web service.')
                : t('Turn on FACEIT integration in Administration, or set FACEIT_ENABLED=true.')}
            </p>
          )}
          {faceit && (
            <button className="button" disabled={!!busy} onClick={() => void unlink('faceit')}>
              {t('Remove FACEIT connection')}
            </button>
          )}
        </div>
      </div>
      <ProviderBrandNotice />
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
