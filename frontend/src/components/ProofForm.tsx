import { useEffect, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { useApp } from '../context';
import {
  authenticatePasskey,
  authPost,
  passkeySupported,
  reconcile,
  steamRedirect,
} from '../auth-actions';
import { t } from '../i18n';
import { useAction } from '../useAction';
import type { AuthSession, AuthStatus } from '../types';
import { ActionError, PasswordField } from './AuthControls';
import { ProviderLogo } from './ProviderBrand';

export default function ProofForm({
  mode,
  factors,
  returnTo,
  sessionContext,
  onVerified,
  onUnverified,
  onCancel,
}: {
  mode: 'mfa' | 'step-up';
  factors: AuthSession['factors'];
  returnTo: string;
  sessionContext?: string;
  onVerified: (csrf: string) => void;
  onUnverified?: () => void;
  onCancel?: () => void;
}) {
  const { user, config, refresh, session, captureSessionVersion } = useApp();
  const csrf = sessionContext ?? session.csrf;
  const task = useAction();
  const secondFactor = Boolean(factors?.passkey || factors?.totp);
  const recovery = mode === 'mfa' && factors?.recovery;
  const password = mode === 'step-up' && !secondFactor && user?.has_password;
  const steam =
    mode === 'step-up' &&
    !secondFactor &&
    config.steam_enabled &&
    user?.identities?.some(({ provider }) => provider === 'steam');
  const passkey = Boolean(factors?.passkey && passkeySupported());
  const [useRecovery, setUseRecovery] = useState(!passkey && !factors?.totp);
  const [method, setMethod] = useState<'passkey' | 'steam' | 'code'>();

  useEffect(() => {
    // A proof in flight can legitimately replace the prompt's session. Once
    // it settles, a retired context can no longer accept another proof.
    if (
      mode === 'step-up' &&
      !task.busy &&
      session.csrf !== csrf &&
      captureSessionVersion(csrf) === undefined
    )
      onUnverified?.();
  }, [mode, task.busy, session.csrf, csrf, captureSessionVersion, onUnverified]);

  async function finish(request: Promise<AuthStatus | undefined>, active: () => boolean) {
    const { result, status } = await reconcile(request, refresh);
    const verified = mode === 'mfa' ? result?.user : user;
    if (!active()) return;
    if (
      mode === 'step-up' &&
      (result?.session?.csrf !== status.session.csrf ||
        status.session.stage !== 'full' ||
        result?.user?.id !== user?.id ||
        status.user?.id !== user?.id ||
        captureSessionVersion(status.session.csrf) === undefined)
    ) {
      onUnverified?.();
      return;
    }
    if (verified && status.user?.id === verified.id) onVerified(status.session.csrf);
  }

  return (
    <div className="proof-methods" aria-busy={task.busy}>
      {passkey && (
        <button
          type="button"
          className="button auth-method-button"
          disabled={task.busy}
          onClick={() => {
            setMethod('passkey');
            void task.run((active) =>
              finish(
                authenticatePasskey(
                  mode + '/passkey',
                  () => active() && captureSessionVersion(csrf) !== undefined,
                  csrf,
                ),
                active,
              ),
            );
          }}
        >
          <KeyRound size={17} aria-hidden="true" />
          {t('Use a passkey')}
        </button>
      )}
      {method === 'passkey' && <ActionError error={task.error} />}
      {factors?.passkey && !passkey && (
        <p className="muted">{t('Passkeys are unavailable on this browser or connection.')}</p>
      )}
      {steam && (
        <>
          <button
            type="button"
            className="button provider-steam-link"
            disabled={task.busy}
            onClick={() => {
              setMethod('steam');
              void task.run((active) => steamRedirect('step-up/steam', active, returnTo, csrf));
            }}
          >
            <ProviderLogo provider="steam" />
            {t('Confirm with Steam')}
          </button>
          {method === 'steam' && <ActionError error={task.error} />}
          <p className="muted">
            {t('Return from Steam, then repeat the action you were confirming.')}
          </p>
        </>
      )}
      {(password || factors?.totp || (recovery && useRecovery)) && (
        <form
          key={String(useRecovery)}
          onSubmit={(event) => {
            event.preventDefault();
            setMethod('code');
            const form = new FormData(event.currentTarget);
            void task.run((active) =>
              finish(
                password
                  ? authPost('step-up/password', { password: form.get('password') }, csrf)
                  : authPost(
                      mode + (recovery && useRecovery ? '/recovery' : '/totp'),
                      { code: String(form.get('code')).trim() },
                      csrf,
                    ),
                active,
              ),
            );
          }}
        >
          {password ? (
            <PasswordField
              label={t('Current password')}
              name="password"
              autoComplete="current-password"
              maxLength={128}
              required
            />
          ) : (
            <label className="security-field">
              {t(recovery && useRecovery ? 'Recovery code' : 'Authenticator code')}
              <input
                name="code"
                autoComplete={recovery && useRecovery ? 'off' : 'one-time-code'}
                inputMode={recovery && useRecovery ? 'text' : 'numeric'}
                autoCapitalize="none"
                spellCheck={false}
                maxLength={recovery && useRecovery ? 64 : 6}
                pattern={recovery && useRecovery ? undefined : '[0-9]{6}'}
                required
              />
            </label>
          )}
          {method === 'code' && <ActionError error={task.error} />}
          <button type="submit" className="button primary" disabled={task.busy}>
            {t(task.busy ? 'Verifying…' : 'Verify')}
          </button>
        </form>
      )}
      {recovery &&
        (useRecovery ? (
          factors?.totp && (
            <button
              className="button"
              type="button"
              disabled={task.busy}
              onClick={() => {
                setMethod(undefined);
                setUseRecovery(false);
              }}
            >
              {t('Use an authenticator code')}
            </button>
          )
        ) : (
          <button
            className="button"
            type="button"
            disabled={task.busy}
            onClick={() => {
              setMethod(undefined);
              setUseRecovery(true);
            }}
          >
            {t('Use a recovery code')}
          </button>
        ))}
      {!password && !steam && !passkey && !factors?.totp && !recovery && (
        <p role="status">{t('Use a device with an available sign-in method to continue.')}</p>
      )}
      {onCancel && (
        <button type="button" className="button" onClick={onCancel}>
          {t('Cancel')}
        </button>
      )}
    </div>
  );
}
