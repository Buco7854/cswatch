import { ArrowUpRight, LockKeyhole } from 'lucide-react';
import { useApp } from '../context';
import { t } from '../i18n';
export default function AccountGate() {
  const { signIn, config } = useApp();
  return (
    <section className="account-gate">
      <LockKeyhole size={30} strokeWidth={1.4} />
      <h1>{t('Your review needs a home.')}</h1>
      <p>
        {t(
          'Sign in to upload demos, keep a private library, and save your notes. You will return here after signing in.',
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
