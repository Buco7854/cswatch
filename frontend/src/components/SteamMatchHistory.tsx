import { ExternalLink } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { t } from '../i18n';
import { useConfirm } from './Confirmation';

type History = {
  configured: boolean;
  needs_codes: boolean;
  next_offset: number | null;
  items: { match_id: string; share_code: string; demo_id: string | null }[];
};

export default function SteamMatchHistory({
  enabled,
  admin,
}: {
  enabled: boolean;
  admin: boolean;
}) {
  const confirm = useConfirm();
  const [history, setHistory] = useState<History>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [edit, setEdit] = useState(false);
  const [offset, setOffset] = useState(0);
  const [reload, setReload] = useState(0);
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    if (!opened) return;
    const controller = new AbortController();
    api<History>('/api/connections/steam/matches?offset=' + offset, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setHistory(result);
      })
      .catch((failure: Error) => {
        if (!controller.signal.aborted) setError(failure.message);
      });
    return () => controller.abort();
  }, [opened, offset, reload]);

  async function run(action: () => Promise<string | undefined>) {
    if (busy) return;
    setBusy(true);
    setError('');
    setStatus('');
    try {
      setStatus((await action()) ?? '');
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setOffset(0);
      setReload((n) => n + 1);
      setBusy(false);
    }
  }
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const source = String(data.get('share_code')).trim();
    const share_code =
      /^steam:\/\/rungame\/730\/\d{17}\/\+csgo_download_match(?:%20| )(CSGO-[A-Za-z0-9-]+)$/.exec(
        source,
      )?.[1] ?? source;
    const body = JSON.stringify({ auth_code: data.get('auth_code'), share_code });
    void run(async () => {
      await api('/api/connections/steam/history', { method: 'PUT', body });
      form.reset();
      setEdit(false);
      return 'Steam sync codes verified.';
    });
  }
  return (
    <details onToggle={(event) => setOpened(event.currentTarget.open)}>
      <summary>{t('Steam match sync')}</summary>
      {error && (
        <p role="alert" className="error notice">
          {t(error)}
        </p>
      )}
      {status && <p role="status">{t(status)}</p>}
      <p className="muted">
        {t(
          'Match sync lists your recent Premier and Competitive matches so you can add their demos here.',
        )}
      </p>
      {!enabled && (
        <>
          <p role="status">
            {t(
              'This instance does not have everything needed for automatic Steam match sync. You can still upload your demos.',
            )}
          </p>
          {admin && (
            <>
              <p className="muted">
                {t('Add a Steam Web API key as STEAM_API_KEY, then restart the web service.')}
              </p>
              <a
                className="button"
                href="https://steamcommunity.com/dev/apikey"
                target="_blank"
                rel="noreferrer"
              >
                {t('Get a Steam Web API key')}
                <ExternalLink size={15} aria-hidden="true" />
              </a>
            </>
          )}
        </>
      )}
      {!history && opened && !error && <p role="status">{t('Loading matches…')}</p>}
      {enabled && history && (!history.configured || edit) && (
        <form onSubmit={save} aria-busy={busy}>
          <p className="muted">
            {t(
              'Create a game authentication code on Steam Support and copy your most recent match sharing code. To start earlier, copy a recent match sharing code from Your Matches in CS2.',
            )}
          </p>
          <a
            className="button"
            href="https://help.steampowered.com/en/wizard/HelpWithGameIssue/?appid=730&issueid=128"
            target="_blank"
            rel="noreferrer"
          >
            {t('Get your codes on Steam Support')}
            <ExternalLink size={15} aria-hidden="true" />
          </a>
          <p className="muted">
            {t(
              'Your game authentication code is saved encrypted for future syncs. You can remove it here or revoke it on Steam Support.',
            )}
          </p>
          <label>
            {t('Game authentication code')}
            <input
              name="auth_code"
              required
              pattern="[A-Za-z0-9]{4}-[A-Za-z0-9]{5}-[A-Za-z0-9]{4}"
              maxLength={15}
              autoComplete="off"
              type="password"
            />
          </label>
          <label>
            {t('Starting match sharing code')}
            <input name="share_code" required maxLength={120} autoComplete="off" />
          </label>
          <button className="button primary" disabled={busy}>
            {t('Verify and save codes')}
          </button>
          {edit && (
            <button type="button" className="button" disabled={busy} onClick={() => setEdit(false)}>
              {t('Cancel')}
            </button>
          )}
        </form>
      )}
      {history?.needs_codes && (
        <p role="status">{t('Replace your Steam sync codes to resume sync.')}</p>
      )}
      {history?.configured && (
        <div className="actions">
          {enabled && (
            <>
              <button
                className="button primary"
                disabled={busy || history.needs_codes}
                onClick={() =>
                  void run(async () => {
                    const result = await api<{ up_to_date: boolean }>(
                      '/api/connections/steam/history/sync',
                      { method: 'POST' },
                    );
                    return result.up_to_date
                      ? 'Steam match list is up to date.'
                      : 'More Steam matches may be available. Sync again to continue.';
                  })
                }
              >
                {t('Sync Steam matches')}
              </button>
              {!edit && (
                <button className="button" disabled={busy} onClick={() => setEdit(true)}>
                  {t('Replace Steam sync codes')}
                </button>
              )}
            </>
          )}
          <button
            className="button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const accepted = await confirm({
                  title: t('Remove Steam sync'),
                  description: t(
                    'Remove the saved game authentication code and discovered match list? Uploaded demos stay in your library.',
                  ),
                  confirmLabel: t('Remove Steam sync'),
                  tone: 'danger',
                });
                if (!accepted) return;
                await api('/api/connections/steam/history', { method: 'DELETE' });
                setEdit(false);
                return 'Steam match sync was removed.';
              })
            }
          >
            {t('Remove Steam sync')}
          </button>
        </div>
      )}
      {Boolean(history?.items.length) && (
        <p className="muted">
          {t(
            'Only CS2 can download these demos. Choose Download in CS2, then upload the file from the game/csgo/replays folder of your CS2 installation. Older matches may no longer be available.',
          )}
        </p>
      )}
      {history?.items.map((match) => (
        <div key={match.match_id} className="history-row">
          <div>
            <strong>{t('Steam match {{v0}}', { v0: match.match_id })}</strong>
            <small>{match.share_code}</small>
          </div>
          <div className="actions">
            <a
              className="button"
              href={
                'steam://rungame/730/76561202255233023/+csgo_download_match%20' + match.share_code
              }
            >
              {t('Download in CS2')}
            </a>
            {match.demo_id ? (
              <Link className="button" to={'/watch/' + match.demo_id}>
                {t('Open uploaded demo')}
              </Link>
            ) : (
              <Link className="button" to={'/library?upload=1&steamMatch=' + match.match_id}>
                {t('Upload this demo')}
              </Link>
            )}
          </div>
        </div>
      ))}
      {(offset > 0 || history?.next_offset != null) && (
        <div className="actions">
          <button
            className="button"
            disabled={busy || offset === 0}
            onClick={() => setOffset(Math.max(0, offset - 25))}
          >
            {t('Previous page')}
          </button>
          <button
            className="button"
            disabled={busy || history?.next_offset == null}
            onClick={() => setOffset(history!.next_offset!)}
          >
            {t('Next page')}
          </button>
        </div>
      )}
    </details>
  );
}
