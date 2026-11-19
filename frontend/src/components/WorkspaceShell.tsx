import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import {
  ArrowUpRight,
  ChevronRight,
  Globe2,
  LockKeyhole,
  Menu,
  Moon,
  PanelsTopLeft,
  Sun,
  X,
  UserRound,
} from 'lucide-react';
import { t } from '../i18n';
import { useApp } from '../context';
import Brand from './Brand';
import AccountMenu from './AccountMenu';
import LanguageControl from './LanguageControl';

export default function WorkspaceShell({
  title,
  theme,
  toggleTheme,
  children,
}: {
  title: string;
  theme: string;
  toggleTheme: () => void;
  children: ReactNode;
}) {
  const { user, config, signIn } = useApp();
  const [mobileOpen, setMobileOpen] = useState(false);
  const navigationDialog = useRef<HTMLDialogElement>(null);
  const navigationTrigger = useRef<HTMLButtonElement>(null);
  const location = useLocation();
  useEffect(() => setMobileOpen(false), [location.pathname]);
  useEffect(() => {
    if (mobileOpen) navigationDialog.current?.showModal();
    else navigationDialog.current?.close();
  }, [mobileOpen]);
  function closeNavigation() {
    setMobileOpen(false);
    navigationTrigger.current?.focus();
  }
  const navigation = (
    <>
      <NavLink end to="/library">
        <PanelsTopLeft size={18} />
        {t('Demo library')}
      </NavLink>
    </>
  );
  const instance = (
    <div className="instance-identity">
      {config.public_access ? <Globe2 size={16} /> : <LockKeyhole size={16} />}
      <span>
        {t(config.public_access ? 'Public instance' : 'Private instance')}
        <small>{t('Self-hosted. Your rules.')}</small>
      </span>
    </div>
  );
  return (
    <div className="app-shell">
      <aside className="site-sidebar">
        <Brand to="/library" />
        <nav className="sidebar-nav" aria-label={t('Main navigation')}>
          {navigation}
        </nav>
        <div className="sidebar-bottom">
          {instance}
          <a
            className="public-site-link"
            href="https://github.com/Buco7854/cswatch"
            target="_blank"
            rel="noreferrer"
          >
            GitHub
            <ArrowUpRight size={13} />
          </a>
        </div>
      </aside>
      <div className="workspace">
        <header className="workspace-bar">
          <div className="workspace-location">
            <button
              ref={navigationTrigger}
              className="icon-button mobile-menu"
              onClick={() => setMobileOpen(true)}
              aria-label={t('Toggle navigation')}
              aria-expanded={mobileOpen}
              aria-haspopup="dialog"
            >
              <Menu size={19} />
            </button>
            <span className="mobile-wordmark">cswatch</span>
            <span className="desktop-location">
              cswatch <ChevronRight size={13} />
              <strong>{title}</strong>
            </span>
          </div>
          <div className="nav-actions">
            <LanguageControl className="workspace-language" />
            <button
              className="icon-button theme-toggle"
              aria-label={t(theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme')}
              onClick={toggleTheme}
            >
              {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
            </button>
            {user ? (
              <AccountMenu />
            ) : (
              <button
                className="button primary workspace-signin"
                aria-label={t('Sign in')}
                onClick={signIn}
              >
                <UserRound size={18} className="workspace-signin-icon" />
                <span className="workspace-signin-label">{t('Sign in')}</span>
                <ArrowUpRight size={15} className="workspace-signin-arrow" />
              </button>
            )}
          </div>
        </header>
        <div className="workspace-sheet">
          <main id="main" className="main">
            {children}
          </main>
          <footer className="site-footer">
            <span>{t('Made for the next round.')}</span>
            <span>{t('Independent project. Not affiliated with Valve or FACEIT.')}</span>
          </footer>
        </div>
      </div>
      <dialog
        ref={navigationDialog}
        className="member-dialog mobile-navigation"
        aria-labelledby="mobile-navigation-title"
        onCancel={closeNavigation}
        onClick={(event) => {
          if (event.target === navigationDialog.current) closeNavigation();
        }}
      >
        <div className="mobile-navigation-heading">
          <Brand to="/library" />
          <button
            className="icon-button"
            aria-label={t('Close navigation')}
            onClick={closeNavigation}
          >
            <X size={20} />
          </button>
        </div>
        <h2 id="mobile-navigation-title" className="visually-hidden">
          {t('Main navigation')}
        </h2>
        <nav className="mobile-navigation-links" aria-label={t('Main navigation')}>
          {navigation}
        </nav>
        {user && (
          <Link className="mobile-account-link" to="/account">
            <span className="avatar">{user.username.slice(0, 1).toUpperCase()}</span>
            <span>
              {user.username}
              <small>{t('Account settings')}</small>
            </span>
            <ChevronRight size={16} />
          </Link>
        )}
        <div className="mobile-navigation-footer">
          {instance}
          <a href="https://github.com/Buco7854/cswatch" target="_blank" rel="noreferrer">
            GitHub
            <ArrowUpRight size={14} />
          </a>
        </div>
      </dialog>
    </div>
  );
}
