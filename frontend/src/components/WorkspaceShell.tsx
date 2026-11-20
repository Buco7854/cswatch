import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import {
  ArrowUpRight,
  Clapperboard,
  Globe2,
  LockKeyhole,
  Moon,
  Sun,
  UserRound,
} from 'lucide-react';
import { t } from '../i18n';
import { useApp } from '../context';
import Brand from './Brand';
import AccountMenu from './AccountMenu';
import LanguageControl from './LanguageControl';

export default function WorkspaceShell({
  theme,
  toggleTheme,
  children,
}: {
  theme: string;
  toggleTheme: () => void;
  children: ReactNode;
}) {
  const { user, config, signIn } = useApp();
  return (
    <div className="app-shell">
      <header className="workspace-bar">
        <Brand to="/library" />
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
      <div className="workspace-body">
        <aside className="workspace-rail">
          <nav aria-label={t('Main navigation')}>
            <NavLink end to="/library">
              <Clapperboard size={17} aria-hidden="true" />
              {t('Demo library')}
            </NavLink>
          </nav>
        </aside>
        <div className="workspace">
          <main id="main" className="main">
            {children}
          </main>
          <footer className="workspace-footer">
            <span className="instance-identity">
              {config.public_access ? <Globe2 size={15} /> : <LockKeyhole size={15} />}
              {t(config.public_access ? 'Public instance' : 'Private instance')}
            </span>
            <a href="https://github.com/Buco7854/cswatch" target="_blank" rel="noreferrer">
              GitHub <ArrowUpRight size={13} aria-hidden="true" />
            </a>
          </footer>
        </div>
      </div>
    </div>
  );
}
