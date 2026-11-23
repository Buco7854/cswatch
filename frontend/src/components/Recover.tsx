import { takeMailFragment } from '../auth-navigation';
import { EmailResetRequest } from './AccountEmail';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { api, sessionDeadline } from '../api';
import { authPost, recoveryReceiptDeadline } from '../auth-actions';
import { useApp, useWorkspaceConcealed } from '../context';
import { t } from '../i18n';
import { useAction } from '../useAction';
import { ActionError, CopyValue, PasswordField } from './AuthControls';
import AuthFrame, { type AuthAppearance } from './AuthFrame';

let linkedCode = '';
type RecoveryStatus = {
  claim_id: string | null;
  username?: string;
  recovery_expires_in_ms?: number;
};

type Receipt = { claim?: string; attempt?: string };
type RecoveryRead = { context: string; generation: number; receipt: Receipt };
type PendingClaim = { id: string; expiresAt: number; verified?: boolean; expired?: boolean };
const unavailableClaim = 'This password reset is no longer available. Enter a new reset code.';

function savedReceipt(): Receipt {
  const { recoveryClaim, recoveryAttempt } = window.history.state ?? {};
  return {
    claim:
      typeof recoveryClaim === 'string' && /^[a-f0-9]{32}$/.test(recoveryClaim)
        ? recoveryClaim
        : undefined,
    attempt:
      typeof recoveryAttempt === 'string' && /^[a-f0-9]{64}$/.test(recoveryAttempt)
        ? recoveryAttempt
        : undefined,
  };
}

function matchesReceipt(receipt: Receipt) {
  const current = savedReceipt();
  return current.claim === receipt.claim && current.attempt === receipt.attempt;
}

function rememberReceipt({ claim, attempt }: Receipt = {}) {
  window.history.replaceState(
    { ...window.history.state, recoveryClaim: claim ?? null, recoveryAttempt: attempt ?? null },
    '',
  );
}

async function attemptReceipt(code: string) {
  if (!crypto.subtle) return null;
  const sha256 = async (value: string) => {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
  };
  return sha256('cswatch/recovery-attempt/v1:' + (await sha256(code)));
}

export function discardInitialRecoveryCode() {
  linkedCode = '';
}
linkedCode = takeMailFragment('/recover');
if (linkedCode) window.setTimeout(discardInitialRecoveryCode, 60_000);

