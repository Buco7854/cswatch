import { api } from '../api';
import { reconcile } from '../auth-actions';
import { useApp } from '../context';
import { t } from '../i18n';
import { useAction } from '../useAction';
import { useResource } from '../useResource';
import { AccountTime, ActionError, SecuritySection } from './AuthControls';
import { useConfirm } from './Confirmation';
import { SteamStepUpNotice, useStepUp } from './StepUp';

type SessionRow = {
  id: string;
  device: string;
  address: string | null;
  created_at: number;
  last_used_at: number;
  expires_at: number;
  current: boolean;
};

function DeviceSession({ session, reload }: { session: SessionRow; reload: () => void }) {
  const { refresh, signOut, session: currentSession } = useApp();
  const confirm = useConfirm();
  const verify = useStepUp('sessions');
  const task = useAction();
  return (
    <li className="security-list-row">
      <div>
        <strong>{session.device || t('Unknown device')}</strong>
        {session.current && <span className="member-role">{t('This session')}</span>}
        <dl className="security-metadata">
          <div>
            <dt>{t('Approximate network')}</dt>
            <dd>{session.address || t('Unavailable')}</dd>
          </div>
          <div>
            <dt>{t('Signed in')}</dt>
            <dd>
              <AccountTime value={session.created_at} />
            </dd>
          </div>
          <div>
            <dt>{t('Last active')}</dt>
            <dd>
              <AccountTime value={session.last_used_at} />
            </dd>
          </div>
          <div>
            <dt>{t('Expires')}</dt>
            <dd>
              <AccountTime value={session.expires_at} />
            </dd>
          </div>
        </dl>
      </div>
      <button
        className="button"
        type="button"
        disabled={task.busy}
        onClick={async () => {
          if (
            !(await confirm({
              title: t('Sign out this session?'),
              description: session.current
                ? t('You will be signed out of this browser.')
                : t('This device will have to sign in again.'),
              confirmLabel: t('Sign out session'),
              tone: 'danger',
            }))
          )
            return;
          void task.run(async (active) => {
            const csrf = session.current ? currentSession.csrf : await verify();
            if (!csrf || !active()) return;
            const path = '/api/auth/sessions/' + encodeURIComponent(session.id);
            const options = { method: 'DELETE' };
            if (session.current)
              await signOut({
                sessionContext: csrf,
                request: { path, options, requireAnonymousStatus: true },
              });
            else await reconcile(api(path, options, csrf), refresh);
            if (active()) reload();
          });
        }}
      >
        {t('Sign out session')}
      </button>
      <ActionError error={task.error} />
    </li>
  );
}

export default function AccountSessions() {
  const { signOut } = useApp();
  const sessions = useResource<{ sessions: SessionRow[] }>('/api/auth/sessions');
  const verify = useStepUp('sessions');
  const confirm = useConfirm();
  const task = useAction();
  return (
    <SecuritySection
      title={t('Signed-in devices')}
      description={t(
        'Review where your account is signed in and end any session you no longer need.',
      )}
    >
      <div className="settings-panel security-panel">
        <SteamStepUpNotice action="sessions" />
        {sessions.loading && <p role="status">{t('Loading sessions…')}</p>}
        {sessions.error && (
          <>
            <ActionError error={sessions.error} />
            <button className="button" onClick={sessions.reload}>
              {t('Try again')}
            </button>
          </>
        )}
        {sessions.data &&
          (sessions.data.sessions.length ? (
            <>
              <ul className="security-list">
                {sessions.data.sessions.map((session) => (
                  <DeviceSession session={session} key={session.id} reload={sessions.reload} />
                ))}
              </ul>
              <button
                className="button"
                type="button"
                disabled={task.busy}
                onClick={async () => {
                  if (
                    !(await confirm({
                      title: t('Sign out on all devices?'),
                      description: t('Every session will end, including this browser.'),
                      confirmLabel: t('Sign out everywhere'),
                      tone: 'danger',
                    }))
                  )
                    return;
                  void task.run(async (active) => {
                    const csrf = await verify();
                    if (!csrf || !active()) return;
                    await signOut({
                      sessionContext: csrf,
                      request: {
                        path: '/api/auth/sessions/revoke-all',
                        options: { method: 'POST' },
                      },
                    });
                  });
                }}
              >
                {t('Sign out everywhere')}
              </button>
              <ActionError error={task.error} />
            </>
          ) : (
            <p>{t('No active sessions.')}</p>
          ))}
      </div>
    </SecuritySection>
  );
}
