import { useEffect, useRef, useState, type FormEvent } from 'react';
import Brand from './Brand';
import { EmailField } from './AuthControls';
import LanguageControl from './LanguageControl';
import { api } from '../api';
import { t } from '../i18n';
import './setup.css';

export default function Setup({ onComplete }: { onComplete: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState(false);
  const scope = useRef({ active: true });
  const pending = useRef<{ scope: { active: boolean } } | null>(null);
  useEffect(() => {
    const current = { active: true };
    scope.current = current;
    return () => {
      current.active = false;
    };
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!scope.current.active || pending.current) return;
    const attempt = { scope: scope.current };
    pending.current = attempt;
    const isCurrent = () => attempt.scope.active && pending.current === attempt;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      if (!created) {
        try {
          await api('/api/setup', {
            method: 'POST',
            body: JSON.stringify({
              username: form.get('username'),
              email: form.get('email'),
              password: form.get('password'),
              setupToken: String(form.get('setupToken') || '').trim(),
            }),
          });
        } catch (failure) {
          // The server may have committed enrollment before its response was
          // interrupted. Check the authoritative setup/session state once. A
          // still-uninitialized instance keeps the user's live form values.
          try {
            await onComplete();
          } catch {}
          throw failure;
        }
        if (isCurrent()) setCreated(true);
      }
      await onComplete();
    } catch (failure) {
      if (isCurrent()) setError((failure as Error).message);
    } finally {
      if (isCurrent()) setBusy(false);
      if (pending.current === attempt) pending.current = null;
    }
  }
  return (
    <main id="main" className="setup-page">
      <header className="setup-header">
        <Brand />
        <LanguageControl />
      </header>
      <section className="setup-panel" aria-labelledby="setup-title">
        <h1 id="setup-title">{t('Set up cswatch')}</h1>
        <p>
          {t(
            created
              ? 'Your administrator account is ready. Continue to open the instance.'
              : 'Create the administrator account for this instance.',
          )}
        </p>
        <details>
          <summary>{t('Where is the setup code?')}</summary>
          <p>
            {t(
              'Read the setup-token file in your private data directory. With Docker, run this command on your server.',
            )}
          </p>
          <pre>
            <code>docker compose exec web cat /data/setup-token</code>
          </pre>
        </details>
        <form onSubmit={(event) => void submit(event)}>
          {!created && (
            <>
              <label>
                {t('Setup code')}
                <input
                  name="setupToken"
                  type="password"
                  autoComplete="off"
                  required
                  maxLength={128}
                  autoFocus
                />
              </label>
              <label>
                {t('Username')}
                <input
                  name="username"
                  autoComplete="username"
                  required
                  minLength={3}
                  maxLength={32}
                />
              </label>
              <EmailField />
              <label>
                {t('Password')}
                <input
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={12}
                  maxLength={128}
                />
              </label>
              <p className="muted">{t('Use at least 12 characters.')}</p>
            </>
          )}
          {error && (
            <p className="error" role="alert">
              {t(error)}
            </p>
          )}
          <button className="button primary" disabled={busy}>
            {t(created ? 'Continue' : busy ? 'Creating administrator…' : 'Create administrator')}
          </button>
        </form>
      </section>
    </main>
  );
}
