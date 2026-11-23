import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Fingerprint, KeyRound, Smartphone } from 'lucide-react';
import { passkeyNameMaxLength } from '../../../shared/passkey-name.mjs';
import type { Role } from '../../../shared/roles.mjs';
import { api, ApiError } from '../api';
import {
  authPost,
  cancelPasskeyEnrollment,
  hasPasskeyEnrollmentAttempt,
  isPasskeyNameError,
  passkeyNameError,
  passkeySupported,
  reconcile,
  registerPasskey,
  type FactorResult,
} from '../auth-actions';
import { useApp, useWorkspaceConcealed } from '../context';
import { t } from '../i18n';
import { useAction } from '../useAction';
import { useResource } from '../useResource';
import {
  AccountTime,
  ActionError,
  CopyValue,
  PasswordField,
  SecuritySection,
} from './AuthControls';
import { useConfirm } from './Confirmation';
import { SteamStepUpNotice, useStepUp } from './StepUp';

type Passkey = {
  id: string;
  name: string;
  device_type: 'multiDevice' | 'singleDevice';
  backed_up: boolean;
  created_at: number;
  last_used_at: number | null;
};
type SecurityData = {
  passkeys: Passkey[];
  totp: { created_at: number } | null;
  recovery_codes_remaining: number;
};
type Enrollment = { secret: string; uri: string; enrollment: string; expires_in_ms: number };
type SaveFactor = (
  request: Promise<FactorResult | undefined>,
  startedCsrf: string,
) => Promise<void>;

function RecoveryCodes({
  codes,
  canCopy,
  children,
}: {
  codes: string[];
  canCopy: () => boolean;
  children: ReactNode;
}) {
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => title.current?.focus(), []);
  return (
    <section className="settings-panel security-codes" aria-labelledby="recovery-codes-title">
      <h2 id="recovery-codes-title" ref={title} tabIndex={-1}>
        {t('Save your recovery codes')}
      </h2>
      <p>
        {t(
          'Each code works once if you lose access to your second factor. Save these codes somewhere private. They are shown only now.',
        )}
      </p>
      <ul className="recovery-code-list">
        {codes.map((code) => (
          <li key={code}>
            <code>{code}</code>
          </li>
        ))}
      </ul>
      <CopyValue label={t('Recovery codes')} value={codes.join(', ')} canCopy={canCopy} />
      {children}
    </section>
  );
}

function PasskeyRow({ item, reload }: { item: Passkey; reload: () => void }) {
  const { refresh } = useApp();
  const task = useAction();
  const confirm = useConfirm();
  const verify = useStepUp('passkeys');
  const [editing, setEditing] = useState(false);
  const editTrigger = useRef<HTMLButtonElement>(null);
  const nameErrorId = useId();
  const invalidName = editing && isPasskeyNameError(task.error);
  function finishEdit() {
    task.clearError();
    setEditing(false);
    requestAnimationFrame(() => editTrigger.current?.focus());
  }
  return (
    <li className="security-list-row">
      <div>
        <strong>{item.name}</strong>
        <small>
          {t(
            item.backed_up
              ? 'Backed-up passkey'
              : item.device_type === 'multiDevice'
                ? 'Passkey can sync across devices'
                : 'Device-bound passkey',
          )}
        </small>
        <small>
          {t('Added')} <AccountTime value={item.created_at} />
        </small>
        {item.last_used_at !== null && (
          <small>
            {t('Last used')} <AccountTime value={item.last_used_at} />
          </small>
        )}
      </div>
      {editing ? (
        <form
          className="security-inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            const name = String(new FormData(event.currentTarget).get('name')).trim();
            void task.run(async (active) => {
              const error = passkeyNameError(name, true);
              if (error) throw new Error(error);
              const csrf = await verify();
              if (!csrf || !active()) return;
              await reconcile(
                api(
                  '/api/auth/factors/passkeys/' + encodeURIComponent(item.id),
                  {
                    method: 'PATCH',
                    body: JSON.stringify({ name }),
                  },
                  csrf,
                ),
                refresh,
              );
              if (active()) {
                finishEdit();
                reload();
              }
            });
          }}
        >
          <label className="security-field">
            {t('Passkey name')}
            <input
              name="name"
              defaultValue={item.name}
              maxLength={passkeyNameMaxLength}
              required
              autoFocus
              readOnly={task.busy}
              onChange={invalidName ? task.clearError : undefined}
              aria-describedby={invalidName ? nameErrorId : undefined}
              aria-invalid={invalidName}
            />
          </label>
          {invalidName && <ActionError id={nameErrorId} error={task.error} />}
          <div className="actions">
            <button className="button primary" disabled={task.busy}>
              {t('Save name')}
            </button>
            <button className="button" type="button" disabled={task.busy} onClick={finishEdit}>
              {t('Cancel')}
            </button>
          </div>
        </form>
      ) : (
        <div className="actions">
          <button
            className="button"
            ref={editTrigger}
            type="button"
            disabled={task.busy}
            onClick={() => {
              task.clearError();
              setEditing(true);
            }}
          >
            {t('Rename')}
          </button>
          <button
            className="button"
            type="button"
            disabled={task.busy}
            onClick={async () => {
              if (
                !(await confirm({
                  title: t('Remove {{v0}}?', { v0: item.name }),
                  description: t('This passkey will stop working for sign-in and verification.'),
                  confirmLabel: t('Remove passkey'),
                  tone: 'danger',
                }))
              )
                return;
              void task.run(async (active) => {
                const csrf = await verify();
                if (!csrf || !active()) return;
                await reconcile(
                  api(
                    '/api/auth/factors/passkeys/' + encodeURIComponent(item.id),
                    {
                      method: 'DELETE',
                    },
                    csrf,
                  ),
                  refresh,
                );
                if (active()) reload();
              });
            }}
          >
            {t('Remove passkey')}
          </button>
        </div>
      )}
      {!invalidName && <ActionError error={task.error} />}
    </li>
  );
}

