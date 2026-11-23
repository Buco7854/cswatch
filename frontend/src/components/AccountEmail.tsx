import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { api, SessionChangedError } from '../api';
import {
  emailDestination,
  forgetEmailDestination,
  rememberEmailDestination,
  takeMailFragment,
} from '../auth-navigation';
import { authPost, reconcile } from '../auth-actions';
import { useApp } from '../context';
import { t } from '../i18n';
import { useAction } from '../useAction';
import { ActionError, DisplayNameField, EmailField } from './AuthControls';
import AuthFrame, { type AuthAppearance } from './AuthFrame';
import { SteamStepUpNotice, useStepUp } from './StepUp';

export function AccountEmail() {
  const { user, session, config, refresh, captureSessionVersion } = useApp();
  const verify = useStepUp('email');
  const save = useAction();
  const send = useAction();
  const [editing, setEditing] = useState(false);
  const [requested, setRequested] = useState('');
  const heading = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) heading.current?.focus();
  }, [editing]);
  if (!user) return null;
  const complete = user.profile_required;
  const formOpen = editing || !user.email || complete;
  const disabled = save.busy || send.busy;
  return (
    <div className="account-email">
      <SteamStepUpNotice action="email" />
      {!complete && user.email && (
        <div>
          <strong className="account-email-value">{user.email}</strong>
          <p className="muted">
            {t(user.email_verified_at ? 'Verified email address' : 'Unverified email address')}
          </p>
        </div>
      )}
      {formOpen ? (
        <form
          className="security-inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const email = String(form.get('email') || '').trim();
            const displayName = String(form.get('display_name') || '').trim();
            void save.run(async (active) => {
              const csrf = await verify();
              if (!csrf || !active()) return;
              const { status } = await reconcile(
                authPost(
                  'profile',
                  {
                    email,
                    ...(complete ? { display_name: displayName } : {}),
                  },
                  csrf,
                ),
                refresh,
              );
              if (active() && status.user?.id === user.id) {
                setEditing(false);
                setRequested('');
              }
            });
          }}
        >
          {complete && (
            <DisplayNameField defaultValue={user.display_name || ''} readOnly={disabled} />
          )}
          <EmailField ref={heading} defaultValue={user.email || ''} readOnly={disabled} />
          <ActionError error={save.error} />
          <div className="form-actions">
            <button className="button primary" disabled={disabled}>
              {t(complete ? 'Save profile' : 'Save email address')}
            </button>
            {editing && user.email && !complete && (
              <button
                type="button"
                className="button"
                disabled={disabled}
                onClick={() => {
                  setEditing(false);
                  save.clearError();
                }}
              >
                {t('Cancel')}
              </button>
            )}
          </div>
        </form>
      ) : (
        <button
          type="button"
          className="button"
          disabled={disabled}
          onClick={() => setEditing(true)}
        >
          {t('Change email address')}
        </button>
      )}
      {!config.email_delivery_enabled ? (
        <p className="muted">
          {t(
            'Email delivery is off on this instance. Use an operator-issued code if you need to reset your password.',
          )}
        </p>
      ) : user.email && !user.email_verified_at && !formOpen ? (
        <div>
          <button
            className="button"
            disabled={disabled}
            onClick={() =>
              void send.run(async (active) => {
                await api(
                  '/api/account/email/verification/request',
                  { method: 'POST' },
                  session.csrf,
                );
                if (active() && captureSessionVersion(session.csrf) !== undefined)
                  setRequested(user.email!);
              })
            }
          >
            {t('Send verification email')}
          </button>
          {requested === user.email && (
            <p role="status">{t('Verification requested. Check your inbox for the link.')}</p>
          )}
          <ActionError error={send.error} />
        </div>
      ) : null}
    </div>
  );
}

export function EmailOnboarding(appearance: AuthAppearance) {
  const { user, signOut } = useApp();
  const leave = useAction();
  const heading = useRef<HTMLHeadingElement>(null);
  const { pathname, search } = useLocation();
  useEffect(() => {
    if (user) rememberEmailDestination(user.id, pathname + search);
  }, [user?.id, pathname, search]);
  useEffect(() => {
    heading.current?.focus();
  }, [user?.profile_required]);
  return (
    <AuthFrame {...appearance}>
      <section aria-labelledby="email-onboarding-title">
        <header className="auth-intro">
          <h1 id="email-onboarding-title" ref={heading} tabIndex={-1}>
            {t(user?.profile_required ? 'Complete your profile' : 'Verify your email')}
          </h1>
          <p>
            {t(
              user?.profile_required
                ? 'Steam shares your Steam ID. Choose a display name and add your email address to continue.'
                : 'Open the verification link sent to your address to enter your workspace.',
            )}
          </p>
        </header>
        <AccountEmail key={user?.id} />
        <button
          type="button"
          className="button auth-secondary"
          disabled={leave.busy}
          onClick={() =>
            void leave.run(async () => {
              forgetEmailDestination();
              await signOut();
            })
          }
        >
          {t('Sign out')}
        </button>
        <ActionError error={leave.error} />
      </section>
    </AuthFrame>
  );
}

