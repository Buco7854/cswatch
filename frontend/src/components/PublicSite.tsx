import type { ReactNode } from 'react';
import { ArrowUpRight, Github, LockKeyhole, LogIn, Moon, Sun } from 'lucide-react';
import { t } from '../i18n';
import { useApp } from '../context';
import Brand from './Brand';
import DemoConnectionsLink from './DemoConnectionsLink';
import LanguageControl from './LanguageControl';
import LandingBackdrop from './LandingBackdrop';
import Upload from './Upload';

const repository = 'https://github.com/Buco7854/cswatch';

export function PublicShell({
  children,
  theme,
  toggleTheme,
}: {
  children: ReactNode;
  theme: string;
  toggleTheme: () => void;
}) {
  const { signIn } = useApp();
  return (
    <div className="public-site">
      <header className="public-header">
        <Brand />
        <div className="public-utilities">
          <LanguageControl />
          <button
            className="icon-button"
            aria-label={t(theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme')}
            onClick={toggleTheme}
          >
            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          <button className="button public-signin" aria-label={t('Sign in')} onClick={signIn}>
            <LogIn size={16} />
            <span>{t('Sign in')}</span>
          </button>
        </div>
      </header>
      <main id="main">{children}</main>
      <footer className="public-footer">
        <span>{t('Independent project. Not affiliated with Valve or FACEIT.')}</span>
        <a href={repository} target="_blank" rel="noreferrer">
          <Github size={17} /> GitHub <ArrowUpRight size={14} />
        </a>
      </footer>
    </div>
  );
}

export function Landing() {
  const { config, signIn } = useApp();
  return (
    <section className="landing-upload" aria-labelledby="landing-title">
      <LandingBackdrop enabled={config.public_access && !config.setup_required} />
      <div className="landing-workspace">
        <header className="landing-copy">
          <h1 id="landing-title">{t('Review your CS2 demos.')}</h1>
          <p>{t('Watch each round from any player’s perspective.')}</p>
        </header>
        {config.guest_uploads_enabled ? (
          <>
            <Upload compact />
            <p className="landing-privacy">
              <LockKeyhole size={15} aria-hidden="true" />
              {t('Private upload · {{hours}}h maximum.', {
                hours: config.guest_retention_hours,
              })}
            </p>
          </>
        ) : (
          <button className="button primary" onClick={signIn}>
            <LogIn size={16} aria-hidden="true" />
            {t('Sign in to upload')}
          </button>
        )}
        <DemoConnectionsLink />
      </div>
    </section>
  );
}
