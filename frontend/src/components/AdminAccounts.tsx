import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft, ChevronRight } from 'lucide-react';
import { roles, type Role } from '../../../shared/roles.mjs';
import { api, ApiError, sessionDeadline, SessionChangedError } from '../api';
import { recoveryReceiptDeadline } from '../auth-actions';
import { useApp, useWorkspaceConcealed, useWorkspaceDialog } from '../context';
import { currentFocus, focusReturn } from '../focus-restore';
import { t } from '../i18n';
import { useAction } from '../useAction';
import { useResource } from '../useResource';
import { AccountTime, ActionError, CopyValue, roleLabel, SecuritySection } from './AuthControls';
import { useConfirm } from './Confirmation';
import { Pagination, SelectControl, SwitchRow } from './Controls';
import { formatBytes } from '../format-bytes';
import { SteamStepUpNotice, useStepUp } from './StepUp';

type UserRow = {
  id: string;
  username: string;
  display_name?: string;
  role: Role;
  created_at: number;
};
type UserDetails = {
  user: UserRow & { last_active: number | null };
  identities: { provider: string; subject: string }[];
  factors: { passkeys: number; totp: boolean; recovery_codes: number };
  sessions: { id: string; device: string; address: string | null; last_used_at: number }[];
  storage: { demos: number; bytes: number };
};
const outcomes = {
  success: 'Succeeded',
  denied: 'Denied',
  authorized: 'Authorized',
  unknown: 'Outcome unknown',
} as const;
type SecurityEvent = {
  id: number;
  actor: string | null;
  action: string;
  target: string | null;
  address: string | null;
  outcome: keyof typeof outcomes;
  intent_id?: number | null;
  created_at: number;
};
type UsersPage = { users: UserRow[]; total: number };
type EventsPage = { events: SecurityEvent[]; total: number };
export type Policy = { value: Role[]; locked: boolean };

const pageSize = 25;
function OffsetPagination({
  offset,
  total,
  change,
}: {
  offset: number;
  total: number;
  change: (offset: number) => void;
}) {
  if (!offset && total <= pageSize) return null;
  return (
    <Pagination
      status={t('Showing {{v0}}–{{v1}} of {{v2}}', {
        v0: Math.min(offset + 1, total),
        v1: Math.min(offset + pageSize, total),
        v2: total,
      })}
      previous={offset ? () => change(Math.max(0, offset - pageSize)) : undefined}
      next={offset + pageSize < total ? () => change(offset + pageSize) : undefined}
    />
  );
}

function FetchStatus({
  loading,
  error,
  reload,
}: {
  loading: boolean;
  error?: string;
  reload: () => void;
}) {
  return (
    <>
      {loading && <p role="status">{t('Loading…')}</p>}
      {error && (
        <div className="security-panel">
          <ActionError error={error} />
          <button type="button" className="button" onClick={reload}>
            {t('Try again')}
          </button>
        </div>
      )}
    </>
  );
}

