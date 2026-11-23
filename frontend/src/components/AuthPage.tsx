import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowUpRight, KeyRound } from 'lucide-react';
import {
  authenticatePasskey,
  authPost,
  passkeySupported,
  reconcile,
  steamRedirect,
} from '../auth-actions';
import { authPath, authReturnPath } from '../auth-navigation';
import { useApp } from '../context';
import { t } from '../i18n';
import type { AuthStatus } from '../types';
import { useAction } from '../useAction';
import {
  ActionError,
  CopyValue,
  DisplayNameField,
  EmailField,
  PasswordField,
} from './AuthControls';
import AuthFrame, { type AuthAppearance } from './AuthFrame';
import ProofForm from './ProofForm';
import { ProviderBrandNotice, ProviderLogo } from './ProviderBrand';

type RegistrationReceipt = { username: string; userId: string | null; context: string };

function ownsReceipt(
  receipt: RegistrationReceipt,
  { user, session }: Pick<AuthStatus, 'user' | 'session'>,
) {
  return receipt.userId
    ? receipt.userId === user?.id
    : session.stage === 'enroll' && receipt.context === session.csrf;
}

export default function AuthPage(appearance: AuthAppearance) {
  const { captureSessionVersion, config, refresh, session, signOut: logout, user } = useApp();
  const alreadySignedIn = useRef(Boolean(user));
  const location = useLocation();
  const navigate = useNavigate();
  const register = /^\/register\/?$/.test(location.pathname);
  const query = new URLSearchParams(location.search);
  const returnTo = authReturnPath(query.get('returnTo'));
  const steamResult = query.get('steam');
  const cancelled = steamResult === 'cancelled';
  const verificationFailed = steamResult === 'verification-failed';
  const backTo = authReturnPath(location.state?.authFrom, returnTo === '/library' ? '/' : returnTo);
  const task = useAction();
  const continueTask = useAction();
  const signOut = useAction();
  const [assigned, setAssigned] = useState<RegistrationReceipt | null>(null);
  const [action, setAction] = useState<'password' | 'passkey' | 'steam'>('password');
  const signInName = assigned && ownsReceipt(assigned, { user, session }) ? assigned.username : '';
  const title = useRef<HTMLHeadingElement>(null);
  const challenge = session.stage === 'challenge' && !task.busy;
  const currentAccount = !task.busy && (user?.username || (register && session.username));
  const steamNotice =
    !task.error &&
    (cancelled
      ? t('Steam sign-in was cancelled. Start again.')
      : verificationFailed
        ? t('Steam could not verify your identity. Try the action again.')
        : steamResult === 'registration-closed'
          ? t(
              'Registration is closed. Use an existing linked Steam account, or sign in another way.',
            )
          : '');
  useEffect(() => {
    if (assigned && !signInName) setAssigned(null);
  }, [assigned, signInName]);
  useEffect(() => {
    if (signInName || challenge || currentAccount) title.current?.focus();
  }, [signInName, challenge, currentAccount]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.currentTarget));
    setAction('password');
    await task.run(async (active) => {
      const { result, status } = await reconcile(
        authPost(register ? 'register' : 'login', body, session.csrf),
        refresh,
      );
      if (!active()) return;
      if (register) {
        const username = result.user?.username ?? result.session.username;
        if (!username) return;
        const receipt = { username, userId: result.user?.id ?? null, context: result.session.csrf };
        if (ownsReceipt(receipt, status)) setAssigned(receipt);
      } else if (result.user?.id && result.user.id === status.user?.id) {
        navigate(returnTo, { replace: true });
      }
    });
  }

  function continueToWorkspace() {
    void continueTask.run(async (active) => {
      const status = await refresh();
      const sameAccount = user ? status.user?.id === user.id : status.session.csrf === session.csrf;
      if (active() && sameAccount)
        navigate(
          status.session.stage === 'enroll'
            ? '/account?' + new URLSearchParams({ returnTo })
            : returnTo,
          { replace: true },
        );
    });
  }

  function endSession() {
    void signOut.run(() => logout());
  }

  if (alreadySignedIn.current && user && !signInName && !task.busy && !verificationFailed)
    return <Navigate replace to={returnTo} />;
  if (register && !config.registrations_enabled && !signInName && !currentAccount)
    return <Navigate replace to={authPath('login', returnTo)} state={location.state} />;
  return (
    <AuthFrame {...appearance}>
      <section className="auth-content" aria-labelledby="auth-title">
        {!challenge && !signInName && (config.public_access || register) && (
          <Link
            className="auth-back"
            to={config.public_access ? backTo : authPath('login', returnTo)}
          >
            <ArrowLeft size={16} aria-hidden="true" />
            {t('Go back')}
          </Link>
        )}
        <header className="auth-intro">
          <h1 id="auth-title" ref={title} tabIndex={-1}>
            {signInName
              ? t('Save your sign-in name')
              : challenge
                ? t('Verify your sign-in')
                : currentAccount
                  ? t('Signed in as {{username}}', { username: currentAccount })
                  : t(register ? 'Create account' : 'Sign in')}
          </h1>
          {(!currentAccount || signInName) && (
            <p>
              {t(
                signInName
                  ? 'You can sign in with this username or your email address.'
                  : challenge
                    ? 'Choose a second factor to finish signing in.'
                    : !config.public_access
                      ? 'This instance is open to signed-in members only.'
                      : register
                        ? 'Keep your demos in your library.'
                        : 'Sign in to your review room.',
              )}
            </p>
          )}
          {verificationFailed && (challenge || signInName || currentAccount) && (
            <p role="status">{t('Steam could not verify your identity. Try the action again.')}</p>
          )}
        </header>
        {challenge ? (
          <>
            <ProofForm
              key={session.csrf}
              mode="mfa"
              factors={session.factors}
              returnTo={returnTo}
              onVerified={() => navigate(returnTo, { replace: true })}
            />
            <button
              className="button auth-secondary"
              type="button"
              disabled={signOut.busy}
              onClick={endSession}
            >
              {t('Sign out')}
            </button>
            <ActionError error={signOut.error} />
          </>
        ) : signInName || currentAccount ? (
          <>
            {signInName && <CopyValue wrap label={t('Username')} value={signInName} />}
            <ActionError error={continueTask.error || signOut.error || task.error} />
            <button
              className="button primary"
              type="button"
              disabled={continueTask.busy || signOut.busy}
              onClick={continueToWorkspace}
            >
              {t('Continue')}
            </button>
            {!signInName && (
              <button
                className="button auth-secondary"
                type="button"
                disabled={continueTask.busy || signOut.busy}
                onClick={endSession}
              >
                {t('Sign out to switch accounts')}
              </button>
            )}
          </>
        ) : (
          <>
            <div className="auth-sign-in-methods">
              {!register && passkeySupported() && (
                <button
                  className="button auth-method-button"
                  type="button"
                  disabled={task.busy}
                  onClick={() => {
                    setAction('passkey');
                    void task.run(async (active) => {
                      const { result, status } = await reconcile(
                        authenticatePasskey(
                          'passkeys/login',
                          () => active() && captureSessionVersion(session.csrf) !== undefined,
                          session.csrf,
                        ),
                        refresh,
                      );
                      if (active() && result?.user?.id && result.user.id === status.user?.id)
                        navigate(returnTo, { replace: true });
                    });
                  }}
                >
                  <KeyRound size={17} aria-hidden="true" />
                  {t('Sign in with a passkey')}
                </button>
              )}
              {action === 'passkey' && <ActionError error={task.error} />}
              {config.steam_enabled && (
                <button
                  className="button provider-steam-link auth-method-button"
                  type="button"
                  disabled={task.busy}
                  aria-describedby={steamNotice ? 'steam-sign-in-result' : undefined}
                  onClick={() => {
                    setAction('steam');
                    void task.run(async (active) => {
                      const status = await refresh();
                      if (active() && status.session.stage === 'anonymous')
                        await steamRedirect('steam', active, returnTo);
                    });
                  }}
                >
                  <ProviderLogo provider="steam" />
                  {t('Continue with Steam')}
                </button>
              )}
              {action === 'steam' && <ActionError error={task.error} />}
              {steamNotice && (
                <p
                  id="steam-sign-in-result"
                  className={cancelled ? undefined : 'error auth-error'}
                  role={cancelled ? 'status' : 'alert'}
                >
                  {steamNotice}
                </p>
              )}
            </div>
            {(config.steam_enabled || (!register && passkeySupported())) && (
              <p className="auth-alternative">{t('or use your password')}</p>
            )}
            <form
              onSubmit={submit}
              aria-label={t(register ? 'Create account' : 'Sign in')}
              aria-busy={task.busy}
              className="auth-credentials"
            >
              {register ? (
                <>
                  <DisplayNameField />
                  <EmailField />
                </>
              ) : (
                <label className="security-field">
                  {t('Username or email')}
                  <input
                    name="username"
                    autoComplete="username"
                    autoCapitalize="none"
                    spellCheck={false}
                    required
                    maxLength={254}
                  />
                </label>
              )}
              <PasswordField
                label={t('Password')}
                name="password"
                autoComplete={register ? 'new-password' : 'current-password'}
                required
                minLength={12}
                maxLength={128}
                aria-describedby={register ? 'register-password-help' : undefined}
              />
              {register && (
                <small id="register-password-help">
                  {t('At least 12 characters. Use a unique password.')}
                </small>
              )}
              {action === 'password' && <ActionError error={task.error} />}
              <button className="button primary auth-submit" disabled={task.busy}>
                {t(task.busy ? 'One moment…' : register ? 'Create account' : 'Sign in')}
                <ArrowUpRight size={17} aria-hidden="true" />
              </button>
            </form>
            {config.registrations_enabled ? (
              <Link
                className="auth-switch-link"
                to={authPath(register ? 'login' : 'register', returnTo)}
                state={{ authFrom: backTo }}
                aria-disabled={task.busy}
                onClick={(event) => {
                  if (task.busy) event.preventDefault();
                }}
              >
                {t(register ? 'Already have an account? Sign in' : 'New here? Create an account')}
              </Link>
            ) : (
              <p className="auth-policy">
                {t(
                  'New registrations are closed on this instance. Existing members can still sign in.',
                )}
              </p>
            )}
            <Link className="auth-switch-link" to="/recover">
              {t('Recover your account')}
            </Link>
            {config.steam_enabled && <ProviderBrandNotice />}
          </>
        )}
      </section>
    </AuthFrame>
  );
}
