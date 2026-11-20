import { t, locale } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowUpRight, Check, Link2, RefreshCw } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useApp } from '../context';
import { ProviderBrandNotice, ProviderLogo, SteamSignInLink } from './ProviderBrand';
type Match = {
  match_id: string;
  finished_at?: number;
  competition_name?: string;
  teams?: Record<string, { nickname: string }>;
};
export default function Connections() {
  const { user, config, refresh, notify, signIn } = useApp();
  const nav = useNavigate();
  const [busy, setBusy] = useState(''),
    [error, setError] = useState(''),
    [matches, setMatches] = useState<Match[]>([]),
    [code, setCode] = useState('');
  const steam = user?.identities?.find((i) => i.provider === 'steam'),
    faceit = user?.identities?.find((i) => i.provider === 'faceit');
  const identity = useRef(user?.id);
  identity.current = user?.id;
  const active = useRef(true);
  const pending = useRef<object | null>(null);
  useEffect(() => {
    active.current = true;
    setBusy('');
    setError('');
    setMatches([]);
    setCode('');
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
    setError('');
    try {
      await fn(current);
    } catch (e) {
      if (current()) setError((e as Error).message);
    } finally {
      if (current()) {
        pending.current = null;
        setBusy('');
      }
    }
  }
  async function discover(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.currentTarget));
    await task('steam', async (current) => {
      const r = await api<{ share_code: string | null; message: string }>(
        '/api/connections/steam/next-match',
        { method: 'POST', body: JSON.stringify(body) },
      );
      if (current()) {
        setCode(r.share_code || t('No newer match is available.'));
        notify(r.message);
      }
    });
  }
  async function importMatch(match_id: string) {
    await task(match_id, async (current) => {
      const r = await api<{ id: string }>('/api/connections/faceit/import', {
        method: 'POST',
        body: JSON.stringify({ match_id }),
      });
      if (current()) nav('/watch/' + r.id);
    });
  }
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
          {error && (
            <p role="alert" className="error notice">
              {t(error)}
            </p>
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
                  t('Disabled by administrator')
                )}
              </span>
            </div>
            <div className="settings-panel">
              <div className="panel-heading">
                <h3>{t('Steam identity')}</h3>
                <Link2 size={18} />
              </div>
              <p>
                {steam
                  ? t('Steam ID {{v0}}', { v0: steam.subject })
                  : t(
                      'Link your Steam account to use match discovery and verify your FACEIT account.',
                    )}
              </p>
              {config.steam_enabled && (
                <SteamSignInLink
                  returnTo="/account/connections"
                  label={steam ? t('Verify Steam again') : t('Connect Steam')}
                />
              )}
              {config.steam_enabled && steam && (
                <details>
                  <summary>{t('Discover the next match')}</summary>
                  <p>
                    {t(
                      'Enter a match sharing code and your game authentication code from Steam’s “Personal Game Data”. These are used for this request and are not stored.',
                    )}
                  </p>
                  <form onSubmit={discover}>
                    <label>
                      {t('Game authentication code')}
                      <input
                        name="auth_code"
                        required
                        minLength={5}
                        maxLength={40}
                        autoComplete="off"
                        type="password"
                      />
                    </label>
                    <label>
                      {t('Last match sharing code')}
                      <input
                        name="share_code"
                        required
                        pattern="CSGO(-[A-Za-z0-9]{5}){5}"
                        placeholder={t('CSGO-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx')}
                      />
                    </label>
                    <button className="button primary" disabled={!!busy || !config.steam_discovery}>
                      {busy === 'steam' ? t('Checking…') : t('Find next match')}
                    </button>
                    {!config.steam_discovery && (
                      <small>{t('The administrator must configure a Steam Web API key.')}</small>
                    )}
                  </form>
                  {code && <p className="code-result">{code}</p>}
                  <p className="muted">
                    {t(
                      'Steam sign-in does not grant access to demo files. Download a discovered match in CS2, then upload its .dem file.',
                    )}
                  </p>
                </details>
              )}
            </div>
          </div>
          <div className="settings-section">
            <div>
              <h2 className="provider-title">
                <ProviderLogo provider="faceit" />
                {t('FACEIT')}
              </h2>
              <p>
                {t(
                  'We match FACEIT’s CS2 Steam ID with your verified Steam identity. No nickname guessing.',
                )}
              </p>
              <span className="tag">
                {faceit ? (
                  <>
                    <Check size={13} />
                    {t('Connected')}
                  </>
                ) : config.faceit_enabled ? (
                  config.faceit_configured ? (
                    t('Available')
                  ) : (
                    t('Administrator setup required')
                  )
                ) : (
                  t('Disabled by administrator')
                )}
              </span>
            </div>
            <div className="settings-panel">
              <div className="panel-heading">
                <h3>{t('Match history & imports')}</h3>
                <Link2 size={18} />
              </div>
              <p>
                {faceit
                  ? t(
                      'Your FACEIT profile is verified. Load your recent matches to start a review.',
                    )
                  : t('Connect Steam first, then verify the FACEIT account linked to it.')}
              </p>
              {config.faceit_enabled && (
                <div className="actions">
                  <button
                    className="button provider-faceit-link"
                    disabled={!!busy || !steam || !config.faceit_configured}
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
                  {faceit && (
                    <button
                      className="button"
                      disabled={!!busy}
                      onClick={() =>
                        void task('history', async (current) => {
                          const r = await api<{ items: Match[] }>(
                            '/api/connections/faceit/matches',
                          );
                          if (!current()) return;
                          setMatches(r.items || []);
                          if (!r.items?.length) notify('No recent CS2 matches found.');
                        })
                      }
                    >
                      <RefreshCw size={15} className={busy === 'history' ? 'spin' : ''} />
                      {busy === 'history' ? t('Loading matches…') : t('Recent matches')}
                    </button>
                  )}
                </div>
              )}
              {config.faceit_enabled && !config.faceit_configured && (
                <p className="muted">
                  {t('The administrator must configure a FACEIT Data API key.')}
                </p>
              )}
              <p className="muted">
                {config.faceit_downloads
                  ? t('Downloads API is configured. Demo availability still depends on FACEIT.')
                  : t(
                      'Automatic demo downloads need an approved FACEIT Downloads API token. Manual uploads always work.',
                    )}
              </p>
              {config.faceit_enabled && config.faceit_downloads && faceit && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const raw = String(new FormData(e.currentTarget).get('match'));
                    const match_id = raw.match(/1-[0-9a-f-]{36}/i)?.[0] || raw;
                    void importMatch(match_id);
                  }}
                >
                  <label>
                    {t('FACEIT match ID or match room URL')}
                    <input
                      name="match"
                      required
                      placeholder="https://www.faceit.com/…/room/1-…"
                      maxLength={300}
                    />
                  </label>
                  <button className="button primary" disabled={!!busy || !config.faceit_downloads}>
                    {busy ? t('Working…') : t('Import match')}
                    <ArrowUpRight size={16} />
                  </button>
                </form>
              )}
              {config.faceit_enabled && !config.faceit_downloads && (
                <Link className="button" to="/library?upload=1">
                  {t('Add a demo')}
                  <ArrowUpRight size={16} />
                </Link>
              )}
            </div>
          </div>
          {matches.length > 0 && (
            <section className="history-panel">
              <h2>{t('Recent FACEIT matches')}</h2>
              {matches.map((m) => (
                <div key={m.match_id} className="history-row">
                  <div>
                    <strong>
                      {Object.values(m.teams || {})
                        .map((t) => t.nickname)
                        .join(t(' vs ')) ||
                        m.competition_name ||
                        t('FACEIT match')}
                    </strong>
                    <small>
                      {m.finished_at
                        ? new Date(m.finished_at * 1000).toLocaleString(locale())
                        : m.match_id}
                    </small>
                  </div>
                  <button
                    className="button"
                    disabled={!!busy || !config.faceit_downloads}
                    onClick={() => void importMatch(m.match_id)}
                  >
                    {t('Import')}
                    <ArrowUpRight size={15} />
                  </button>
                </div>
              ))}
            </section>
          )}
          <ProviderBrandNotice />
        </>
      )}
    </>
  );
}