let initialVerificationCode = takeMailFragment('/verify-email');
export function discardVerificationCode() {
  initialVerificationCode = '';
}
if (initialVerificationCode) window.setTimeout(discardVerificationCode, 60_000);

export function VerifyEmail(appearance: AuthAppearance) {
  const { user, session, config, refresh, signOut } = useApp();
  const task = useAction();
  const leave = useAction();
  const [code, setCode] = useState(() => initialVerificationCode);
  const location = useLocation();
  const [confirmedAddress, setConfirmedAddress] = useState('');
  const confirmed = Boolean(user?.email_verified_at && confirmedAddress === user.email);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (confirmed) heading.current?.focus();
  }, [confirmed]);
  useEffect(() => {
    const incoming = takeMailFragment('/verify-email');
    if (incoming) setCode(incoming);
  }, [location.key, location.hash]);
  useEffect(discardVerificationCode, []);
  return (
    <AuthFrame {...appearance}>
      <section className="email-verification" aria-labelledby="verify-email-title">
        <header className="auth-intro">
          <h1 id="verify-email-title" ref={heading} tabIndex={-1}>
            {t(confirmed ? 'Email verified' : 'Verify your email')}
          </h1>
        </header>
        {confirmed ? (
          <>
            <p>
              {t('Your current email address, {{email}}, is verified.', { email: user?.email })}
            </p>
            <Link
              to={emailDestination(user!.id)}
              onClick={forgetEmailDestination}
              className="button primary"
            >
              {t('Continue')}
            </Link>
          </>
        ) : !config.email_delivery_enabled ? (
          <p>{t('Email verification is off on this instance.')}</p>
        ) : !user ? (
          <>
            <p>
              {t(
                'Sign in to the account that requested verification, then open the link in your email again.',
              )}
            </p>
            <Link className="button primary" to="/login">
              {t('Sign in')}
            </Link>
          </>
        ) : user.email_verified_at ? (
          <>
            <p>
              {t(
                'You are signed in with {{email}}, which is already verified. If the link is for another account, switch accounts and open it again.',
                { email: user.email },
              )}
            </p>
            <Link className="auth-switch-link" to="/account">
              {t('Your account')}
            </Link>
          </>
        ) : !code ? (
          <>
            <p>
              {t(
                'Open the complete verification link from your inbox. You can request another from your account.',
              )}
            </p>
            <Link className="button" to="/account">
              {t('Your account')}
            </Link>
          </>
        ) : (
          <>
            <p>
              {t('Confirm that {{email}} belongs to your account.', { email: user.email || '' })}
            </p>
            <button
              className="button primary"
              disabled={task.busy}
              onClick={() =>
                void task.run(async (active) => {
                  let failure: unknown;
                  try {
                    await authPost('email/verify', { code }, session.csrf);
                  } catch (error) {
                    failure = error;
                  }
                  // Read the live address even when the verification response was lost.
                  const status = await refresh();
                  if (!active()) return;
                  if (status.user?.id !== user.id || status.user.email !== user.email)
                    throw new SessionChangedError();
                  if (!status.user.email_verified_at)
                    throw (
                      failure ??
                      new Error('This verification link has expired or was already used.')
                    );
                  setConfirmedAddress(user.email || '');
                  setCode('');
                })
              }
            >
              {t('Confirm email')}
            </button>
            <ActionError error={task.error} />
            {task.error && (
              <Link className="auth-switch-link" to="/account">
                {t('Your account')}
              </Link>
            )}
          </>
        )}
        {user && !confirmed && (user.email_verified_at || task.error) && (
          <>
            <button
              className="button auth-secondary"
              disabled={leave.busy}
              onClick={() =>
                void leave.run(async () => {
                  forgetEmailDestination();
                  await signOut();
                })
              }
            >
              {t('Sign out to switch accounts')}
            </button>
            <ActionError error={leave.error} />
          </>
        )}
      </section>
    </AuthFrame>
  );
}

export function EmailResetRequest() {
  const { session } = useApp();
  const task = useAction();
  const [submitted, setSubmitted] = useState(false);
  return (
    <form
      className="email-reset-request"
      onSubmit={(event) => {
        event.preventDefault();
        const email = String(new FormData(event.currentTarget).get('email') || '').trim();
        void task.run(async (active) => {
          await authPost('recover/request', { email }, session.csrf);
          if (active()) setSubmitted(true);
        });
      }}
    >
      <EmailField readOnly={task.busy} onChange={() => setSubmitted(false)} />
      <button className="button primary" disabled={task.busy}>
        {t('Email a reset link')}
      </button>
      {submitted && (
        <p role="status">
          {t('If this address is verified on an account here, check its inbox for a reset link.')}
        </p>
      )}
      <ActionError error={task.error} />
    </form>
  );
}
