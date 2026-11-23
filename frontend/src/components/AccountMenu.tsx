import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { ChevronDown, Link2, LogOut, Settings2, ShieldCheck } from 'lucide-react';
import { api } from '../api';
import { useApp } from '../context';
import { t } from '../i18n';
import { ActionMenu, type MenuAction } from './Controls';

export default function AccountMenu({
  compact = false,
  extraActions = [],
  label,
}: {
  compact?: boolean;
  extraActions?: MenuAction[];
  label?: string;
}) {
  const { user, refresh, notify } = useApp();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => setOpen(false), [location.pathname]);
  if (!user) return null;
  async function logout() {
    setBusy(true);
    try {
      await api('/api/auth/logout', { method: 'POST' });
      await refresh();
    } catch (error) {
      notify((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const items: MenuAction[] = [
    { id: 'account', label: t('Account settings'), icon: <Settings2 size={16} />, to: '/account' },
    {
      id: 'connections',
      label: t('Connections'),
      icon: <Link2 size={16} />,
      to: '/account/connections',
    },
    ...(user.is_admin
      ? [
          {
            id: 'admin',
            label: t('Administration'),
            icon: <ShieldCheck size={16} />,
            to: '/admin',
            separatorBefore: true,
          },
        ]
      : []),
    ...extraActions,
    {
      id: 'logout',
      label: t('Sign out'),
      icon: <LogOut size={16} />,
      onSelect: () => void logout(),
      disabled: busy,
      separatorBefore: true,
    },
  ];
  return (
    <ActionMenu
      label={label || t('Account menu')}
      open={open}
      onOpenChange={setOpen}
      heading={
        <>
          <small>{t('Signed in as')}</small>
          <strong>{user.username}</strong>
        </>
      }
      trigger={
        <button
          className={'account-button' + (compact ? ' compact-account' : '')}
          aria-label={label || user.username}
        >
          <span className="avatar" aria-hidden="true">
            {Array.from(user.username)[0].toUpperCase()}
          </span>
          {!compact && <span className="account-name">{user.username}</span>}
          <ChevronDown size={14} aria-hidden="true" />
        </button>
      }
      items={items}
    />
  );
}
