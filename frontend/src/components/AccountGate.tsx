import { ArrowUpRight, LockKeyhole } from 'lucide-react';
import { useApp } from '../context';
import { t } from '../i18n';
export default function AccountGate({
  kind = 'library',
}: {
  kind?: 'library' | 'account' | 'connections';
}) {
  const { signIn, config } = useApp();
  return (
    <section className="account-gate">
      <LockKeyhole size={30} strokeWidth={1.4} />
      <h1>
        {t(
          kind === 'library'
            ? 'Your review needs a home.'
            : kind === 'connections'
              ? 'Your accounts, in one place.'
              : 'Account settings',
        )}
      </h1>
      <p>
        {t(
          kind === 'library'
            ? 'Sign in to keep a private library and save review notes. You will return here after signing in.'
            : kind === 'connections'
              ? 'Sign in to connect Steam and verify your FACEIT profile.'
              : 'Sign in to manage your identity, password, and connected accounts.',
        )}
      </p>
      <button className="button primary" onClick={signIn}>
        {t('Sign in to continue')}
        <ArrowUpRight size={17} />
      </button>
      {!config.registrations_enabled && (
        <small>
          {t('New registrations are closed on this instance. Existing members can still sign in.')}
        </small>
      )}
    </section>
  );
}
