import { createContext, useContext, useLayoutEffect, useRef, type RefObject } from 'react';
import type { AuthSession, AuthStatus, Config, User } from './types';

export type SignOutOptions = {
  returnTo?: string;
  sessionContext?: string;
  recoveryCode?: string;
  request?: {
    path: string;
    options: RequestInit;
    requireAnonymousStatus?: boolean;
    reconcileSessionOnly?: boolean;
  };
  selfRecoveryName?: string;
};

export const AppContext = createContext<{
  user: User | null;
  session: AuthSession;
  verifiedSessionVersion: number;
  captureSessionVersion: (csrf: string) => number | undefined;
  config: Config;
  refresh: () => Promise<AuthStatus>;
  isAdminAvailable: (userId: string | undefined, csrf?: string) => boolean;
  signOut: (options?: SignOutOptions) => Promise<void>;
  notify: (s: string) => void;
  signIn: () => void;
}>(null!);
export const useApp = () => useContext(AppContext);

export const WorkspaceConcealed = createContext(false);
export const useWorkspaceConcealed = () => useContext(WorkspaceConcealed);

export function useWorkspaceDialog(
  dialog: RefObject<HTMLDialogElement | null>,
  open = true,
  initialFocus?: RefObject<HTMLElement | null>,
) {
  const concealed = useWorkspaceConcealed();
  const rememberedFocus = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element || !open || concealed) return;
    element.showModal();
    const remembered = rememberedFocus.current;
    (remembered?.isConnected ? remembered : initialFocus?.current)?.focus({
      preventScroll: true,
    });
    return () => {
      const active = document.activeElement;
      rememberedFocus.current =
        active instanceof HTMLElement && element.contains(active) ? active : null;
      element.close();
    };
  }, [dialog, open, concealed, initialFocus]);
}
