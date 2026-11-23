import { Moon, Sun } from 'lucide-react';
import type { ReactNode } from 'react';
import { t } from '../i18n';
import Brand from './Brand';
import LanguageControl from './LanguageControl';

export type AuthAppearance = { theme: string; toggleTheme: () => void };

export default function AuthFrame({
  theme,
  toggleTheme,
  children,
}: AuthAppearance & { children: ReactNode }) {
  return (
    <div className="auth-page">
      <header className="auth-header">
        <Brand />
        <div className="auth-utilities">
          <LanguageControl />
          <button
            className="icon-button"
            aria-label={t(theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme')}
            onClick={toggleTheme}
          >
            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
          </button>
        </div>
      </header>
      <main id="main" className="auth-main">
        {children}
      </main>
    </div>
  );
}
