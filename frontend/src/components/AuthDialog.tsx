import { t } from '../i18n';
import { useLocation } from 'react-router-dom';
import Brand from './Brand';
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { X, ArrowUpRight } from 'lucide-react';
import { api } from '../api';
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
  const scope = useRef({ active: true });
  const pending = useRef<{ scope: { active: boolean } } | null>(null);
  const dialogId = useId();
  const [register, setRegister] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  useEffect(() => {
    const current = { active: true };
    scope.current = current;
    pending.current = null;
    setBusy(false);
    setError('');
    return () => {
      current.active = false;
    };
  }, [location.key, location.pathname, location.search]);
  function dismiss() {
    scope.current.active = false;
    pending.current = null;
    close();
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!scope.current.active || pending.current) return;
    const attempt = { scope: scope.current };
    pending.current = attempt;
    const isCurrent = () => attempt.scope.active && pending.current === attempt;
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError('');
    try {
      await api<{ user: User }>('/api/auth/' + (register ? 'register' : 'login'), {
        method: 'POST',
        body: JSON.stringify(Object.fromEntries(form)),
      });
      // A completed login changes the browser cookie even after dismissal.
      // Only refresh may publish its matching identity and CSRF together. If
      // that check fails, the previous token cannot authorize the new session.
      await refresh();
      if (!isCurrent()) return;
      onSuccess?.();
      dismiss();
    } catch (e) {
      if (isCurrent()) setError((e as Error).message);
    } finally {
      if (isCurrent()) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <dialog
      ref={dialog}
      onCancel={(event) => {
        event.preventDefault();
        dismiss();
      }}
      aria-labelledby={dialogId + '-title'}
      aria-describedby={dialogId + '-description'}
      className={'auth-dialog' + (isWorkspace ? ' member-dialog' : '')}
      onClick={(e) => {
        if (e.target === dialog.current) dismiss();
      }}
    >
      <button
        className="icon-button dialog-close"
        aria-label={t('Close sign in')}
        onClick={dismiss}
      >
        <X size={20} />
      </button>
      <Brand />
      <h2 id={dialogId + '-title'}>
        {register ? t('Your next round starts here.') : t('Back for another look.')}
      </h2>
      <p id={dialogId + '-description'}>
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
            aria-describedby={register ? dialogId + '-username-help' : undefined}
          />
        </label>
        {register && (
          <small id={dialogId + '-username-help'}>
            {t('3–32 letters, digits, underscores, or hyphens.')}
          </small>
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
            aria-describedby={register ? dialogId + '-password-help' : undefined}
          />
        </label>
        {register && (
          <small id={dialogId + '-password-help'}>
            {t('At least 12 characters. Use a unique password.')}
          </small>
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
          disabled={busy}
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