function Passkeys({
  passkeys,
  enroll,
  save,
  reload,
}: {
  passkeys: Passkey[];
  enroll: boolean;
  save: SaveFactor;
  reload: () => void;
}) {
  const { session, captureSessionVersion } = useApp();
  const verify = useStepUp('passkeys');
  const task = useAction();
  const [adding, setAdding] = useState(false);
  const [stagedGrant, setStagedGrant] = useState<string>();
  const addTrigger = useRef<HTMLButtonElement>(null);
  const setupHint = useId();
  const nameErrorId = useId();
  const staged = stagedGrant === session.csrf;
  const invalidName = !staged && isPasskeyNameError(task.error);
  function closeForm() {
    setAdding(false);
    setStagedGrant(undefined);
    requestAnimationFrame(() => addTrigger.current?.focus());
  }
  return (
    <SecuritySection
      title={t('Passkeys')}
      description={t('Sign in or verify with your fingerprint, face, device PIN, or security key.')}
    >
      <div className="settings-panel security-panel">
        <div className="panel-heading">
          <h3>{t('Your passkeys')}</h3>
          <Fingerprint size={19} aria-hidden="true" />
        </div>
        <SteamStepUpNotice action="passkeys" />
        {passkeys.length ? (
          <ul className="security-list">
            {passkeys.map((item) => (
              <PasskeyRow item={item} key={item.id} reload={reload} />
            ))}
          </ul>
        ) : (
          <p>{t('No passkeys added.')}</p>
        )}
        <p role="status" className={staged ? undefined : 'visually-hidden'}>
          {staged &&
            t(
              'Confirm with the passkey you created to finish setup. You can rename it afterwards.',
            )}
        </p>
        {adding ? (
          <form
            className="security-inline-form"
            aria-busy={task.busy}
            onSubmit={(event) => {
              event.preventDefault();
              const name = staged
                ? ''
                : String(new FormData(event.currentTarget).get('name') ?? '').trim();
              void task.run(async (active) => {
                const error = passkeyNameError(name);
                if (error && !(await hasPasskeyEnrollmentAttempt(session.csrf))) {
                  if (active()) setStagedGrant(undefined);
                  throw new Error(error);
                }
                if (!active()) return;
                const csrf = enroll ? session.csrf : await verify();
                if (!csrf || !active()) return;
                await save(
                  registerPasskey(
                    name,
                    () => active() && captureSessionVersion(csrf) !== undefined,
                    (phase) => setStagedGrant(phase === 'possession' ? csrf : undefined),
                    csrf,
                  ),
                  csrf,
                );
                if (active()) closeForm();
              });
            }}
          >
            <div hidden={staged}>
              <label className="security-field">
                {t('Name for a new passkey')}
                <input
                  name="name"
                  maxLength={passkeyNameMaxLength}
                  autoFocus
                  readOnly={task.busy}
                  aria-describedby={invalidName ? `${setupHint} ${nameErrorId}` : setupHint}
                  onChange={invalidName ? task.clearError : undefined}
                  aria-invalid={invalidName}
                />
              </label>
              <small id={setupHint}>
                {t(
                  'Already created the passkey? Leave this blank. It keeps its original name, and you can rename it after setup.',
                )}
              </small>
              {invalidName && <ActionError id={nameErrorId} error={task.error} />}
            </div>
            {!invalidName && <ActionError error={task.error} />}
            <div className="actions">
              <button className="button primary" disabled={task.busy}>
                {t(task.busy ? 'Working…' : 'Continue setup')}
              </button>
              <button
                className="button"
                type="button"
                disabled={task.busy}
                onClick={() => {
                  void task.run(async (active) => {
                    try {
                      if (session.csrf) await cancelPasskeyEnrollment(session.csrf);
                    } finally {
                      if (active()) closeForm();
                    }
                  });
                }}
              >
                {t('Cancel')}
              </button>
            </div>
          </form>
        ) : passkeySupported() ? (
          <button
            className="button"
            ref={addTrigger}
            type="button"
            onClick={() => {
              task.clearError();
              setAdding(true);
            }}
          >
            {t('Add passkey')}
          </button>
        ) : (
          <p>{t('Passkeys are unavailable on this browser or connection.')}</p>
        )}
        {!adding && <ActionError error={task.error} />}
      </div>
    </SecuritySection>
  );
}