function SecurityList({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="settings-panel security-panel">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

/** Dropdown value for an unfiltered list; menu values cannot be empty. */
const anyValue = 'any';

export function AdminUsers() {
  const { search } = useLocation();
  const navigate = useNavigate();
  const [query, setQuery] = useState({ q: '', role: '' });
  const [roleFilter, setRoleFilter] = useState(query.role);
  const [offset, setOffset] = useState(0);
  const selected = new URLSearchParams(search).get('user');
  const params = new URLSearchParams({ q: query.q, offset: String(offset) });
  if (query.role) params.set('role', query.role);
  const result = useResource<UsersPage>(selected ? null : '/api/admin/users?' + params);
  if (selected)
    return (
      <UserDetail
        key={selected}
        id={selected}
        onRemove={() => {
          setOffset(0);
          result.reload();
          navigate('/admin?section=users', { replace: true });
        }}
      />
    );
  return (
    <section
      className="settings-panel security-panel admin-results"
      aria-labelledby="admin-users-title"
    >
      <h2 id="admin-users-title">{t('Users')}</h2>
      <form
        className="security-filters"
        aria-label={t('Find an account')}
        onSubmit={(event) => {
          event.preventDefault();
          const fields = new FormData(event.currentTarget);
          setOffset(0);
          setQuery({ q: String(fields.get('q')).trim(), role: roleFilter });
          result.reload();
        }}
      >
        <label className="security-field">
          {t('Username or display name')}
          <input name="q" type="search" defaultValue={query.q} maxLength={64} />
        </label>
        <div className="security-field">
          <span aria-hidden="true">{t('Role')}</span>
          <SelectControl
            label={t('Role')}
            value={roleFilter || anyValue}
            onValueChange={(value) => setRoleFilter(value === anyValue ? '' : value)}
            options={[
              { value: anyValue, label: t('All roles') },
              ...roles.map((role) => ({ value: role, label: roleLabel(role) })),
            ]}
          />
        </div>
        <button className="button primary">{t('Search')}</button>
      </form>
      <FetchStatus {...result} />
      {result.data && !result.loading && (
        <>
          {result.data.users.length ? (
            <ul className="security-list admin-user-list">
              {result.data.users.map((user) => (
                <li key={user.id}>
                  <Link
                    to={'/admin?' + new URLSearchParams({ section: 'users', user: user.id })}
                    className="admin-user-link"
                  >
                    <span>
                      <strong>{user.username}</strong>
                      {user.display_name && user.display_name !== user.username && (
                        <small>{user.display_name}</small>
                      )}
                    </span>
                    <span className="member-role">{roleLabel(user.role)}</span>
                    <ChevronRight size={17} aria-hidden="true" />
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p role="status">{t('No accounts match these filters.')}</p>
          )}
          <OffsetPagination offset={offset} total={result.data.total} change={setOffset} />
        </>
      )}
    </section>
  );
}

function UserDetail({ id, onRemove }: { id: string; onRemove: () => void }) {
  const { data, error, loading, reload } = useResource<UserDetails>(
    '/api/admin/users/' + encodeURIComponent(id),
  );
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (data) title.current?.focus({ preventScroll: true });
  }, [Boolean(data)]);
  return (
    <section className="admin-user-detail" aria-labelledby={data ? 'admin-user-title' : undefined}>
      <Link className="button admin-back" to="/admin?section=users">
        <ArrowLeft size={16} aria-hidden="true" />
        {t('Back to users')}
      </Link>
      <FetchStatus error={error} loading={loading} reload={reload} />
      {data && (
        <>
          <div className="admin-user-heading">
            <div>
              <h2 ref={title} id="admin-user-title" tabIndex={-1}>
                {data.user.username}
              </h2>
              {data.user.display_name && data.user.display_name !== data.user.username && (
                <p>{data.user.display_name}</p>
              )}
            </div>
            <span className="member-role">{roleLabel(data.user.role)}</span>
          </div>
          <div className="admin-security-grid">
            <SecurityList title={t('Account activity')}>
              <dl className="security-metadata">
                <div>
                  <dt>{t('Created')}</dt>
                  <dd>
                    <AccountTime value={data.user.created_at} />
                  </dd>
                </div>
                <div>
                  <dt>{t('Last active')}</dt>
                  <dd>
                    <AccountTime value={data.user.last_active} />
                  </dd>
                </div>
                <div>
                  <dt>{t('Stored demos')}</dt>
                  <dd>{data.storage.demos}</dd>
                </div>
                <div>
                  <dt>{t('Storage used')}</dt>
                  <dd>{formatBytes(data.storage.bytes)}</dd>
                </div>
              </dl>
            </SecurityList>
            <SecurityList title={t('Second factors')}>
              <dl className="security-metadata">
                <div>
                  <dt>{t('Passkeys')}</dt>
                  <dd>{data.factors.passkeys}</dd>
                </div>
                <div>
                  <dt>{t('Authenticator app')}</dt>
                  <dd>{t(data.factors.totp ? 'Set up' : 'Not set up')}</dd>
                </div>
                <div>
                  <dt>{t('Unused recovery codes')}</dt>
                  <dd>{data.factors.recovery_codes}</dd>
                </div>
              </dl>
            </SecurityList>
            <SecurityList title={t('Connected identities')}>
              {data.identities.length ? (
                <dl className="security-metadata">
                  {data.identities.map((identity) => (
                    <div key={identity.provider}>
                      <dt>{t(identity.provider === 'steam' ? 'Steam' : 'FACEIT')}</dt>
                      <dd>{identity.subject}</dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p>{t('No external accounts linked.')}</p>
              )}
            </SecurityList>
            <SecurityList title={t('Sessions')}>
              {data.sessions.length ? (
                <ul className="security-list">
                  {data.sessions.map((session) => (
                    <li key={session.id} className="security-list-row">
                      <div>
                        <strong>{session.device || t('Unknown device')}</strong>
                        <small>
                          {session.address || t('Unavailable')} ·{' '}
                          <AccountTime value={session.last_used_at} />
                        </small>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>{t('No active sessions.')}</p>
              )}
            </SecurityList>
          </div>
          <UserActions data={data} reload={reload} onRemove={onRemove} />
        </>
      )}
    </section>
  );
}

const userActions = {
  'change-role': 'Change role',
  'sign-out': 'Sign out everywhere',
  'reset-password': 'Reset password',
  'reset-totp': 'Reset authenticator',
  'reset-passkeys': 'Reset passkeys',
  'reset-recovery': 'Reset recovery codes',
  'unlink-steam': 'Unlink Steam',
  'unlink-faceit': 'Unlink FACEIT',
  delete: 'Delete account',
} as const;
type UserAction = keyof typeof userActions;

function userActionDescription(action: UserAction, role: Role) {
  let effect: string;
  switch (action) {
    case 'change-role':
      effect = t('Change this account to {{v0}} and end all of its active sessions.', {
        v0: roleLabel(role),
      });
      break;
    case 'sign-out':
      return t('All sessions for this account will end.');
    case 'reset-password':
      return t(
        'The current password and any earlier reset link stop working. All sessions end. Give the new one-time recovery link privately to the account owner.',
      );
    case 'reset-totp':
      effect = t(
        'The authenticator app is removed from this account and all sessions end. If no passkey remains, existing recovery codes are also removed.',
      );
      break;
    case 'reset-passkeys':
      effect = t(
        'All passkeys are removed from this account and all sessions end. If no authenticator app remains, existing recovery codes are also removed.',
      );
      break;
    case 'reset-recovery':
      effect = t('Existing recovery codes stop working and all sessions end.');
      break;
    case 'unlink-steam':
      effect = t(
        'Steam sign-in stops and any linked FACEIT profile is disconnected. Saved Steam sync codes and synced matches are cleared. Imported demos stay in the library. All sessions end.',
      );
      break;
    case 'unlink-faceit':
      effect =
        t('FACEIT match access will stop for this account.') +
        ' ' +
        t('All sessions for this account will end.');
      break;
    case 'delete':
      return t(
        'This permanently deletes the account and its demos. Demo files are queued for deletion. Copies may remain in backups.',
      );
  }
  return (
    effect +
    ' ' +
    t(
      'Any earlier password reset link stops working. If the account has no sign-in method left, give its owner the new one-time recovery link privately.',
    )
  );
}

export function RecoveryLinkDetails({
  code,
  close,
  canCopy,
}: {
  code: string;
  close: () => void;
  canCopy?: () => boolean;
}) {
  const link = new URL('/recover', window.location.origin);
  link.hash = code;
  return (
    <>
      <p id="recovery-link-description">
        {t(
          'Share this link privately with the account holder. It works for up to 10 minutes, until it is used or another reset is issued. It is shown only now.',
        )}
      </p>
      <CopyValue label={t('One-time recovery link')} value={link.href} canCopy={canCopy} />
      <button type="button" className="button primary" onClick={close}>
        {t('Done')}
      </button>
    </>
  );
}

function RecoveryLink({
  code,
  username,
  close,
  canCopy,
}: {
  code: string;
  username: string;
  close: () => void;
  canCopy: () => boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => focusReturn(currentFocus()), []);
  useWorkspaceDialog(dialog, true, title);
  return (
    <dialog
      ref={dialog}
      className="confirmation-dialog security-dialog"
      aria-labelledby="recovery-link-title"
      aria-describedby="recovery-link-description"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <h2 ref={title} tabIndex={-1} id="recovery-link-title">
        {t('Recovery link for {{v0}}', { v0: username })}
      </h2>
      <RecoveryLinkDetails code={code} close={close} canCopy={canCopy} />
    </dialog>
  );
}

function UserActions({
  data,
  reload,
  onRemove,
}: {
  data: UserDetails;
  reload: () => void;
  onRemove: () => void;
}) {
  const {
    user: actor,
    session,
    verifiedSessionVersion,
    captureSessionVersion,
    refresh,
    isAdminAvailable,
    signOut,
    notify,
  } = useApp();
  const concealed = useWorkspaceConcealed();
  const { user } = data;
  const task = useAction();
  const confirm = useConfirm();
  const verify = useStepUp('user-action');
  const [role, setRole] = useState(user.role);
  const [chosen, setChosen] = useState<UserAction>();
  const [receipt, setReceipt] = useState<{
    code: string;
    csrf: string;
    expiresAt: number;
    receivedAtVersion: number;
  }>();
  useEffect(() => setRole(user.role), [user.role]);
  useEffect(() => {
    if (!receipt) return;
    if (session.csrf !== receipt.csrf && verifiedSessionVersion > receipt.receivedAtVersion) {
      setReceipt(undefined);
      return;
    }
    const timer = window.setTimeout(
      () => setReceipt(undefined),
      receipt.expiresAt - performance.now(),
    );
    return () => window.clearTimeout(timer);
  }, [receipt, session.csrf, verifiedSessionVersion]);
  const visibleReceipt =
    !concealed &&
    receipt &&
    verifiedSessionVersion > receipt.receivedAtVersion &&
    receipt.csrf === session.csrf &&
    receipt.expiresAt > performance.now() &&
    isAdminAvailable(actor?.id, receipt.csrf)
      ? receipt
      : undefined;
  const can = {
    'sign-out': data.sessions.length > 0,
    'reset-password': true,
    'reset-totp': data.factors.totp,
    'reset-passkeys': data.factors.passkeys > 0,
    'reset-recovery': data.factors.recovery_codes > 0,
    'unlink-steam': data.identities.some(({ provider }) => provider === 'steam'),
    'unlink-faceit': data.identities.some(({ provider }) => provider === 'faceit'),
    delete: true,
  };
  async function act(action: UserAction) {
    if (
      receipt ||
      !isAdminAvailable(actor?.id, session.csrf) ||
      (action === 'change-role' && role === user.role)
    )
      return;
    const label = t(userActions[action]);
    if (
      !(await confirm({
        title: t('{{v0}} for {{v1}}?', { v0: label, v1: user.username }),
        description: userActionDescription(action, role),
        confirmLabel: label,
        tone: action === 'change-role' ? 'normal' : 'danger',
      }))
    )
      return;
    setChosen(action);
    await task.run(async (active) => {
      const csrf = await verify();
      if (!csrf || !active()) return;
      const live = () => active() && isAdminAvailable(actor?.id, csrf);
      if (!live()) throw new SessionChangedError();
      const path = '/api/admin/users/' + encodeURIComponent(user.id) + '/actions';
      const options = {
        method: 'POST',
        body: JSON.stringify(action === 'change-role' ? { action, role } : { action }),
      };
      if (actor?.id === user.id) {
        await signOut({
          sessionContext: csrf,
          request: { path, options },
          selfRecoveryName: actor.username,
        });
        return;
      }
      const startedAt = performance.now();
      let response: { ok: true; recovery_code?: string; recovery_expires_in_ms?: number };
      try {
        response = await api(path, options, csrf);
      } catch (error) {
        await refresh().catch(() => {});
        throw error;
      }
      if (response.recovery_code) {
        const expiresAt = recoveryReceiptDeadline(startedAt, response.recovery_expires_in_ms);
        const receivedAtVersion = captureSessionVersion(csrf);
        // Later paired status and configuration must validate this exact context.
        if (active() && expiresAt > performance.now() && receivedAtVersion !== undefined)
          setReceipt({ code: response.recovery_code, csrf, expiresAt, receivedAtVersion });
        await refresh();
        return;
      }
      await refresh();
      if (!live()) return;
      if (action === 'delete') onRemove();
      else reload();
      notify('Account updated.');
    });
  }
  return (
    <section className="settings-panel security-panel" aria-labelledby="user-actions-title">
      <h3 id="user-actions-title">{t('Account actions')}</h3>
      <SteamStepUpNotice action="user-action" />
      <form
        className="security-filters"
        onSubmit={(event) => {
          event.preventDefault();
          void act('change-role');
        }}
      >
        <div className="security-field">
          <span aria-hidden="true">{t('Role')}</span>
          <SelectControl
            label={t('Role')}
            value={role}
            onValueChange={(value) => setRole(value as Role)}
            options={roles.map((value) => ({ value, label: roleLabel(value) }))}
          />
        </div>
        <button className="button" disabled={task.busy || Boolean(receipt) || role === user.role}>
          {t('Change role')}
        </button>
      </form>
      {chosen === 'change-role' && <ActionError error={task.error} />}
      <ul className="security-admin-actions">
        {(Object.keys(can) as (keyof typeof can)[])
          .filter((action) => can[action])
          .map((action) => (
            <li key={action}>
              <button
                type="button"
                className={'button' + (action === 'delete' ? ' security-danger' : '')}
                disabled={task.busy || Boolean(receipt)}
                onClick={() => void act(action)}
              >
                {t(userActions[action])}
              </button>
              {chosen === action && <ActionError error={task.error} />}
            </li>
          ))}
      </ul>
      {!concealed && receipt && !visibleReceipt && !task.busy && (
        <button
          type="button"
          className="button"
          onClick={() =>
            void task.run(async () => {
              await refresh();
            })
          }
        >
          {t('Try again')}
        </button>
      )}
      {visibleReceipt && (
        <RecoveryLink
          code={visibleReceipt.code}
          username={user.username}
          canCopy={() =>
            visibleReceipt.expiresAt > performance.now() &&
            isAdminAvailable(actor?.id, visibleReceipt.csrf)
          }
          close={() => {
            setReceipt(undefined);
            void task.run(async (active) => {
              await refresh();
              if (active() && isAdminAvailable(actor?.id)) reload();
            });
          }}
        />
      )}
    </section>
  );
}

export function AdminAudit() {
  const [filters, setFilters] = useState({ action: '', outcome: '', target: '' });
  const [outcomeFilter, setOutcomeFilter] = useState(filters.outcome);
  const [offset, setOffset] = useState(0);
  const params = new URLSearchParams({ offset: String(offset) });
  for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
  const result = useResource<EventsPage>('/api/admin/audit?' + params);
  return (
    <section
      className="settings-panel security-panel admin-results"
      aria-labelledby="admin-audit-title"
    >
      <h2 id="admin-audit-title">{t('Security events')}</h2>
      <form
        className="security-filters"
        aria-label={t('Filter security events')}
        onSubmit={(event) => {
          event.preventDefault();
          const fields = new FormData(event.currentTarget);
          setOffset(0);
          setFilters({
            action: String(fields.get('action')).trim(),
            outcome: outcomeFilter,
            target: String(fields.get('target')).trim(),
          });
          result.reload();
        }}
      >
        <label className="security-field">
          {t('Action')}
          <input name="action" maxLength={64} autoCapitalize="none" spellCheck={false} />
        </label>
        <div className="security-field">
          <span aria-hidden="true">{t('Outcome')}</span>
          <SelectControl
            label={t('Outcome')}
            value={outcomeFilter || anyValue}
            onValueChange={(value) => setOutcomeFilter(value === anyValue ? '' : value)}
            options={[
              { value: anyValue, label: t('All outcomes') },
              ...Object.entries(outcomes).map(([value, label]) => ({ value, label: t(label) })),
            ]}
          />
        </div>
        <label className="security-field">
          {t('Target ID')}
          <input name="target" maxLength={64} autoCapitalize="none" spellCheck={false} />
        </label>
        <button className="button primary">{t('Apply filters')}</button>
      </form>
      <FetchStatus {...result} />
      {result.data && !result.loading && (
        <>
          {result.data.events.length ? (
            <ul className="security-list">
              {result.data.events.map((event) => (
                <li className="audit-event" key={event.id}>
                  <div className="audit-event-title">
                    <strong>{event.action}</strong>
                    <span className="member-role">{t(outcomes[event.outcome])}</span>
                  </div>
                  <dl className="security-metadata">
                    <div>
                      <dt>{t('Time')}</dt>
                      <dd>
                        <AccountTime value={event.created_at} />
                      </dd>
                    </div>
                    <div>
                      <dt>{t('Actor ID')}</dt>
                      <dd>{event.actor ?? t('Unavailable')}</dd>
                    </div>
                    <div>
                      <dt>{t('Target ID')}</dt>
                      <dd>{event.target ?? t('Unavailable')}</dd>
                    </div>
                    <div>
                      <dt>{t('Network address')}</dt>
                      <dd>{event.address ?? t('Unavailable')}</dd>
                    </div>
                    {event.intent_id != null && (
                      <div>
                        <dt>{t('Authorization event ID')}</dt>
                        <dd>{event.intent_id}</dd>
                      </div>
                    )}
                  </dl>
                </li>
              ))}
            </ul>
          ) : (
            <p role="status">{t('No security events match these filters.')}</p>
          )}
          <OffsetPagination offset={offset} total={result.data.total} change={setOffset} />
        </>
      )}
    </section>
  );
}

type PolicyOutcome = 'accepted' | 'interrupted' | 'conflict';
type PolicyWrite = { csrf: string; roles: Role[]; outcome: PolicyOutcome };
type PolicyResult =
  { outcome: 'conflict' } | { outcome: 'accepted' | 'interrupted'; matches: boolean };
type PolicyDraft = { expected: Role[]; roles: Role[] };

function sameRoles(left: Role[], right: Role[]) {
  return roles.every((role) => left.includes(role) === right.includes(role));
}

function isPolicyConflict(error: unknown) {
  return error instanceof ApiError && error.status === 409 && error.code === 'mfa_policy_conflict';
}

export function MfaPolicy({
  policy,
  reload,
}: {
  policy: Policy;
  reload: (csrf: string) => Promise<Policy | undefined>;
}) {
  const { user, session, refresh, isAdminAvailable, signOut, notify } = useApp();
  const [draft, setDraft] = useState<PolicyDraft>();
  const [pending, setPending] = useState<PolicyWrite>();
  const [result, setResult] = useState<PolicyResult>();
  const currentPolicy = useRef(policy);
  const task = useAction();
  const confirm = useConfirm();
  const verify = useStepUp('mfa-policy');
  const currentDraft =
    draft && !policy.locked && sameRoles(policy.value, draft.expected) ? draft : undefined;
  const selected = currentDraft?.roles ?? policy.value;
  const dirty = !sameRoles(policy.value, selected);
  const disabled = policy.locked || task.busy || Boolean(pending);
  const delivery = pending ?? result;
  useLayoutEffect(() => {
    currentPolicy.current = policy;
    if (draft && !currentDraft) {
      setDraft(undefined);
      if (!task.busy && !pending && !sameRoles(draft.roles, draft.expected))
        setResult({ outcome: 'conflict' });
    }
  }, [policy, draft, currentDraft, task.busy, pending]);

  function discardStaleDraft(expected: Role[]) {
    const current = currentPolicy.current;
    if (!current.locked && sameRoles(current.value, expected)) return false;
    setDraft(undefined);
    setResult({ outcome: 'conflict' });
    return true;
  }

  async function checkPolicy(update: PolicyWrite, csrf: string, active: () => boolean) {
    await refresh();
    const live = () => active() && isAdminAvailable(user?.id, csrf);
    if (!live()) return;
    const current = await reload(csrf);
    if (!live() || !current) return;
    setDraft(undefined);
    setPending(undefined);
    if (update.outcome === 'conflict') {
      setResult({ outcome: 'conflict' });
      return;
    }
    const matches = sameRoles(current.value, update.roles);
    if (update.outcome === 'accepted' && matches && csrf === update.csrf)
      notify('Second-factor policy saved.');
    else setResult({ outcome: update.outcome, matches });
  }

  return (
    <SecuritySection
      title={t('Required second factor')}
      description={t(
        'Members in the selected roles must set up a passkey or an authenticator app.',
      )}
    >
      <form
        className="settings-panel admin-policy-panel security-panel"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!currentDraft || !dirty || disabled || !isAdminAvailable(user?.id)) return;
          const expected = currentDraft.expected;
          if (
            !(await confirm({
              title: t('Change second-factor policy?'),
              description: t(
                'Accounts affected by the new requirement may need to sign in and set up a second factor.',
              ),
              confirmLabel: t('Save policy'),
            }))
          )
            return;
          void task.run(async (active) => {
            setResult(undefined);
            if (discardStaleDraft(expected)) return;
            const csrf = await verify();
            if (!csrf) return;
            const live = () => active() && isAdminAvailable(user?.id, csrf);
            if (!live() || discardStaleDraft(expected)) return;
            const path = '/api/admin/mfa-policy';
            const options = {
              method: 'PUT',
              body: JSON.stringify({ roles: selected, expected_roles: expected }),
            };
            const retiresSession =
              user &&
              selected.includes(user.role) &&
              session.factors &&
              !session.factors.passkey &&
              !session.factors.totp;
            let outcome: PolicyOutcome = 'interrupted';
            try {
              if (retiresSession) {
                await signOut({
                  sessionContext: csrf,
                  request: {
                    path,
                    options,
                    reconcileSessionOnly: true,
                  },
                });
                if (!live()) return;
                outcome = 'accepted';
              } else {
                const response = await api<{ ok: boolean }>(
                  path,
                  { ...options, signal: sessionDeadline() },
                  csrf,
                );
                if (response?.ok === true) outcome = 'accepted';
              }
            } catch (error) {
              // A lost reply or gateway failure can follow a committed change.
              if (isPolicyConflict(error)) outcome = 'conflict';
              else if (
                error instanceof SessionChangedError ||
                (error instanceof ApiError && error.status < 500 && error.status !== 408)
              ) {
                if (!retiresSession) await refresh().catch(() => {});
                throw error;
              }
            }
            const update = { csrf, roles: selected, outcome };
            if (active()) {
              if (outcome === 'conflict') setDraft(undefined);
              setPending(update);
            }
            await checkPolicy(update, csrf, active);
          });
        }}
      >
        <SteamStepUpNotice action="mfa-policy" />
        <div className="admin-policy-rows">
          {roles.map((role) => (
            <SwitchRow
              key={role}
              label={roleLabel(role)}
              locked={policy.locked}
              checked={selected.includes(role)}
              disabled={disabled}
              onChange={(checked) => {
                setResult(undefined);
                setDraft({
                  expected: currentDraft?.expected ?? policy.value,
                  roles: checked
                    ? [...selected, role]
                    : selected.filter((selectedRole) => selectedRole !== role),
                });
              }}
            />
          ))}
        </div>
        {!pending && <ActionError error={task.error} />}
        {delivery && (
          <p role={delivery.outcome === 'conflict' ? 'alert' : 'status'}>
            {t(
              delivery.outcome === 'conflict'
                ? 'The second-factor policy changed while you were editing.'
                : delivery.outcome === 'accepted'
                  ? 'The server accepted the policy change.'
                  : 'The save response was interrupted.',
            )}{' '}
            {result
              ? t(
                  result.outcome === 'conflict'
                    ? 'Review the current policy before saving again.'
                    : result.matches
                      ? 'The current policy matches your selection.'
                      : 'The current policy differs from your selection.',
                )
              : t(
                  task.busy
                    ? 'Checking the current policy…'
                    : 'The current policy could not be checked.',
                )}
          </p>
        )}
        {(!policy.locked || pending) && (
          <div className="form-actions">
            {!policy.locked && (
              <button className="button primary" disabled={!dirty || disabled}>
                {t(task.busy && !pending ? 'Saving…' : 'Save policy')}
              </button>
            )}
            {pending && (
              <button
                type="button"
                className="button"
                disabled={task.busy}
                onClick={() =>
                  void task.run((active) => checkPolicy(pending, session.csrf, active))
                }
              >
                {t('Check current policy')}
              </button>
            )}
          </div>
        )}
      </form>
    </SecuritySection>
  );
}
