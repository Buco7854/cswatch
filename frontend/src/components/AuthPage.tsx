import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowUpRight, Eye, EyeOff, Moon, Sun } from 'lucide-react';
import { api } from '../api';
import { authPath, authReturnPath } from '../auth-navigation';
import { useApp } from '../context';
import { t } from '../i18n';
import type { User } from '../types';
import Brand from './Brand';
import LanguageControl from './LanguageControl';
import { ProviderBrandNotice, SteamSignInLink } from './ProviderBrand';

export default function AuthPage({
  theme,
  toggleTheme,
}: {
  theme: string;
  toggleTheme: () => void;
}) {
  const { config, refresh } = useApp();
  const location = useLocation(),
    navigate = useNavigate();
  const register = location.pathname === '/register';
  const query = new URLSearchParams(location.search);
  const returnTo = authReturnPath(query.get('returnTo'));
  const cancelled = query.get('steam') === 'cancelled';
  const backTo = authReturnPath(location.state?.authFrom, returnTo === '/library' ? '/' : returnTo);
  const scope = useRef({ active: true });
  const pending = useRef<object | null>(null);
  const id = useId();
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [showPassword, setShowPassword] = useState(false);
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
    const current = scope.current,
      attempt = {};
    pending.current = attempt;
    const isCurrent = () => current.active && pending.current === attempt;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      await api<{ user: User }>('/api/auth/' + (register ? 'register' : 'login'), {
        method: 'POST',
        body: JSON.stringify(Object.fromEntries(form)),
      });
      // The cookie may change even after leaving this page. Always reconcile
      // identity and CSRF together; only the initiating page may navigate.
      await refresh();
      if (isCurrent()) navigate(returnTo, { replace: true });
    } catch (failure) {
      if (isCurrent()) setError((failure as Error).message);
    } finally {
      if (isCurrent()) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  if (register && !config.registrations_enabled)
    return <Navigate replace to={authPath('login', returnTo)} state={location.state} />;
  return (
    <div className="auth-page">
      <header className="auth-header">
        <Brand />
        <div className="auth-utilities">
          <LanguageControl />
          <button
            className="icon-button"
            aria-label={t(theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme')}
            onClick={toggleTheme}
          >
            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
          </button>
        </div>
      </header>
      <main id="main" className="auth-main">
        <section className="auth-content" aria-labelledby={id + '-title'}>
          {(config.public_access || register) && (
            <Link
              className="auth-back"
              to={config.public_access ? backTo : authPath('login', returnTo)}
            >
              <ArrowLeft size={16} />
              {t('Go back')}
            </Link>
          )}
          <header className="auth-intro">
            <h1 id={id + '-title'}>{register ? t('Create account') : t('Sign in')}</h1>
            <p>
              {!config.public_access
                ? t('This instance is open to signed-in members only.')
                : register
                  ? t('Keep your demos in your library.')
                  : t('Sign in to your review room.')}
            </p>
          </header>
          {cancelled && !error && (
            <p role="status">{t('Steam sign-in was cancelled. Start again.')}</p>
          )}
          {config.steam_enabled && (
            <SteamSignInLink
              className="auth-steam"
              returnTo={returnTo}
              label={t('Continue with Steam')}
            />
          )}
          {config.steam_enabled && <p className="auth-alternative">{t('or use your account')}</p>}
          <form
            onSubmit={submit}
            aria-label={register ? t('Create account') : t('Sign in')}
            aria-busy={busy}
          >
            <label htmlFor={id + '-username'}>{t('Username')}</label>
            <input
              id={id + '-username'}
              name="username"
              autoComplete="username"
              required
              minLength={3}
              maxLength={32}
              pattern="[A-Za-z0-9_-]+"
              aria-describedby={register ? id + '-username-help' : undefined}
            />
            {register && (
              <small id={id + '-username-help'}>
                {t('3–32 letters, digits, underscores, or hyphens.')}
              </small>
            )}
            <label htmlFor={id + '-password'} className="auth-password-label">
              {t('Password')}
            </label>
            <div className="auth-password">
              <input
                id={id + '-password'}
                name="password"
                type={showPassword ? 'text' : 'password'}
                autoComplete={register ? 'new-password' : 'current-password'}
                required
                minLength={12}
                maxLength={128}
                aria-describedby={register ? id + '-password-help' : undefined}
              />
              <button
                type="button"
                className="icon-button"
                aria-label={showPassword ? t('Hide password') : t('Show password')}
                aria-pressed={showPassword}
                onClick={() => setShowPassword(!showPassword)}
              >
                {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
            {register && (
              <small id={id + '-password-help'}>
                {t('At least 12 characters. Use a unique password.')}
              </small>
            )}
            {error && (
              <p className="auth-error" role="alert">
                {t(error)}
              </p>
            )}
            <button className="button primary auth-submit" disabled={busy}>
              {busy ? t('One moment…') : register ? t('Create account') : t('Sign in')}
              <ArrowUpRight size={17} />
            </button>
          </form>
          {config.registrations_enabled ? (
            <Link
              className="auth-switch-link"
              to={authPath(register ? 'login' : 'register', returnTo)}
              state={{ authFrom: backTo }}
              aria-disabled={busy}
              onClick={(event) => {
                if (busy) event.preventDefault();
              }}
            >
              {register ? t('Already have an account? Sign in') : t('New here? Create an account')}
            </Link>
          ) : (
            <p className="auth-policy">
              {t(
                'New registrations are closed on this instance. Existing members can still sign in.',
              )}
            </p>
          )}
          <p className="auth-recovery">
            {t('Lost access? Contact this instance’s administrator for account recovery.')}
          </p>
          {config.steam_enabled && <ProviderBrandNotice />}
        </section>
      </main>
    </div>
  );
}
