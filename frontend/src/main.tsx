import { t } from './i18n';
import { useTranslation } from 'react-i18next';
import { PublicShell, Landing } from './components/PublicSite';
import Setup from './components/Setup';
import { ConfirmationProvider } from './components/Confirmation';
import {
  Component,
  StrictMode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import {
  BrowserRouter,
  Link,
  matchRoutes,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router-dom';
import { X } from 'lucide-react';
import { hasPermission } from '../../shared/roles.mjs';
import {
  api,
  ApiError,
  observeAccessChanges,
  SessionChangedError,
  sessionDeadline,
  setCsrf,
} from './api';
import { BrowserStorageError } from './browser-bootstrap';
import { AppContext, WorkspaceConcealed, type SignOutOptions } from './context';
import type { AuthStatus, Config } from './types';
import { MatchActivity } from './match-activity';
import { recoveryReceiptDeadline } from './auth-actions';
import Library from './components/Library';
import Viewer from './components/Viewer';
import WorkspaceShell from './components/WorkspaceShell';
import { Account, Admin, AdminAccessNotice } from './components/Settings';
import AuthPage from './components/AuthPage';
import { discardVerificationCode, EmailOnboarding, VerifyEmail } from './components/AccountEmail';
import AuthFrame from './components/AuthFrame';
import { RecoveryLinkDetails } from './components/AdminAccounts';
import Recover, { discardInitialRecoveryCode } from './components/Recover';
import { StepUpProvider } from './components/StepUp';
import { authPath, authReturnPath } from './auth-navigation';
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
import './components/account-security.css';
import '@fontsource/barlow-condensed/latin-600.css';
import '@fontsource/barlow-condensed/latin-700.css';

const adminRoute = { path: '/admin' };
const isAdminPage = (pathname: string) => matchRoutes([adminRoute], pathname) !== null;
const accountForms = [
  '/account/*',
  '/recover',
  '/verify-email',
  '/register',
  '/login',
  '/setup',
].map((path) => ({
  path,
}));
function openDemoId() {
  const id = matchRoutes([{ path: '/watch/:id' }], window.location.pathname)?.[0].params.id;
  return id && id !== 'sample' ? id : null;
}

const sessionNotice = (auth: AuthStatus, guestChanged = false) => ({
  stage: auth.session.stage,
  id: auth.user?.id ?? null,
  role: auth.user?.role ?? null,
  enrollment: auth.session.username,
  guestChanged,
});

type SelfRecovery = { username: string; code: string; anonymousId: string; expiresAt: number };
type SignOutConfirmation = {
  finish: () => void;
  widerChange: boolean;
  controller: AbortController;
  proof?: { csrf: string; response: Promise<AuthStatus>; confirmed?: AuthStatus };
};

async function confirmBrowserSignOut(confirmation: SignOutConfirmation, observed: AuthStatus) {
  const csrf = observed.session.csrf;
  const previous = confirmation.proof;
  if (previous?.confirmed?.session.csrf === csrf) return observed;
  if (previous?.confirmed && previous.csrf !== csrf) confirmation.proof = undefined;
  // Only an anonymous context can authorize this fallback. All refreshes share
  // the same write while it is in flight, including refreshes from peer tabs.
  const proof = (confirmation.proof ??= {
    csrf,
    response: api<AuthStatus>(
      '/api/auth/logout',
      {
        method: 'POST',
        body: JSON.stringify({ preserve_anonymous_operations: true }),
        signal: sessionDeadline(confirmation.controller.signal),
      },
      csrf,
    ).then((status) => {
      if (status.session.stage !== 'anonymous' || status.user !== null || !status.session.csrf)
        throw new SessionChangedError();
      return status;
    }),
  });
  let confirmed: AuthStatus;
  try {
    confirmed = await proof.response;
  } catch (error) {
    if (confirmation.proof === proof) confirmation.proof = undefined;
    throw error;
  }
  proof.confirmed = confirmed;
  if (proof.csrf === csrf) return confirmed;
  if (confirmed.session.csrf === csrf) return observed;
  throw new SessionChangedError();
}

function previousScopeEnded(previous: AuthStatus, next: AuthStatus) {
  if (previous.user)
    return (
      previous.user.id !== next.user?.id ||
      previous.user.role !== next.user?.role ||
      (!previous.user.profile_required && !!next.user?.profile_required) ||
      (!previous.user.email_verification_required && !!next.user?.email_verification_required)
    );
  if (previous.session.stage === 'enroll')
    return previous.session.username !== (next.user?.username ?? next.session.username);
  return Boolean(
    previous.guest_session &&
    (previous.guest_session.csrf !== next.guest_session?.csrf ||
      next.session.stage !== 'anonymous') &&
    (window.location.pathname === '/' || window.location.pathname.startsWith('/watch/')),
  );
}

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
  const [workspace, setWorkspace] = useState<{
    auth: AuthStatus;
    config: Config;
    guestView: number;
    verifiedSessionVersion: number;
  } | null>(null);
  const auth = workspace?.auth;
  const config = workspace?.config;
  const [toast, setToast] = useState('');
  const [error, setError] = useState<Error | null>(null);
  const [verifying, setVerifying] = useState(() => document.visibilityState === 'hidden');
  const [selfRecovery, setSelfRecovery] = useState<SelfRecovery>();
  const selfRecoveryScope = useRef<string | undefined>(undefined);
  const faceitIdentity = auth?.user?.identities?.find(
    (identity) => identity.provider === 'faceit',
  )?.subject;
  const libraryContext = JSON.stringify([auth?.user?.id, auth?.user?.csrf, faceitIdentity]);
  const activity = useMemo(() => new MatchActivity(), [libraryContext]);
  const location = useLocation();
  const routeKey = useRef(location.key);
  const refreshing = useRef<Promise<AuthStatus> | null>(null);
  const refreshPending = useRef(false);
  const initial = useRef<Promise<AuthStatus> | null>(null);
  const generation = useRef(0);
  const guestView = useRef(0);
  const [viewerRevision, setViewerRevision] = useState(0);
  const committed = useRef<AuthStatus | null>(null);
  const adminAccess = useRef(false);
  const rejectedContext = useRef<string | null>(null);
  const retiredContext = useRef<{ csrf: string; revoked: boolean } | null>(null);
  const sessionChannel = useRef<BroadcastChannel | null>(null);
  const enrollmentView = useRef<{ key: string; username: string | null } | null>(null);
  const logoutPending = useRef<Promise<void> | null>(null);
  const logoutWrite = useRef<Promise<void> | null>(null);
  const logoutConfirmation = useRef<SignOutConfirmation | null>(null);
  const mustVerify = useRef(verifying);
  const suspended = useRef(verifying);
  const recoveryHandoff = useRef<{
    code: string;
    anonymousId: string | null;
    timer: number;
  } | null>(null);
  const clearHandoff = useCallback(() => {
    window.clearTimeout(recoveryHandoff.current?.timer);
    recoveryHandoff.current = null;
  }, []);
  const saveSelfRecovery = useCallback((receipt?: SelfRecovery) => {
    selfRecoveryScope.current = receipt?.anonymousId;
    setSelfRecovery(receipt);
  }, []);
  const captureSessionVersion = useCallback(
    (csrf: string) =>
      committed.current?.session.csrf === csrf && retiredContext.current?.csrf !== csrf
        ? generation.current
        : undefined,
    [],
  );
  const isAdminAvailable = useCallback(
    (userId: string | undefined, csrf?: string) =>
      Boolean(
        userId &&
        committed.current?.user?.id === userId &&
        adminAccess.current &&
        (csrf === undefined || (!mustVerify.current && committed.current.session.csrf === csrf)),
      ),
    [],
  );
  useLayoutEffect(() => {
    routeKey.current = location.key;
    clearHandoff();
    saveSelfRecovery();
    if (!/^\/recover\/?$/.test(location.pathname)) discardInitialRecoveryCode();
    if (!/^\/verify-email\/?$/.test(location.pathname)) discardVerificationCode();
  }, [location.key, location.pathname, clearHandoff, saveSelfRecovery]);
  useEffect(() => {
    if (!selfRecovery) return;
    const expiration = window.setTimeout(
      saveSelfRecovery,
      selfRecovery.expiresAt - performance.now(),
    );
    return () => window.clearTimeout(expiration);
  }, [selfRecovery, saveSelfRecovery]);
  useEffect(() => {
    if (auth?.session.stage === 'enroll' && location.pathname === '/account') {
      enrollmentView.current = { key: location.key, username: auth.session.username };
    } else if (!auth?.user || location.key !== enrollmentView.current?.key) {
      enrollmentView.current = null;
    }
  }, [auth, location.key, location.pathname]);

  const conceal = useCallback(() => {
    mustVerify.current = true;
    setVerifying(true);
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  }, []);
  const retire = useCallback(
    (csrf: string, revoked = false) => {
      conceal();
      retiredContext.current = { csrf, revoked };
      adminAccess.current = false;
      setCsrf('', '');
      setWorkspace(null);
      setToast('');
    },
    [conceal],
  );

  const refresh = useCallback(
    (announce = true) => {
      const requested = ++generation.current;
      refreshPending.current = true;
      const latest = () => refreshing.current ?? Promise.reject(new SessionChangedError());
      const next = async (): Promise<AuthStatus> => {
        for (let attempt = 1; ; attempt++) {
          try {
            if (logoutWrite.current) await logoutWrite.current;
            if (requested !== generation.current) return latest();
            let status = await api<AuthStatus>('/api/auth/me');
            if (requested !== generation.current) return latest();
            const confirmation = logoutConfirmation.current;
            if (confirmation && status.session.stage === 'anonymous') {
              status = await confirmBrowserSignOut(confirmation, status);
              if (requested !== generation.current) return latest();
            }
            // Completing a local write still needs to notify peers when their
            // own notice started the refresh that observed its outcome.
            const signedOut = confirmation !== null && status.session.stage === 'anonymous';
            const publish = announce || signedOut;
            if (
              retiredContext.current?.revoked &&
              status.session.csrf === retiredContext.current.csrf
            )
              throw new SessionChangedError();
            const previous = committed.current;
            function endPreviousScope(observed: AuthStatus) {
              if (
                !previous ||
                previous.session.csrf === retiredContext.current?.csrf ||
                !previousScopeEnded(previous, observed)
              )
                return;
              flushSync(() => retire(previous.session.csrf, signedOut));
              if (publish) {
                const guestChanged = previous.guest_session?.csrf !== observed.guest_session?.csrf;
                sessionChannel.current?.postMessage(sessionNotice(observed, guestChanged));
              }
            }
            endPreviousScope(status);
            // A fresh proof or factor change can supersede a receipt while the
            // same member is still waiting for the matching instance configuration.
            if (previous && previous.session.csrf !== status.session.csrf) flushSync(conceal);
            if (
              selfRecoveryScope.current &&
              (status.session.stage !== 'anonymous' ||
                status.session.anonymous_id !== selfRecoveryScope.current)
            )
              flushSync(() => saveSelfRecovery());
            const handoff = recoveryHandoff.current;
            if (handoff?.anonymousId && handoff.anonymousId !== status.session.anonymous_id)
              clearHandoff();
            const settings = await api<Config>(
              '/api/config',
              { headers: { 'X-Guest-Context': status.guest_session?.csrf ?? '' } },
              status.session.csrf,
            );
            if (requested !== generation.current) return latest();
            if (!settings.guest_uploads_enabled && status.guest_session) {
              status = { ...status, guest_session: null };
              endPreviousScope(status);
            }
            const demoId =
              mustVerify.current &&
              previous &&
              !previousScopeEnded(previous, status) &&
              openDemoId();
            if (
              demoId &&
              !status.user?.profile_required &&
              !status.user?.email_verification_required &&
              (status.user || (status.session.stage === 'anonymous' && settings.public_access))
            ) {
              try {
                await api(
                  '/api/demos/' + encodeURIComponent(demoId),
                  {
                    signal: sessionDeadline(),
                    headers: { 'X-Guest-Context': status.guest_session?.csrf ?? '' },
                  },
                  status.session.csrf,
                );
              } catch (error) {
                if (requested !== generation.current) return latest();
                if (openDemoId() === demoId) {
                  if (!(error instanceof ApiError) || ![401, 403, 404].includes(error.status))
                    throw error;
                  // Drop private frames and audio before the viewer renders its access result.
                  setViewerRevision((prior) => prior + 1);
                }
              }
              if (requested !== generation.current) return latest();
            }
            const guestChanged = previous?.guest_session?.csrf !== status.guest_session?.csrf;
            const endedScope =
              previous &&
              previousScopeEnded(previous, status) &&
              previous.session.csrf === retiredContext.current?.csrf;
            const effectiveAdminAccess =
              hasPermission(status.user?.role, 'admin') && settings.admin_access;
            const adminAccessEnded = adminAccess.current && !effectiveAdminAccess;
            adminAccess.current = effectiveAdminAccess;
            committed.current = status;
            rejectedContext.current = null;
            retiredContext.current = null;
            setCsrf(
              status.session.csrf,
              status.session.stage === 'anonymous' ? (status.guest_session?.csrf ?? '') : '',
            );
            const nextWorkspace = {
              auth: status,
              guestView: guestChanged ? ++guestView.current : guestView.current,
              verifiedSessionVersion: requested,
              config: { ...settings, admin_access: effectiveAdminAccess },
            };
            if (adminAccessEnded) {
              flushSync(() => {
                setToast('');
                setWorkspace(nextWorkspace);
              });
            } else setWorkspace(nextWorkspace);
            if (!suspended.current) {
              mustVerify.current = false;
              setVerifying(false);
            }
            setError(null);
            if (previous?.user?.id !== status.user?.id) setToast('');
            if (confirmation) {
              logoutConfirmation.current = null;
              if (signedOut) {
                confirmation.finish();
                if (confirmation.widerChange)
                  setToast(
                    'Signed out of this browser. The requested change could not be confirmed.',
                  );
              } else {
                confirmation.controller.abort();
                logoutPending.current = null;
              }
            }
            if (
              publish &&
              !endedScope &&
              (previous
                ? previous.session.csrf !== status.session.csrf ||
                  previous.user?.role !== status.user?.role ||
                  guestChanged
                : status.session.stage !== 'anonymous' || guestChanged)
            )
              sessionChannel.current?.postMessage(sessionNotice(status, guestChanged));
            return status;
          } catch (error) {
            if (requested !== generation.current) return latest();
            if (error instanceof SessionChangedError && attempt < 3) {
              flushSync(conceal);
              continue;
            }
            if (mustVerify.current || error instanceof SessionChangedError) {
              conceal();
              setError(error as Error);
            }
            throw error;
          }
        }
      };
      // A newer observation always owns the identity and the matching configuration.
      refreshing.current = next().finally(() => {
        if (requested === generation.current) refreshPending.current = false;
      });
      return refreshing.current;
    },
    [clearHandoff, conceal, retire, saveSelfRecovery],
  );

  function signOut({
    returnTo,
    sessionContext,
    recoveryCode,
    request = { path: '/api/auth/logout', options: { method: 'POST' } },
    selfRecoveryName,
  }: SignOutOptions = {}) {
    if (logoutPending.current) return logoutPending.current;
    const current = committed.current;
    const previous = current?.session;
    if (
      !auth ||
      logoutConfirmation.current ||
      !previous ||
      previous.stage === 'anonymous' ||
      previous.csrf === retiredContext.current?.csrf ||
      current.user?.id !== auth.user?.id ||
      (sessionContext !== undefined && sessionContext !== previous.csrf) ||
      (auth.session.stage !== 'full' && previous.csrf !== auth.session.csrf)
    )
      return Promise.reject(new SessionChangedError());
    const origin = location.key;
    clearHandoff();
    if (recoveryCode && location.pathname.replace(/\/$/, '') === '/recover') {
      recoveryHandoff.current = {
        code: recoveryCode,
        anonymousId: null,
        timer: window.setTimeout(clearHandoff, 60_000),
      };
    }
    function finishSignOut() {
      if (returnTo && routeKey.current === origin)
        navigate(authPath('login', returnTo), { replace: true });
    }
    const explicitLogout = request.path === '/api/auth/logout';
    let confirmed = false;
    let failure: unknown;
    let refusal: Error | undefined;
    const perform = async () => {
      let accepted = false;
      let result:
        | (Partial<AuthStatus> & {
            ok?: true;
            recovery_code?: string;
            recovery_expires_in_ms?: number;
          })
        | undefined;
      const startedAt = performance.now();
      const accept = () => {
        accepted = true;
        flushSync(() => retire(previous.csrf, !request.reconcileSessionOnly));
        sessionChannel.current?.postMessage({
          stage: 'anonymous',
          id: null,
          role: null,
          enrollment: null,
        });
        finishSignOut();
      };
      try {
        result = await api(
          request.path,
          { ...request.options, signal: sessionDeadline(request.options.signal) },
          previous.csrf,
          request.requireAnonymousStatus ? undefined : accept,
        );
        if (request.requireAnonymousStatus && result?.session?.stage === 'anonymous') accept();
      } catch (error) {
        failure = error;
        if (
          !explicitLogout &&
          (error instanceof SessionChangedError ||
            error instanceof BrowserStorageError ||
            (error instanceof ApiError &&
              error.status >= 400 &&
              error.status < 500 &&
              error.status !== 408))
        )
          refusal = error;
      }
      if (accepted) {
        const returned = result?.session;
        if (recoveryHandoff.current && returned?.stage === 'anonymous' && returned.anonymous_id)
          recoveryHandoff.current.anonymousId = returned.anonymous_id;
        else clearHandoff();
        const expiresAt = recoveryReceiptDeadline(startedAt, result?.recovery_expires_in_ms);
        if (
          expiresAt > performance.now() &&
          selfRecoveryName &&
          result?.user === null &&
          result.recovery_code &&
          returned?.stage === 'anonymous' &&
          returned.anonymous_id &&
          routeKey.current === origin
        )
          saveSelfRecovery({
            username: selfRecoveryName,
            code: result.recovery_code,
            anonymousId: returned.anonymous_id,
            expiresAt,
          });
        return;
      }
      clearHandoff();
      // A session row viewed before a rotation can now refer to another device.
      if (result?.ok === true) return;
      // A policy write retires only server-selected grants. Reading the session is
      // enough even when delivery is uncertain. A refused action cannot authorize
      // a separate browser-wide sign-out either.
      if (request.reconcileSessionOnly || refusal) return;
      failure ??= new SessionChangedError();
      logoutConfirmation.current = {
        widerChange: !explicitLogout,
        controller: new AbortController(),
        finish() {
          confirmed = true;
          finishSignOut();
        },
      };
    };
    conceal();
    // Refreshes wait only for the write outcome. Verification never waits on
    // the whole sign-out action, which itself needs the latest refresh.
    logoutWrite.current = perform().finally(() => {
      logoutWrite.current = null;
    });
    const pending = refresh()
      .then(
        () => {
          if (failure && (!confirmed || !explicitLogout)) throw failure;
        },
        (error: unknown) => {
          throw refusal ?? error;
        },
      )
      .finally(() => {
        if (logoutPending.current === pending) logoutPending.current = null;
      });
    logoutPending.current = pending;
    return pending;
  }
  useEffect(() => {
    let active = true;
    initial.current ??= refresh();
    initial.current.catch((error: Error) => {
      if (active) setError(error);
    });
    return () => {
      active = false;
    };
  }, [refresh]);
  useEffect(() => {
    let channel: BroadcastChannel | undefined;
    try {
      channel = new BroadcastChannel('cswatch-session');
      sessionChannel.current = channel;
    } catch {
      // Focus and history restoration still revalidate in browsers without a channel.
    }
    let timer: number | undefined;
    function revalidate(publish: boolean) {
      window.clearTimeout(timer);
      timer = undefined;
      return refresh(publish).catch(() => {});
    }
    function privateContextOnScreen() {
      return (
        committed.current?.session.stage !== 'anonymous' ||
        Boolean(committed.current.guest_session || selfRecoveryScope.current) ||
        matchRoutes(accountForms, window.location.pathname) !== null ||
        Boolean(openDemoId())
      );
    }
    function scheduleRefresh() {
      if (!committed.current || timer !== undefined) return;
      timer = window.setTimeout(() => {
        timer = undefined;
        const requireContext = privateContextOnScreen();
        if (
          logoutPending.current ||
          (refreshPending.current && (!requireContext || mustVerify.current))
        )
          return;
        if (requireContext) flushSync(conceal);
        void revalidate(true);
      }, 0);
    }
    const resume = () => {
      if (document.visibilityState === 'visible') scheduleRefresh();
    };
    let resumed: Promise<AuthStatus | void> | undefined;
    const suspend = () => {
      suspended.current = true;
      resumed = undefined;
      if (committed.current) flushSync(conceal);
    };
    const revalidateRestored = () => {
      suspended.current = false;
      if (resumed) return;
      flushSync(conceal);
      const check = revalidate(true);
      resumed = check;
      void check.then(() => {
        if (resumed === check) resumed = undefined;
      });
    };
    const visibility = () => {
      if (document.visibilityState === 'hidden') suspend();
      else if (suspended.current) revalidateRestored();
    };
    const pageHide = (event: PageTransitionEvent) => {
      if (event.persisted) suspend();
      else clearHandoff();
    };
    const restore = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      revalidateRestored();
    };
    const fromAnotherTab = (event: MessageEvent) => {
      const previous = committed.current;
      if (!previous) return;
      const change = event.data;
      if (!['anonymous', 'challenge', 'enroll', 'full'].includes(change?.stage)) return;
      const different =
        change?.id !== (previous.user?.id ?? null) ||
        (change.role !== undefined && change.role !== (previous.user?.role ?? null)) ||
        (change.guestChanged === true && Boolean(previous.guest_session)) ||
        change?.stage !== previous.session.stage ||
        change?.enrollment !== previous.session.username;
      // A delayed peer notice can describe an earlier cookie. Only the
      // server's response can retire this tab's current context.
      if (different || privateContextOnScreen()) flushSync(conceal);
      void revalidate(false);
    };
    const stopObserving = observeAccessChanges((context, change) => {
      if (change === 'admin-network') {
        if (!adminAccess.current || committed.current?.session.csrf !== context) return;
        adminAccess.current = false;
        // Keep the view concealed until the paired status/configuration read
        // commits. A denied configuration then unmounts the admin panels.
        flushSync(() => {
          setToast('');
          conceal();
        });
        void revalidate(true);
        return;
      }
      if (rejectedContext.current === context) return;
      rejectedContext.current = context;
      conceal();
      void revalidate(true);
    });
    window.addEventListener('focus', resume);
    window.addEventListener('pagehide', pageHide);
    window.addEventListener('pageshow', restore);
    window.addEventListener('popstate', resume);
    document.addEventListener('visibilitychange', visibility);
    channel?.addEventListener('message', fromAnotherTab);
    if (suspended.current && document.visibilityState === 'visible') {
      suspended.current = false;
      void revalidate(true);
    }
    return () => {
      window.clearTimeout(timer);
      stopObserving();
      channel?.close();
      sessionChannel.current = null;
      window.removeEventListener('focus', resume);
      window.removeEventListener('pagehide', pageHide);
      window.removeEventListener('pageshow', restore);
      window.removeEventListener('popstate', resume);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [clearHandoff, conceal, refresh]);
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
  const errorHeading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    if (error) errorHeading.current?.focus({ preventScroll: true });
  }, [error]);
  const unavailable = error ? (
    <main className="fatal">
      <h1 ref={errorHeading} tabIndex={-1}>
        {t(
          error instanceof BrowserStorageError
            ? 'Browser storage unavailable'
            : 'Connection unavailable',
        )}
      </h1>
      <p role="alert">{t(error.message)}</p>
      <button
        className="button primary"
        onClick={() => {
          setError(null);
          void refresh().catch(setError);
        }}
      >
        {t('Retry')}
      </button>
    </main>
  ) : (
    <main className="fatal">
      <p>{t('Opening your review room…')}</p>
    </main>
  );
  if (!workspace || !config || !auth) return unavailable;
  const { user, session } = auth;
  const viewerIdentity = (user?.id ?? 'visitor-' + workspace?.guestView) + ':' + viewerRevision;
  const path = location.pathname.replace(/\/$/, '') || '/';
  const authRoute = ['/login', '/register'].includes(path);
  const accountRoute = path === '/library' || isAdminPage(path) || path.startsWith('/account');
  const enroll = session.stage === 'enroll';
  const recovery = path === '/recover';
  const emailVerification = path === '/verify-email';
  const emailOnboarding = user?.profile_required || user?.email_verification_required;
  const onboardingReturn =
    path === '/account' || authRoute ? new URLSearchParams(location.search).get('returnTo') : null;
  const privateGate = !user && (!config.public_access || accountRoute);
  const publicSurface = path === '/' && session.stage === 'anonymous';
  const guestPath = path + location.search + (recovery || emailVerification ? '' : location.hash);
  const appearance = { theme, toggleTheme: () => setTheme(theme === 'dark' ? 'light' : 'dark') };
  const adminDenial =
    path === '/library' && user && !config.admin_access
      ? new URLSearchParams(location.search).get('admin')
      : null;
  const workspaceView = (
    <AppContext.Provider
      value={{
        user,
        session,
        verifiedSessionVersion: workspace.verifiedSessionVersion,
        captureSessionVersion,
        config,
        refresh,
        isAdminAvailable,
        signOut,
        notify: setToast,
        signIn: () =>
          navigate(authPath('login', publicSurface ? '/library' : guestPath), {
            state: { authFrom: guestPath },
          }),
      }}
    >
      <ConfirmationProvider identity={user?.id}>
        <StepUpProvider>
          <a className="skip-link" href="#main">
            {t('Skip to content')}
          </a>
          {selfRecovery &&
          session.stage === 'anonymous' &&
          selfRecovery.anonymousId === session.anonymous_id &&
          selfRecovery.expiresAt > performance.now() ? (
            <AuthFrame {...appearance}>
              <section aria-labelledby="self-recovery-title">
                <header className="auth-intro">
                  <h1 id="self-recovery-title">
                    {t('Recovery link for {{v0}}', { v0: selfRecovery.username })}
                  </h1>
                </header>
                <RecoveryLinkDetails
                  code={selfRecovery.code}
                  canCopy={() =>
                    selfRecovery.expiresAt > performance.now() &&
                    selfRecoveryScope.current === selfRecovery.anonymousId &&
                    committed.current?.session.anonymous_id === selfRecovery.anonymousId &&
                    !mustVerify.current
                  }
                  close={() => {
                    saveSelfRecovery();
                    navigate(authPath('login', guestPath), { replace: true });
                  }}
                />
              </section>
            </AuthFrame>
          ) : config.setup_required ? (
            path === '/setup' ? (
              <Setup onComplete={refresh} />
            ) : (
              <Navigate replace to="/setup" />
            )
          ) : emailVerification ? (
            <VerifyEmail key={user?.id || session.stage} {...appearance} />
          ) : enroll &&
            !recovery &&
            path !== '/register' &&
            (path !== '/account' || !new URLSearchParams(location.search).has('returnTo')) ? (
            <Navigate
              replace
              to={
                '/account?' +
                new URLSearchParams({
                  returnTo: authReturnPath(
                    new URLSearchParams(location.search).get('returnTo') ?? guestPath,
                  ),
                })
              }
            />
          ) : session.stage === 'challenge' && !recovery && path !== '/login' ? (
            <Navigate replace to={authPath('login', guestPath)} />
          ) : path === '/setup' ? (
            <Navigate replace to={user ? '/library' : '/'} />
          ) : path === '/' && user ? (
            <Navigate replace to="/library" />
          ) : recovery ? (
            <Recover
              key={location.key + ':' + (session.anonymous_id ?? session.csrf)}
              takeHandoff={() => {
                const handoff = recoveryHandoff.current;
                if (
                  session.stage !== 'anonymous' ||
                  !handoff?.anonymousId ||
                  handoff.anonymousId !== session.anonymous_id
                )
                  return '';
                clearHandoff();
                return handoff.code;
              }}
              {...appearance}
            />
          ) : authRoute && !emailOnboarding ? (
            <AuthPage key={location.key} {...appearance} />
          ) : enroll ||
            (user &&
              path === '/account' &&
              enrollmentView.current?.key === location.key &&
              enrollmentView.current.username === user.username) ? (
            <AuthFrame key={session.username ?? user?.username} {...appearance}>
              <Account enrollment />
            </AuthFrame>
          ) : emailOnboarding && onboardingReturn ? (
            <Navigate replace to={authReturnPath(onboardingReturn)} />
          ) : emailOnboarding ? (
            <EmailOnboarding key={user?.id} {...appearance} />
          ) : privateGate ? (
            <Navigate
              replace
              to={authPath('login', guestPath)}
              state={{ authFrom: config.public_access ? '/' : guestPath }}
            />
          ) : publicSurface ? (
            <PublicShell {...appearance}>
              <Landing />
            </PublicShell>
          ) : location.pathname.startsWith('/watch/') ? (
            <div className="viewer-shell" key={viewerIdentity}>
              <main id="main" className="viewer-page">
                <Routes>
                  <Route path="/watch/:id" element={<Viewer {...appearance} />} />
                </Routes>
              </main>
            </div>
          ) : (
            <WorkspaceShell key={user?.id} {...appearance}>
              {(adminDenial === 'network' || adminDenial === 'role') && <AdminAccessNotice />}
              <Routes>
                <Route
                  path="/library"
                  element={<Library key={libraryContext} activity={activity} />}
                />
                <Route path="/account" element={<Account />} />
                <Route path="/account/sessions" element={<Account section="sessions" />} />
                <Route path="/account/connections" element={<Account section="connections" />} />
                <Route path={adminRoute.path} element={<Admin key={user?.id} />} />
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
        </StepUpProvider>
      </ConfirmationProvider>
    </AppContext.Provider>
  );
  const concealed = verifying || Boolean(error);
  return (
    <>
      {concealed && unavailable}
      <div style={{ display: concealed ? 'none' : 'contents' }} inert={concealed || undefined}>
        <WorkspaceConcealed.Provider value={concealed}>{workspaceView}</WorkspaceConcealed.Provider>
      </div>
    </>
  );
}
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Boundary>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </Boundary>
  </StrictMode>,
);
