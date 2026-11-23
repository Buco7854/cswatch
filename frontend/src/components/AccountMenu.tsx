import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { ChevronDown, Link2, LogOut, Settings2, ShieldCheck } from 'lucide-react';
import { hasPermission } from '../../../shared/roles.mjs';
import { useApp } from '../context';
import { t } from '../i18n';
import { useAction } from '../useAction';
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
  const { user, config, signOut, notify } = useApp();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const logout = useAction();
  useEffect(() => setOpen(false), [location.pathname]);
  if (!user) return null;
  const items: MenuAction[] = [
    { id: 'account', label: t('Account settings'), icon: <Settings2 size={16} />, to: '/account' },
    {
      id: 'connections',
      label: t('Connections'),
      icon: <Link2 size={16} />,
      to: '/account/connections',
    },
    ...(config.admin_access
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
      onSelect: () =>
        void logout.run(async (active) => {
          try {
            await signOut();
          } catch (error) {
            if (active()) notify((error as Error).message);
          }
        }),
      disabled: logout.busy,
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
          <strong>{user.display_name || user.username}</strong>
          {!config.admin_access && hasPermission(user.role, 'admin') && (
            <small>{t('Administration is unavailable from this network.')}</small>
          )}
        </>
      }
      trigger={
        <button
          className={'account-button' + (compact ? ' compact-account' : '')}
          aria-label={label || user.username}
        >
          <span className="avatar" aria-hidden="true">
            {Array.from(user.display_name || user.username)[0].toUpperCase()}
          </span>
          {!compact && <span className="account-name">{user.display_name || user.username}</span>}
          <ChevronDown size={14} aria-hidden="true" />
        </button>
      }
      items={items}
    />
  );
}
