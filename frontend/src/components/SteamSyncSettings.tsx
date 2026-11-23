import { ExternalLink } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { useApp } from '../context';
import { api } from '../api';
import { t } from '../i18n';
import { useConfirm } from './Confirmation';

type History = {
  configured: boolean;
  needs_codes: boolean;
};

export default function SteamSyncSettings({
  enabled,
  admin,
}: {
  enabled: boolean;
  admin: boolean;
}) {
  const confirm = useConfirm();
  const { refresh } = useApp();
  const [history, setHistory] = useState<History>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [edit, setEdit] = useState(false);
  const [reload, setReload] = useState(0);
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    if (!opened) return;
    const controller = new AbortController();
    api<History>('/api/connections/steam/history', { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setHistory(result);
      })
      .catch((failure: Error) => {
        if (!controller.signal.aborted) setError(failure.message);
      });
    return () => controller.abort();
  }, [opened, reload]);

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
      await refresh();
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
        {t('Save codes to sync your Premier and Competitive matches in the library.')}
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
      {!history && opened && !error && <p role="status">{t('Loading Steam sync settings…')}</p>}
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
                await refresh();
                setEdit(false);
                return 'Steam match sync was removed.';
              })
            }
          >
            {t('Remove Steam sync')}
          </button>
        </div>
      )}
    </details>
  );
}