function TotpQr({ uri }: { uri: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    let active = true;
    const element = canvas.current;
    if (element)
      void import('qrcode')
        .then(async ({ toCanvas }) => {
          if (!active) return;
          await toCanvas(element, uri, { width: 184, margin: 4, errorCorrectionLevel: 'M' });
          if (active) setDrawn(true);
        })
        .catch(() => {});
    return () => {
      active = false;
      element?.getContext('2d')?.clearRect(0, 0, element.width, element.height);
    };
  }, [uri]);
  return (
    <canvas
      ref={canvas}
      className="security-qr"
      hidden={!drawn}
      role="img"
      aria-label={t('Authenticator setup QR code')}
    />
  );
}

function Authenticator({
  totp,
  enroll,
  save,
  reload,
}: {
  totp: SecurityData['totp'];
  enroll: boolean;
  save: SaveFactor;
  reload: () => void;
}) {
  const { refresh, session, user, verifiedSessionVersion, captureSessionVersion } = useApp();
  const concealed = useWorkspaceConcealed();
  const [setup, setSetup] = useState<{
    secret: string;
    uri: string;
    enrollment: string;
    csrf: string;
    role: Role | undefined;
    expiresAt: number;
    verifyAfter?: number;
  }>();
  const heading = useRef<HTMLHeadingElement>(null);
  const start = useAction();
  const verifyCode = useAction();
  const verify = useStepUp('authenticator');
  const confirm = useConfirm();
  const enrolled = Boolean(totp || session.factors?.totp);
  const currentSetup =
    setup &&
    !enrolled &&
    session.csrf === setup.csrf &&
    session.proof_fresh &&
    user?.role === setup.role &&
    setup.expiresAt > performance.now() &&
    !concealed
      ? setup
      : undefined;
  const awaitingCheck =
    currentSetup?.verifyAfter !== undefined && verifiedSessionVersion <= currentSetup.verifyAfter;
  const showsSecret = Boolean(currentSetup && !awaitingCheck && !verifyCode.busy);
  useEffect(() => {
    if (!setup) return;
    if (
      enrolled ||
      user?.role !== setup.role ||
      captureSessionVersion(setup.csrf) === undefined ||
      (session.csrf === setup.csrf && !session.proof_fresh)
    ) {
      setSetup(undefined);
      return;
    }
    const expiration = window.setTimeout(
      () => setSetup(undefined),
      setup.expiresAt - performance.now(),
    );
    return () => window.clearTimeout(expiration);
  }, [captureSessionVersion, enrolled, session.csrf, session.proof_fresh, setup, user?.role]);
  useEffect(() => {
    if (session.factors?.totp && !totp) reload();
  }, [reload, session.factors?.totp, totp]);
  const setupId = currentSetup?.enrollment;
  useEffect(() => {
    if (setupId) heading.current?.focus();
  }, [setupId]);
  return (
    <SecuritySection
      title={t('Authenticator app')}
      description={t(
        'Use a six-digit code from an authenticator app when you verify your sign-in.',
      )}
    >
      <div className="settings-panel security-panel">
        <div className="panel-heading">
          <h3 ref={heading} tabIndex={-1}>
            {t(currentSetup ? 'Set up an authenticator app' : 'Authenticator codes')}
          </h3>
          <Smartphone size={19} aria-hidden="true" />
        </div>
        <SteamStepUpNotice action="authenticator" />
        {currentSetup ? (
          <form
            className="security-inline-form"
            aria-busy={verifyCode.busy}
            onSubmit={(event) => {
              event.preventDefault();
              const { csrf, enrollment } = currentSetup;
              if (
                !showsSecret ||
                currentSetup.expiresAt <= performance.now() ||
                captureSessionVersion(csrf) === undefined
              )
                return;
              const code = new FormData(event.currentTarget).get('code');
              void verifyCode.run(async (active) => {
                const proof = authPost<FactorResult>(
                  'factors/totp/verify',
                  { code, enrollment },
                  csrf,
                ).catch((error: unknown) => {
                  // An interrupted response can follow a committed enrollment.
                  // Only a later read may establish that this setup is still pending.
                  const verifyAfter = captureSessionVersion(csrf);
                  if (active() && error instanceof ApiError && error.code === 'totp_setup_expired')
                    setSetup((saved) => (saved?.enrollment === enrollment ? undefined : saved));
                  else if (active() && verifyAfter !== undefined)
                    setSetup((saved) =>
                      saved?.enrollment === enrollment ? { ...saved, verifyAfter } : saved,
                    );
                  throw error;
                });
                await save(proof, csrf);
                if (active()) setSetup(undefined);
              });
            }}
          >
            {showsSecret && (
              <>
                <p>
                  {t(
                    'Scan the QR code with your authenticator app or enter the setup key. Then enter the code from the app.',
                  )}
                </p>
                <TotpQr key={currentSetup.enrollment} uri={currentSetup.uri} />
                <CopyValue
                  label={t('Setup key')}
                  value={currentSetup.secret}
                  canCopy={() =>
                    currentSetup.expiresAt > performance.now() &&
                    captureSessionVersion(currentSetup.csrf) !== undefined
                  }
                />
              </>
            )}
            <label className="security-field">
              {t('Authenticator code')}
              <input
                name="code"
                disabled={!showsSecret}
                required
                autoComplete="one-time-code"
                inputMode="numeric"
                maxLength={6}
                pattern="[0-9]{6}"
              />
            </label>
            <ActionError error={verifyCode.error} />
            <div className="actions">
              {awaitingCheck ? (
                <button
                  className="button primary"
                  type="button"
                  disabled={verifyCode.busy}
                  onClick={() =>
                    void verifyCode.run(async () => {
                      await refresh();
                    })
                  }
                >
                  {t('Try again')}
                </button>
              ) : (
                <button className="button primary" disabled={!showsSecret}>
                  {t(verifyCode.busy ? 'Verifying…' : 'Activate authenticator')}
                </button>
              )}
              <button
                className="button"
                type="button"
                disabled={verifyCode.busy}
                onClick={() => setSetup(undefined)}
              >
                {t('Cancel')}
              </button>
            </div>
          </form>
        ) : enrolled ? (
          <>
            {totp && (
              <p>
                {t('Added')} <AccountTime value={totp.created_at} />
              </p>
            )}
            <button
              className="button"
              type="button"
              disabled={start.busy}
              onClick={async () => {
                if (
                  !(await confirm({
                    title: t('Remove authenticator app?'),
                    description: t('Codes from this app will stop working for this account.'),
                    confirmLabel: t('Remove authenticator'),
                    tone: 'danger',
                  }))
                )
                  return;
                void start.run(async (active) => {
                  const csrf = await verify();
                  if (!csrf || !active()) return;
                  await reconcile(
                    api('/api/auth/factors/totp', { method: 'DELETE' }, csrf),
                    refresh,
                  );
                  if (active()) reload();
                });
              }}
            >
              {t('Remove authenticator')}
            </button>
          </>
        ) : (
          <>
            <p>{t('No authenticator app added.')}</p>
            <button
              className="button"
              type="button"
              disabled={start.busy}
              onClick={() =>
                void start.run(async (active) => {
                  const csrf = enroll ? session.csrf : await verify();
                  if (!csrf || !active()) return;
                  const startedAt = performance.now();
                  const { secret, uri, enrollment, expires_in_ms } = await authPost<Enrollment>(
                    'factors/totp/options',
                    {},
                    csrf,
                  );
                  const expiresAt = startedAt + Math.min(expires_in_ms, 600_000);
                  if (
                    active() &&
                    expiresAt > performance.now() &&
                    captureSessionVersion(csrf) !== undefined
                  )
                    setSetup({ secret, uri, enrollment, expiresAt, csrf, role: user?.role });
                })
              }
            >
              {t(start.busy ? 'Working…' : 'Set up authenticator')}
            </button>
          </>
        )}
        <ActionError error={start.error} />
      </div>
    </SecuritySection>
  );
}

