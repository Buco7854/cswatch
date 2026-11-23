import { t, locale } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, ExternalLink, Link2, RefreshCw } from 'lucide-react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useApp } from '../context';
import { ProviderBrandNotice, ProviderLogo } from './ProviderBrand';
import SteamMatchHistory from './SteamMatchHistory';
type DemoFile = { id: string; file: number; demo_id: string | null };
type History = { items: Match[]; to: number; next_offset: number | null };
const faceitMatchId = /^[A-Za-z0-9_-]{1,128}$/;
function parseMatch(input: string) {
  const value = input.trim();
  if (faceitMatchId.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.origin === 'https://www.faceit.com' && !url.username && !url.password)
      return /^\/[a-z-]+\/cs2\/room\/([A-Za-z0-9_-]{1,128})\/?$/.exec(url.pathname)?.[1];
  } catch {
    return undefined;
  }
}

type Match = {
  match_id: string;
  finished_at?: number | null;
  competition_name?: string | null;
  teams?: Record<string, { nickname: string }> | null;
};
export default function Connections() {
  const { user, config, refresh, notify, signIn } = useApp();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [busy, setBusy] = useState(''),
    [error, setError] = useState<{ at: 'steam' | 'faceit'; message: string }>(),
    [history, setHistory] = useState<History>(),
    [page, setPage] = useState(0),
    [selection, setSelection] = useState<{ matchId: string; files: DemoFile[] }>();
  const steam = user?.identities?.find((i) => i.provider === 'steam'),
    faceit = user?.identities?.find((i) => i.provider === 'faceit');
  const identity = useRef(user?.id);
  identity.current = user?.id;
  const active = useRef(true);
  const results = useRef<HTMLElement>(null);
  const pending = useRef<object | null>(null);
  useEffect(() => {
    active.current = true;
    setBusy('');
    setError(undefined);
    setHistory(undefined);
    setPage(0);
    setSelection(undefined);
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
  function loadFaceit(offset = 0, through?: number) {
    void task('history', async (current) => {
      const params = new URLSearchParams({ offset: String(offset) });
      if (through !== undefined) params.set('to', String(through));
      const result = await api<History>('/api/connections/faceit/matches?' + params);
      if (current()) {
        setPage(offset);
        setHistory(result);
        requestAnimationFrame(() =>
          results.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }),
        );
      }
    });
  }
  function selectMatch(matchId: string) {
    setSelection(undefined);
    void task('details', async (current) => {
      const result = await api<{ files: DemoFile[] }>(
        '/api/connections/faceit/match-demos?' + new URLSearchParams({ match_id: matchId }),
      );
      if (current()) setSelection({ matchId, files: result.files });
    });
  }
  async function importMatch(match_id: string, resource_id: string) {
    await task(match_id, async (current) => {
      const r = await api<{ id: string }>('/api/connections/faceit/import', {
        method: 'POST',
        body: JSON.stringify({ match_id, resource_id }),
      });
      if (current()) nav('/watch/' + r.id);
    });
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
                <a
                  className="button"
                  href="https://steamcommunity.com/my/gcpd/730/"
                  target="_blank"
                  rel="noreferrer"
                >
                  {t('Open Steam match history')}
                  <ExternalLink size={14} aria-hidden="true" />
                </a>
              </div>
              {steam && (
                <SteamMatchHistory
                  key={user.id + ':' + steam.subject}
                  enabled={config.steam_enabled && config.steam_discovery}
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
                    t('Not set up on this instance')
                  )
                ) : (
                  t('Not enabled on this instance')
                )}
              </span>
            </div>
            <div className="settings-panel">
              <div className="panel-heading">
                <h3>{t('Match history & imports')}</h3>
                <Link2 size={18} />
              </div>
              {notice('faceit')}
              <p>
                {faceit
                  ? t(
                      'Your FACEIT profile is verified. Load your recent matches to start a review.',
                    )
                  : steam
                    ? t('Verify the FACEIT account linked to your Steam account.')
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
                        if (current()) {
                          setHistory(undefined);
                          setSelection(undefined);
                          notify('FACEIT profile verified.');
                        }
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
                      disabled={!!busy || !config.faceit_configured}
                      onClick={() => loadFaceit()}
                    >
                      <RefreshCw size={15} className={busy === 'history' ? 'spin' : ''} />
                      {busy === 'history' ? t('Loading matches…') : t('Recent matches')}
                    </button>
                  )}
                </div>
              )}
              {!(config.faceit_enabled && config.faceit_configured) && (
                <>
                  <p role="status">
                    {t(
                      'This instance does not have everything needed for FACEIT matches. You can still upload your demos.',
                    )}
                  </p>
                  {Boolean(user.is_admin) && (
                    <p className="muted">
                      {config.faceit_enabled
                        ? t('Set FACEIT_API_KEY on the server, then restart the web service.')
                        : t(
                            'Turn on FACEIT integration in Administration, or set FACEIT_ENABLED=true.',
                          )}
                    </p>
                  )}
                </>
              )}
              {config.faceit_enabled && config.faceit_configured && (
                <>
                  <p className="muted">
                    {config.faceit_downloads
                      ? t('FACEIT demos can be downloaded here while FACEIT still has them.')
                      : t(
                          'This instance does not have everything needed to download FACEIT demos. You can still upload them yourself.',
                        )}
                  </p>
                  {!config.faceit_downloads && Boolean(user.is_admin) && (
                    <p className="muted">
                      {t(
                        'Set an approved FACEIT Downloads API token as FACEIT_DOWNLOAD_TOKEN, then restart the web service.',
                      )}
                    </p>
                  )}
                </>
              )}
              {config.faceit_enabled &&
                config.faceit_configured &&
                config.faceit_downloads &&
                faceit && (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const raw = String(new FormData(e.currentTarget).get('match'));
                      const matchId = parseMatch(raw);
                      if (matchId) selectMatch(matchId);
                      else
                        setError({
                          at: 'faceit',
                          message: 'Enter a FACEIT CS2 match ID or match room URL.',
                        });
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
                    <button
                      className="button primary"
                      disabled={!!busy || !config.faceit_downloads}
                    >
                      {busy === 'details' ? t('Loading matches…') : t('Find demo files')}
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
          {history && (
            <section ref={results} className="history-panel">
              <h2>{t('Recent FACEIT matches')}</h2>
              {history.items.length === 0 && (
                <p role="status">{t('FACEIT lists no CS2 matches for this account.')}</p>
              )}
              {history.items.map((m) => (
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
                    onClick={() => selectMatch(m.match_id)}
                  >
                    {t('Find demo files')}
                    <ArrowUpRight size={15} />
                  </button>
                </div>
              ))}
              {(page > 0 || history.next_offset !== null) && (
                <div className="actions">
                  <button
                    className="button"
                    disabled={!!busy || page === 0}
                    onClick={() => loadFaceit(Math.max(0, page - 20), history.to)}
                  >
                    {t('Previous page')}
                  </button>
                  <button
                    className="button"
                    disabled={!!busy || history.next_offset === null}
                    onClick={() => loadFaceit(history.next_offset!, history.to)}
                  >
                    {t('Next page')}
                  </button>
                </div>
              )}
            </section>
          )}
          {selection && (
            <section className="history-panel" aria-live="polite">
              <h2>{t('FACEIT demo files')}</h2>
              <p>{selection.matchId}</p>
              {selection.files.map((file) => (
                <div key={file.id} className="history-row">
                  <strong>{t('Demo file {{v0}}', { v0: file.file })}</strong>
                  {file.demo_id ? (
                    <Link className="button" to={'/watch/' + file.demo_id}>
                      {t('Open uploaded demo')}
                    </Link>
                  ) : (
                    <button
                      className="button"
                      disabled={!!busy || !config.faceit_downloads}
                      onClick={() => void importMatch(selection.matchId, file.id)}
                    >
                      {busy === selection.matchId
                        ? t('Working…')
                        : t('Import demo file {{v0}}', { v0: file.file })}
                    </button>
                  )}
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
