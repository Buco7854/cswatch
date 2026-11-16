import { t } from '../i18n';
import { useLocation } from 'react-router-dom';
import Brand from './Brand';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { X, ArrowUpRight } from 'lucide-react';
import { api, setCsrf } from '../api';
import { useApp } from '../context';
import type { User } from '../types';
export default function AuthDialog({
  close,
  returnTo = '/library',
  onSuccess,
}: {
  close: () => void;
  returnTo?: string;
  onSuccess?: () => void;
}) {
  const { config, refresh } = useApp();
  const location = useLocation();
  const isWorkspace = !['/', '/features/viewer', '/features/imports', '/self-host'].includes(
    location.pathname,
  );
  const dialog = useRef<HTMLDialogElement>(null);
  const [register, setRegister] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError('');
    try {
      const r = await api<{ user: User }>('/api/auth/' + (register ? 'register' : 'login'), {
        method: 'POST',
        body: JSON.stringify(Object.fromEntries(form)),
      });
      setCsrf(r.user.csrf);
      await refresh();
      onSuccess?.();
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      onCancel={close}
      className={'auth-dialog' + (isWorkspace ? ' member-dialog' : '')}
      onClick={(e) => {
        if (e.target === dialog.current) close();
      }}
    >
      <button className="icon-button dialog-close" aria-label={t('Close sign in')} onClick={close}>
        <X size={20} />
      </button>
      <Brand />
      <h2>{register ? t('Your next round starts here.') : t('Back for another look.')}</h2>
      <p>
        {register
          ? t('Create an account to keep your demos private.')
          : t('Sign in to your review room.')}
      </p>
      {config.steam_enabled && (
        <a
          className="button steam-button"
          href={'/api/auth/steam?returnTo=' + encodeURIComponent(returnTo)}
        >
          {t('Continue with Steam')}
          <ArrowUpRight size={17} />
        </a>
      )}
      {config.steam_enabled && <div className="or">{t('or use your account')}</div>}
      <form onSubmit={submit}>
        <label>
          {t('Username')}
          <input
            name="username"
            autoComplete="username"
            required
            minLength={3}
            maxLength={32}
            pattern="[A-Za-z0-9_-]+"
            aria-describedby="username-help"
          />
        </label>
        {register && (
          <small id="username-help">{t('3–32 letters, digits, underscores, or hyphens.')}</small>
        )}
        <label>
          {t('Password')}
          <input
            name="password"
            type="password"
            autoComplete={register ? 'new-password' : 'current-password'}
            required
            minLength={12}
            maxLength={128}
            aria-describedby="password-help"
          />
        </label>
        {register && (
          <small id="password-help">{t('At least 12 characters. Use a unique password.')}</small>
        )}
        {error && (
          <p className="error" role="alert">
            {t(error)}
          </p>
        )}
        <button className="button primary wide" disabled={busy}>
          {busy ? t('One moment…') : register ? t('Create account') : t('Sign in')}
          <ArrowUpRight size={17} />
        </button>
      </form>
      {config.registrations_enabled && (
        <button
          className="text-button auth-switch"
          onClick={() => {
            setRegister(!register);
            setError('');
          }}
        >
          {register ? t('Already have an account? Sign in') : t('New here? Create an account')}
        </button>
      )}
      <small className="recovery-note">
        {t('Lost access? Contact this instance’s administrator for account recovery.')}
      </small>
    </dialog>
  );
}