export default function Recover({
  takeHandoff,
  ...appearance
}: AuthAppearance & { takeHandoff: () => string }) {
  const { config, session, refresh, signOut, captureSessionVersion, verifiedSessionVersion } =
    useApp();
  const concealed = useWorkspaceConcealed();
  const task = useAction();
  const { pathname, search, key } = useLocation();
  const [code, setCode] = useState('');
  const [phase, setPhase] = useState<'check' | 'claim' | 'verify'>('check');
  const [pendingClaim, setPendingClaim] = useState<PendingClaim>();
  const [writeFailure, setWriteFailure] = useState<{ phase: 'claim' | 'reset'; message: string }>();
  const { claim, attempt } = savedReceipt();
  const request = useMemo<RecoveryRead | null>(
    () =>
      session.stage === 'anonymous' && phase === 'check' && !concealed
        ? { context: session.csrf, generation: verifiedSessionVersion, receipt: { claim, attempt } }
        : null,
    [session.stage, session.csrf, phase, concealed, verifiedSessionVersion, claim, attempt],
  );
  const [read, setRead] = useState<{
    request: RecoveryRead;
    result?: RecoveryStatus;
    expiresAt?: number;
    error?: string;
  }>();
  const readCurrent = useCallback(
    ({ context, generation, receipt }: RecoveryRead) =>
      document.visibilityState !== 'hidden' &&
      captureSessionVersion(context) === generation &&
      matchesReceipt(receipt),
    [captureSessionVersion],
  );
  const checked = read?.request === request && request && readCurrent(request) ? read : undefined;
  const expiresAt = checked?.expiresAt ?? 0;
  const username = expiresAt > performance.now() ? checked?.result?.username : undefined;
  const retainedClaim =
    pendingClaim?.verified && !pendingClaim.expired && pendingClaim.expiresAt > performance.now()
      ? pendingClaim
      : undefined;
  const resetClaim = retainedClaim?.id === checked?.result?.claim_id ? retainedClaim : undefined;
  const checkError = phase === 'verify' ? task.error : checked?.error;
  const title = useRef<HTMLHeadingElement>(null);

  const useAnotherCode = useCallback((error?: string) => {
    rememberReceipt();
    setPendingClaim(undefined);
    setCode('');
    setWriteFailure(error ? { phase: 'claim', message: error } : undefined);
    setPhase('claim');
  }, []);

  async function verifyReceipt(active: () => boolean) {
    if (active()) setPhase('verify');
    await refresh();
    if (active()) setPhase('check');
  }
  useLayoutEffect(() => {
    const hash = window.location.hash;
    if (hash) {
      const fragment = hash.slice(1);
      if (/^[0-9a-f]{64}$/.test(fragment)) {
        useAnotherCode();
        setCode(fragment);
      }
      window.history.replaceState(window.history.state, '', pathname + search);
    }
  }, [key, pathname, search, useAnotherCode]);
  useEffect(() => {
    const incoming = takeHandoff() || linkedCode;
    discardInitialRecoveryCode();
    if (incoming) {
      useAnotherCode();
      setCode(incoming);
    }
  }, [takeHandoff, useAnotherCode]);
  useEffect(() => {
    if (!code) return;
    const expiration = window.setTimeout(() => setCode(''), 600_000);
    return () => window.clearTimeout(expiration);
  }, [code]);
  useEffect(() => {
    if (!request) {
      setRead(undefined);
      return;
    }
    const controller = new AbortController();
    const signal = sessionDeadline(controller.signal);
    const startedAt = performance.now();
    const current = () => !controller.signal.aborted && readCurrent(request);
    const { claim, attempt } = request.receipt;
    const headers: Record<string, string> = claim
      ? { 'X-Recovery-Claim': claim }
      : attempt
        ? { 'X-Recovery-Attempt': attempt }
        : {};
    if (current())
      void api<RecoveryStatus>(
        '/api/auth/recover/status',
        { headers, signal },
        request.context,
      ).then(
        (result) => {
          if (!current()) return;
          const receivedDeadline = recoveryReceiptDeadline(
            startedAt,
            result.recovery_expires_in_ms,
          );
          if (
            (claim || attempt) &&
            !result.claim_id &&
            result.username &&
            receivedDeadline > performance.now()
          ) {
            setPendingClaim(undefined);
            setCode('');
            setWriteFailure(undefined);
            setRead({ request, result, expiresAt: receivedDeadline });
            return;
          }
          const id = result.claim_id;
          const expiresAt = pendingClaim
            ? Math.min(pendingClaim.expiresAt, receivedDeadline)
            : receivedDeadline;
          if (
            id &&
            (claim ? id === claim : attempt) &&
            (!pendingClaim || pendingClaim.id === id) &&
            expiresAt > performance.now()
          ) {
            setPendingClaim({ id, expiresAt, verified: true });
            setCode('');
            setWriteFailure((failure) => (failure?.phase === 'claim' ? undefined : failure));
            setRead({ request, result, expiresAt });
            return;
          }
          if (claim || pendingClaim || (attempt && !writeFailure)) useAnotherCode(unavailableClaim);
          else {
            // A rejected claim can leave the same grant and code available for a deliberate retry.
            if (attempt) rememberReceipt();
            setPhase('claim');
          }
        },
        (failure: Error) => {
          if (current())
            setRead({
              request,
              error: signal.aborted ? 'Connection lost. Try again.' : failure.message,
            });
        },
      );
    return () => controller.abort();
    // Capture the previous deadline and write error at the start of this paired read.
    // Its own result may update both without starting another request.
  }, [request, readCurrent, useAnotherCode]);

  useEffect(() => {
    if (!pendingClaim || pendingClaim.expired) return;
    const timer = window.setTimeout(() => {
      if (request && checked?.result?.claim_id === pendingClaim.id && readCurrent(request))
        useAnotherCode(unavailableClaim);
      else
        // Discard the password field at expiry while an in-flight result is still ambiguous.
        setPendingClaim((previous) =>
          previous === pendingClaim ? { ...pendingClaim, expired: true } : previous,
        );
    }, pendingClaim.expiresAt - performance.now());
    return () => window.clearTimeout(timer);
  }, [pendingClaim, request, checked, readCurrent, useAnotherCode]);

  useEffect(() => {
    if (!username || !request) return;
    const timer = window.setTimeout(() => {
      if (readCurrent(request)) useAnotherCode();
    }, expiresAt - performance.now());
    return () => window.clearTimeout(timer);
  }, [username, expiresAt, request, readCurrent, useAnotherCode]);

  useEffect(() => {
    if (resetClaim || username || writeFailure?.message === unavailableClaim)
      title.current?.focus();
  }, [resetClaim?.id, username, writeFailure?.message]);
  return (
    <AuthFrame {...appearance}>
      <section aria-labelledby="recover-title">
        <header className="auth-intro">
          <h1 id="recover-title" ref={title} tabIndex={-1}>
            {t(
              username
                ? 'Password reset'
                : resetClaim
                  ? 'Choose a new password'
                  : 'Recover your account',
            )}
          </h1>
          <p>
            {t(
              username
                ? 'Use the password from the completed reset and any second factor you already set up to sign in.'
                : resetClaim
                  ? 'Use a unique password with at least 12 characters.'
                  : config.email_delivery_enabled
                    ? 'Use a reset code or request a link at your verified email address.'
                    : 'Email recovery is off on this instance. Enter the one-time reset code supplied by your operator.',
            )}
          </p>
        </header>
        {username ? (
          <>
            <CopyValue
              label={t('Your sign-in username')}
              value={username}
              canCopy={() =>
                Boolean(request && readCurrent(request) && expiresAt > performance.now())
              }
            />
            <Link className="button primary" to="/login">
              {t('Sign in')}
            </Link>
          </>
        ) : session.stage !== 'anonymous' ? (
          <>
            <p>{t('Sign out of this browser session before recovering an account.')}</p>
            <button
              className="button primary"
              disabled={task.busy}
              onClick={() => void task.run(() => signOut({ recoveryCode: code }))}
            >
              {t('Sign out')}
            </button>
            <ActionError error={task.error} />
          </>
        ) : !resetClaim && (phase === 'check' || phase === 'verify') ? (
          <>
            {((request && !checked) || task.busy) && (
              <p role="status">{t('Checking for a password reset…')}</p>
            )}
            <ActionError error={checkError || ''} />
            {checkError && (
              <button className="button" onClick={() => void task.run(verifyReceipt)}>
                {t('Try again')}
              </button>
            )}
          </>
        ) : phase === 'claim' ? (
          <form
            aria-busy={task.busy}
            onSubmit={(event) => {
              event.preventDefault();
              void task.run(async (active) => {
                const submittedCode = code.trim();
                const attempt = (await attemptReceipt(submittedCode)) ?? undefined;
                if (
                  !active() ||
                  document.visibilityState === 'hidden' ||
                  captureSessionVersion(session.csrf) !== verifiedSessionVersion
                )
                  return;
                setWriteFailure(undefined);
                const receipt = { attempt };
                rememberReceipt(receipt);
                const startedAt = performance.now();
                try {
                  const result = await authPost<RecoveryStatus>(
                    'recover/claim',
                    { code: submittedCode },
                    session.csrf,
                  );
                  if (active() && matchesReceipt(receipt) && result.claim_id) {
                    rememberReceipt({ claim: result.claim_id });
                    setPendingClaim({
                      id: result.claim_id,
                      expiresAt: recoveryReceiptDeadline(startedAt, result.recovery_expires_in_ms),
                    });
                    setCode('');
                  }
                } catch (error) {
                  if (active()) setWriteFailure({ phase, message: (error as Error).message });
                }
                await verifyReceipt(active);
              });
            }}
          >
            <label className="security-field">
              {t('Password reset code')}
              <input
                name="code"
                type="password"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                readOnly={task.busy}
                autoCapitalize="none"
                spellCheck={false}
                minLength={64}
                maxLength={64}
                autoComplete="off"
                required
              />
            </label>
            <ActionError error={task.error || writeFailure?.message || ''} />
            <button className="button primary" disabled={task.busy}>
              {t(task.busy ? 'One moment…' : 'Continue')}
            </button>
          </form>
        ) : null}
        {retainedClaim && (
          // Keep the uncontrolled input for the same claim across a temporary context check.
          <div hidden={!resetClaim} inert={!resetClaim || undefined} key={retainedClaim.id}>
            <form
              aria-busy={task.busy}
              onSubmit={(event) => {
                event.preventDefault();
                if (
                  !resetClaim ||
                  !request ||
                  !readCurrent(request) ||
                  resetClaim.expiresAt <= performance.now()
                )
                  return;
                const password = new FormData(event.currentTarget).get('password');
                void task.run(async (active) => {
                  setWriteFailure(undefined);
                  setPhase('verify');
                  try {
                    await authPost<{ ok: true }>(
                      'recover/complete',
                      { password, claim_id: resetClaim.id },
                      request.context,
                    );
                  } catch (error) {
                    if (active())
                      setWriteFailure({ phase: 'reset', message: (error as Error).message });
                  }
                  // The completion may have installed a new cookie even if its response was lost.
                  await verifyReceipt(active);
                });
              }}
            >
              <PasswordField
                label={t('New password')}
                name="password"
                autoComplete="new-password"
                minLength={12}
                maxLength={128}
                readOnly={task.busy}
                required
              />
              <ActionError error={task.error || writeFailure?.message || ''} />
              <button className="button primary" disabled={task.busy}>
                {t(task.busy ? 'One moment…' : 'Reset password')}
              </button>
              <button
                className="button auth-secondary"
                type="button"
                disabled={task.busy}
                onClick={() => useAnotherCode()}
              >
                {t('Use another reset code')}
              </button>
            </form>
          </div>
        )}
        {session.stage === 'anonymous' &&
          phase === 'claim' &&
          !retainedClaim &&
          !username &&
          config.email_delivery_enabled && <EmailResetRequest />}
        {!username && (
          <Link className="auth-switch-link" to="/login">
            {t('Back to sign in')}
          </Link>
        )}
      </section>
    </AuthFrame>
  );
}