function PasswordChange() {
  const { refresh, notify } = useApp();
  const task = useAction();
  const verify = useStepUp('password');
  return (
    <SecuritySection
      title={t('Password')}
      description={t('Setting a new password signs out your other sessions.')}
    >
      <form
        className="settings-panel security-panel"
        aria-busy={task.busy}
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const new_password = new FormData(form).get('new_password');
          void task.run(async (active) => {
            const csrf = await verify();
            if (!csrf || !active()) return;
            const { status } = await reconcile(
              authPost('password', { new_password }, csrf),
              refresh,
            );
            if (active() && status.session.stage === 'full') {
              form.reset();
              notify('Password updated. Other sessions have been signed out.');
            }
          });
        }}
      >
        <SteamStepUpNotice action="password" />
        <PasswordField
          label={t('New password')}
          name="new_password"
          minLength={12}
          maxLength={128}
          required
          autoComplete="new-password"
          aria-describedby="new-password-help"
        />
        <small id="new-password-help">{t('12–128 characters. Use a unique password.')}</small>
        <ActionError error={task.error} />
        <button className="button primary" disabled={task.busy}>
          {t(task.busy ? 'Updating…' : 'Update password')}
        </button>
      </form>
    </SecuritySection>
  );
}

function RecoverySettings({ count, save }: { count: number; save: SaveFactor }) {
  const task = useAction();
  const confirm = useConfirm();
  const verify = useStepUp('recovery-codes');
  return (
    <SecuritySection
      title={t('Recovery codes')}
      description={t('Keep a set of one-time codes in case you lose your second factor.')}
    >
      <div className="settings-panel security-panel">
        <div className="panel-heading">
          <h3>{t('Backup access')}</h3>
          <KeyRound size={19} aria-hidden="true" />
        </div>
        <SteamStepUpNotice action="recovery-codes" />
        <p>
          {t('Unused codes')} <strong>{count}</strong>
        </p>
        <button
          className="button"
          type="button"
          disabled={task.busy}
          onClick={async () => {
            if (
              count > 0 &&
              !(await confirm({
                title: t('Replace your recovery codes?'),
                description: t('Any previously saved recovery codes will stop working.'),
                confirmLabel: t('Generate recovery codes'),
                tone: 'danger',
              }))
            )
              return;
            void task.run(async (active) => {
              const csrf = await verify();
              if (!csrf || !active()) return;
              await save(authPost<FactorResult>('factors/recovery/regenerate', {}, csrf), csrf);
            });
          }}
        >
          {t('Generate recovery codes')}
        </button>
        <ActionError error={task.error} />
      </div>
    </SecuritySection>
  );
}

