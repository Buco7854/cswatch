import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useLocation } from 'react-router-dom';
import { useApp, useWorkspaceDialog } from '../context';
import { authReturnPath } from '../auth-navigation';
import { currentFocus, focusReturn } from '../focus-restore';
import { t } from '../i18n';
import type { AuthSession } from '../types';
import ProofForm from './ProofForm';

type StepUpAction =
  | 'passkeys'
  | 'authenticator'
  | 'password'
  | 'email'
  | 'recovery-codes'
  | 'sessions'
  | 'steam'
  | 'faceit'
  | 'instance-settings'
  | 'asset-retry'
  | 'maps'
  | 'user-action'
  | 'mfa-policy';
const StepUpContext = createContext<{
  verify: (action: StepUpAction, expectedContext: string) => Promise<string | false>;
  noticeDismissed: boolean;
}>({ verify: async () => false, noticeDismissed: false });
export const useStepUp = (action: StepUpAction) => {
  const { verify } = useContext(StepUpContext);
  const { session } = useApp();
  return () => verify(action, session.csrf);
};

export function SteamStepUpNotice({ action }: { action: StepUpAction }) {
  const { search } = useLocation();
  const { noticeDismissed } = useContext(StepUpContext);
  const query = new URLSearchParams(search);
  if (noticeDismissed || query.get('proofFor') !== action) return null;
  const result = query.get('steam');
  if (result !== 'verification-cancelled' && result !== 'verification-failed') return null;
  return (
    <p className="error" role="alert">
      {t(
        result === 'verification-cancelled'
          ? 'Steam identity verification was cancelled. Try the action again.'
          : 'Steam could not verify your identity. Try the action again.',
      )}
    </p>
  );
}

type Prompt = {
  factors: AuthSession['factors'];
  csrf: string;
  restoreFocus: () => void;
  action: StepUpAction;
  resolve: (result: string | false) => void;
  reject: (error: Error) => void;
};

function StepUpDialog({
  prompt,
  finish,
  returnTo,
}: {
  prompt: Prompt;
  finish: (result: string | false | Error) => void;
  returnTo: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  useWorkspaceDialog(dialog, true, title);
  useEffect(() => prompt.restoreFocus, [prompt]);
  return (
    <dialog
      ref={dialog}
      className="confirmation-dialog security-dialog"
      aria-labelledby="step-up-title"
      aria-describedby="step-up-description"
      onCancel={(event) => {
        event.preventDefault();
        finish(false);
      }}
    >
      <h2 id="step-up-title" ref={title} tabIndex={-1}>
        {t('Confirm your identity')}
      </h2>
      <p id="step-up-description">{t('Verify that it’s you before making this change.')}</p>
      <ProofForm
        mode="step-up"
        factors={prompt.factors}
        sessionContext={prompt.csrf}
        returnTo={returnTo}
        onVerified={finish}
        onUnverified={() =>
          finish(new Error('Identity verification did not finish. Start the action again.'))
        }
        onCancel={() => finish(false)}
      />
    </dialog>
  );
}

export function StepUpProvider({
  children,
  allowed = () => true,
}: {
  children: ReactNode;
  allowed?: () => boolean;
}) {
  const { user, refresh } = useApp();
  const { pathname, search, key } = useLocation();
  const scope = useRef({ active: true });
  const pending = useRef<Prompt | null>(null);
  const checking = useRef(false);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [dismissed, setDismissed] = useState<string>();

  useLayoutEffect(() => {
    const current = { active: true };
    scope.current = current;
    setPrompt(null);
    return () => {
      current.active = false;
      pending.current?.resolve(false);
      pending.current = null;
    };
  }, [key, user?.id]);

  function finish(current: Prompt, result: string | false | Error) {
    if (pending.current !== current) return;
    pending.current = null;
    setPrompt(null);
    if (!allowed()) current.resolve(false);
    else if (result instanceof Error) current.reject(result);
    else current.resolve(result);
  }

  async function requireStepUp(
    action: StepUpAction,
    expectedContext: string,
  ): Promise<string | false> {
    if (!user || !allowed() || checking.current || pending.current) return false;
    if (new URLSearchParams(search).get('proofFor') === action) setDismissed(key);
    const current = scope.current;
    const restoreFocus = focusReturn(currentFocus());
    checking.current = true;
    try {
      const status = await refresh();
      if (!current.active || !allowed()) return false;
      if (
        status.user?.id !== user.id ||
        status.session.stage !== 'full' ||
        status.session.csrf !== expectedContext
      )
        throw new Error('Session expired. Refresh the page and try again.');
      const { factors, proof_fresh } = status.session;
      if (proof_fresh) return status.session.csrf;
      return await new Promise<string | false>((resolve, reject) => {
        const request = {
          factors,
          csrf: status.session.csrf,
          restoreFocus,
          resolve,
          reject,
          action,
        };
        pending.current = request;
        setPrompt(request);
      });
    } finally {
      checking.current = false;
    }
  }

  const returnTo = new URL(authReturnPath(pathname + search), window.location.origin);
  returnTo.searchParams.delete('steam');
  if (prompt) returnTo.searchParams.set('proofFor', prompt.action);
  return (
    <StepUpContext.Provider value={{ verify: requireStepUp, noticeDismissed: dismissed === key }}>
      {children}
      {prompt && (
        <StepUpDialog
          prompt={prompt}
          finish={(result) => finish(prompt, result)}
          returnTo={returnTo.pathname + returnTo.search}
        />
      )}
    </StepUpContext.Provider>
  );
}
