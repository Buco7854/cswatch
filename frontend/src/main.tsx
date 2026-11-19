import { t } from './i18n';
import { useTranslation } from 'react-i18next';
import { PublicShell, Landing } from './components/PublicSite';
import Setup from './components/Setup';
import { ConfirmationProvider } from './components/Confirmation';
import { Component, StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  BrowserRouter,
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router-dom';
import { X } from 'lucide-react';
import { api, setCsrf } from './api';
import { AppContext } from './context';
import type { Config, User } from './types';
import Library from './components/Library';
import Viewer from './components/Viewer';
import WorkspaceShell from './components/WorkspaceShell';
import { Account, Admin } from './components/Settings';
import AuthPage from './components/AuthPage';
import { authPath } from './auth-navigation';
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import './styles.css';
import './workspace.css';
import './brand.css';
import './public.css';
import './member.css';
import './member-controls.css';
import './viewer-layout.css';
import './viewer-presentation.css';
import './components/auth.css';
import '@fontsource/barlow-condensed/latin-600.css';
import '@fontsource/barlow-condensed/latin-700.css';

class Boundary extends Component<{ children: ReactNode }, { error: boolean }> {
  state = { error: false };
  static getDerivedStateFromError() {
    return { error: true };
  }
  render() {
    return this.state.error ? (
      <main className="fatal">
        <h1>{t('Something went wrong.')}</h1>
        <p>{t('Reload the page to reopen your review room.')}</p>
        <a className="button primary" href="/">
          {t('Return to library')}
        </a>
      </main>
    ) : (
      this.props.children
    );
  }
}
function App() {
  useTranslation();
  const navigate = useNavigate();
  const [theme, setTheme] = useState(() => {
    try {
      const requested = new URLSearchParams(window.location.search).get('theme');
      return requested === 'light' ||
        (requested !== 'dark' && localStorage.getItem('theme') === 'light')
        ? 'light'
        : 'dark';
    } catch {
      return 'light';
    }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('theme', theme);
    } catch {}
  }, [theme]);
  const [user, setUser] = useState<User | null>(null),
    [config, setConfig] = useState<Config | null>(null),
    [toast, setToast] = useState(''),
    [error, setError] = useState('');
  const location = useLocation();
  const refreshGeneration = useRef(0);
  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    try {
      const [c, r] = await Promise.all([
        api<Config>('/api/config'),
        api<{ user: User | null; guest_session?: { csrf: string; expires_at: number } | null }>(
          '/api/auth/me',
        ),
      ]);
      if (generation !== refreshGeneration.current) return;
      setConfig(c);
      setUser(r.user);
      setCsrf(r.user?.csrf || r.guest_session?.csrf || '');
    } catch (failure) {
      // A newer session check owns both identity and connection errors. An older
      // response cannot restore a previous account or fail the current screen.
      if (generation === refreshGeneration.current) throw failure;
    }
  }, []);
  useEffect(() => {
    refresh().catch((e) => setError(e.message));
    return () => {
      refreshGeneration.current++;
    };
  }, [refresh]);
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location.pathname]);
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(''), 8000);
      return () => clearTimeout(t);
    }
  }, [toast]);
  useEffect(() => {
    function arrows(e: KeyboardEvent) {
      if (
        e.defaultPrevented ||
        !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)
      )
        return;
      const active = document.activeElement as HTMLElement;
      if (
        !active ||
        !active.matches('button,a,summary') ||
        active.closest('.viewer-frame,[role="menu"],[role="listbox"]')
      )
        return;
      const dialog =
        document.querySelector('dialog[open]') ||
        document.querySelector('[role="dialog"][aria-modal="true"]');
      const candidates = [
        ...(dialog || document).querySelectorAll<HTMLElement>(
          'a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),summary',
        ),
      ].filter(
        (el) =>
          el !== active &&
          !el.closest('[inert]') &&
          el.getBoundingClientRect().width > 0 &&
          (!el.checkVisibility || el.checkVisibility()) &&
          (!el.closest('details:not([open])') || el.closest('summary')),
      );
      const a = active.getBoundingClientRect(),
        ax = a.x + a.width / 2,
        ay = a.y + a.height / 2;
      let best: HTMLElement | undefined,
        score = Infinity;
      for (const el of candidates) {
        const b = el.getBoundingClientRect(),
          dx = b.x + b.width / 2 - ax,
          dy = b.y + b.height / 2 - ay;
        const horizontal = e.key === 'ArrowLeft' || e.key === 'ArrowRight',
          ahead =
            e.key === 'ArrowLeft'
              ? -dx
              : e.key === 'ArrowRight'
                ? dx
                : e.key === 'ArrowUp'
                  ? -dy
                  : dy;
        if (ahead <= 1) continue;
        const distance = ahead + Math.abs(horizontal ? dy : dx) * 3;
        if (distance < score) {
          score = distance;
          best = el;
        }
      }
      if (best) {
        e.preventDefault();
        best.focus();
        best.scrollIntoView({ block: 'nearest' });
      }
    }
    document.addEventListener('keydown', arrows);
    return () => document.removeEventListener('keydown', arrows);
  }, []);
  if (error)
    return (
      <main className="fatal">
        <h1>{t('Connection unavailable')}</h1>
        <p role="alert">{t(error)}</p>
        <button
          className="button primary"
          onClick={() => {
            setError('');
            void refresh().catch((e) => setError(e.message));
          }}
        >
          {t('Retry')}
        </button>
      </main>
    );
  if (!config)
    return (
      <main className="fatal">
        <p>{t('Opening your review room…')}</p>
      </main>
    );
  const authRoute = ['/login', '/register'].includes(location.pathname);
  const accountRoute = [
    '/library',
    '/connections',
    '/account',
    '/account/connections',
    '/admin',
  ].includes(location.pathname);
  const privateGate = !user && (!config.public_access || accountRoute);
  const publicSurface = location.pathname === '/' && !user;
  const guestPath = location.pathname + location.search + location.hash;
  const pageTitle = location.pathname.startsWith('/watch')
    ? t('Match review')
    : ['/connections', '/account/connections'].includes(location.pathname)
      ? t('Connected accounts')
      : location.pathname === '/account'
        ? t('Account settings')
        : location.pathname === '/admin'
          ? t('Administration')
          : t('Demo library');
  return (
    <AppContext.Provider
      value={{
        user,
        config,
        refresh,
        notify: setToast,
        signIn: () =>
          navigate(authPath('login', publicSurface ? '/library' : guestPath), {
            state: { authFrom: guestPath },
          }),
      }}
    >
      <a className="skip-link" href="#main">
        {t('Skip to content')}
      </a>
      {config.setup_required ? (
        location.pathname === '/setup' ? (
          <Setup onComplete={refresh} />
        ) : (
          <Navigate replace to="/setup" />
        )
      ) : location.pathname === '/setup' ? (
        <Navigate replace to={user ? '/library' : '/'} />
      ) : location.pathname === '/' && user ? (
        <Navigate replace to="/library" />
      ) : authRoute ? (
        <AuthPage
          key={location.key}
          theme={theme}
          toggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        />
      ) : privateGate ? (
        <Navigate
          replace
          to={authPath('login', guestPath)}
          state={{ authFrom: config.public_access ? '/' : guestPath }}
        />
      ) : publicSurface ? (
        <PublicShell
          theme={theme}
          toggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        >
          <Landing />
        </PublicShell>
      ) : location.pathname.startsWith('/watch/') ? (
        <div className="viewer-shell">
          <main id="main" className="viewer-page">
            <Routes>
              <Route
                path="/watch/:id"
                element={
                  <Viewer
                    theme={theme}
                    toggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
                  />
                }
              />
            </Routes>
          </main>
        </div>
      ) : (
        <WorkspaceShell
          title={pageTitle}
          theme={theme}
          toggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        >
          <Routes>
            <Route path="/library" element={<Library />} />
            <Route path="/explore" element={<Navigate replace to={user ? '/library' : '/'} />} />
            <Route
              path="/features/:kind"
              element={<Navigate replace to={user ? '/library' : '/'} />}
            />
            <Route path="/self-host" element={<Navigate replace to={user ? '/library' : '/'} />} />
            <Route
              path="/connections"
              element={<Navigate replace to={'/account/connections' + location.search} />}
            />
            <Route path="/account" element={<Account />} />
            <Route path="/account/connections" element={<Account section="connections" />} />
            <Route path="/admin" element={<Admin />} />
            <Route
              path="*"
              element={
                <div className="inline-state">
                  <h1>{t('Page not found')}</h1>
                  <Link className="button" to="/library">
                    {t('Back to library')}
                  </Link>
                </div>
              }
            />
          </Routes>
        </WorkspaceShell>
      )}
      {toast && (
        <div className={'toast' + (!publicSurface ? ' member-toast' : '')} role="status">
          <span>{t(toast)}</span>
          <button
            className="icon-button"
            aria-label={t('Dismiss notification')}
            onClick={() => setToast('')}
          >
            <X size={16} />
          </button>
        </div>
      )}
    </AppContext.Provider>
  );
}
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Boundary>
      <BrowserRouter>
        <ConfirmationProvider>
          <App />
        </ConfirmationProvider>
      </BrowserRouter>
    </Boundary>
  </StrictMode>,
);