export default function AccountSecurity({
  enrollment,
  onComplete,
}: {
  enrollment: boolean;
  onComplete: () => void;
}) {
  const { refresh, session, user, captureSessionVersion } = useApp();
  const concealed = useWorkspaceConcealed();
  const account = useResource<SecurityData>('/api/auth/security');
  const writes = useRef({ started: 0, accepted: 0 });
  const [receipt, setReceipt] = useState<{
    write: number;
    codes: string[];
    synced: boolean;
    retired?: boolean;
    userId: string;
    issuedCsrf: string;
    startedCsrf: string;
  }>();
  const sync = useAction();
  const limited = session.stage === 'enroll';
  const superseded = Boolean(
    receipt &&
    (receipt.retired ||
      (receipt.issuedCsrf !== session.csrf &&
        (receipt.synced || receipt.startedCsrf !== session.csrf))),
  );
  const verified = Boolean(
    receipt &&
    !concealed &&
    !superseded &&
    session.stage === 'full' &&
    session.csrf === receipt.issuedCsrf &&
    user?.id === receipt.userId,
  );
  const reload = account.reload;
  useEffect(() => {
    if (!receipt || receipt.retired || receipt.write !== writes.current.accepted) return;
    if (superseded) {
      setReceipt((current) =>
        current === receipt ? { ...receipt, codes: [], retired: true } : current,
      );
    } else if (verified && !receipt.synced) {
      reload();
      const synced = receipt.codes.length || enrollment ? { ...receipt, synced: true } : undefined;
      setReceipt((current) => (current === receipt ? synced : current));
    }
  }, [enrollment, receipt, reload, superseded, verified]);

  async function reconcileReceipt() {
    await sync.run(async () => {
      await refresh();
    });
  }

  const save: SaveFactor = async (request, startedCsrf) => {
    const write = ++writes.current.started;
    let result;
    try {
      result = await request;
    } catch (failure) {
      // The write may have committed even if its response was interrupted.
      await refresh().catch(() => {});
      throw failure;
    }
    if (!result) return;
    const userId = result.user?.id;
    if (!userId) throw new Error('Session expired. Refresh the page and try again.');
    const issuedCsrf = result.session.csrf;
    // A later successful write can supersede a response whose body is still in flight.
    // Only the request's initiating grant or the grant it issued can accept its receipt.
    if (
      write > writes.current.accepted &&
      (captureSessionVersion(startedCsrf) !== undefined ||
        captureSessionVersion(issuedCsrf) !== undefined)
    ) {
      writes.current.accepted = write;
      const next = {
        write,
        codes: result.recovery_codes ?? [],
        synced: false,
        userId,
        issuedCsrf,
        startedCsrf,
      };
      setReceipt((current) => (current && current.write > write ? current : next));
    }
    await reconcileReceipt();
  };

  if (receipt) {
    const dismiss = (reloadAccount = false) => {
      if (receipt.write !== writes.current.accepted) return;
      setReceipt((current) => (current?.write === receipt.write ? undefined : current));
      if (reloadAccount) reload();
      if (enrollment) onComplete();
    };
    if (superseded)
      return (
        <section className="settings-panel security-codes">
          <p role="status">
            {t(
              'Your security session changed. Check your recovery codes before relying on a saved copy.',
            )}
          </p>
          <button className="button" type="button" onClick={() => dismiss(true)}>
            {t('Done')}
          </button>
        </section>
      );
    const actions = (
      <>
        {sync.busy && <p role="status">{t('Checking your session…')}</p>}
        <ActionError error={sync.error} />
        {verified ? (
          <button className="button primary" type="button" onClick={() => dismiss()}>
            {t('Done')}
          </button>
        ) : (
          <button
            className="button primary"
            type="button"
            disabled={sync.busy}
            onClick={() => void reconcileReceipt()}
          >
            {t('Try again')}
          </button>
        )}
      </>
    );
    return verified && receipt.codes.length ? (
      <RecoveryCodes
        codes={receipt.codes}
        canCopy={() =>
          receipt.write === writes.current.accepted &&
          captureSessionVersion(receipt.issuedCsrf) !== undefined
        }
      >
        {actions}
      </RecoveryCodes>
    ) : (
      <section className="settings-panel security-codes" aria-labelledby="security-method-saved">
        <h2 id="security-method-saved">{t('Security method saved')}</h2>
        {actions}
      </section>
    );
  }
  if (enrollment && !limited)
    return (
      <div className="settings-panel security-panel">
        <p role="status">{t('Your second factor is ready.')}</p>
        <button className="button primary" onClick={onComplete}>
          {t('Continue')}
        </button>
      </div>
    );
  return (
    <>
      {account.loading && <p role="status">{t('Loading account security…')}</p>}
      {account.error && (
        <div className="settings-panel">
          <ActionError error={account.error} />
          <button className="button" onClick={account.reload}>
            {t('Try again')}
          </button>
        </div>
      )}
      {account.data && (
        <>
          <Passkeys
            passkeys={account.data.passkeys}
            enroll={limited}
            save={save}
            reload={account.reload}
          />
          <Authenticator
            totp={account.data.totp}
            enroll={limited}
            save={save}
            reload={account.reload}
          />
          {!limited && (account.data.passkeys.length > 0 || account.data.totp) && (
            <RecoverySettings count={account.data.recovery_codes_remaining} save={save} />
          )}
        </>
      )}
      {!limited && <PasswordChange />}
    </>
  );
}
