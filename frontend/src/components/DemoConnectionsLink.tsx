import { ChevronRight, Link2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { authPath } from '../auth-navigation';
import { useApp } from '../context';
import { t } from '../i18n';

const connections = '/account/connections';

export default function DemoConnectionsLink() {
  const { user } = useApp();
  return (
    <Link
      className="demo-connections-link"
      to={user ? connections : authPath('login', connections)}
      state={user ? undefined : { authFrom: '/' }}
    >
      <Link2 size={19} aria-hidden="true" />
      <span className="demo-connections-copy">
        <strong>{t('Steam and FACEIT')}</strong>
        <span>{t(user ? 'Connected accounts' : 'Sign in to connect')}</span>
      </span>
      <ChevronRight size={17} aria-hidden="true" />
    </Link>
  );
}
