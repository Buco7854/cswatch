import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router-dom';
import { currentFocus, focusReturn } from '../focus-restore';
import { useWorkspaceConcealed, useWorkspaceDialog } from '../context';
import { t } from '../i18n';
import './confirmation.css';

type Confirmation = {
  title: string;
  description: string;
  confirmLabel: string;
  tone?: 'normal' | 'danger';
};
type Pending = Confirmation & {
  resolve: (confirmed: boolean) => void;
  restoreFocus: () => void;
  viewerUI: boolean;
};
const ConfirmationContext = createContext<(request: Confirmation) => Promise<boolean>>(() =>
  Promise.resolve(false),
);
export const useConfirm = () => useContext(ConfirmationContext);

function ConfirmDialog({
  request,
  finish,
}: {
  request: Pending;
  finish: (result: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useWorkspaceDialog(dialog, true, cancel);
  useEffect(() => request.restoreFocus, [request]);
  return createPortal(
    <dialog
      ref={dialog}
      className="confirmation-dialog"
      data-viewer-ui={request.viewerUI || undefined}
      aria-labelledby="confirmation-title"
      aria-describedby="confirmation-description"
      onCancel={(event) => {
        event.preventDefault();
        finish(false);
      }}
    >
      <h2 id="confirmation-title">{request.title}</h2>
      <p id="confirmation-description">{request.description}</p>
      <div className="confirmation-actions">
        <button ref={cancel} type="button" className="button" onClick={() => finish(false)}>
          {t('Cancel')}
        </button>
        <button
          type="button"
          className={'button ' + (request.tone === 'danger' ? 'confirmation-danger' : 'primary')}
          onClick={() => finish(true)}
        >
          {request.confirmLabel}
        </button>
      </div>
    </dialog>,
    document.fullscreenElement || document.body,
  );
}

/** One promise owns one modal. Navigation and provider teardown cancel it. */
export function ConfirmationProvider({
  children,
  identity,
}: {
  children: ReactNode;
  identity?: string;
}) {
  const [request, setRequest] = useState<Pending | null>(null);
  const pending = useRef<Pending | null>(null);
  const location = useLocation();
  const concealed = useWorkspaceConcealed();
  const finish = useCallback((value: boolean) => {
    const current = pending.current;
    pending.current = null;
    setRequest(null);
    current?.resolve(value);
  }, []);
  useEffect(() => {
    finish(false);
  }, [
    location.key,
    location.pathname,
    location.search,
    location.hash,
    identity,
    concealed,
    finish,
  ]);
  useEffect(
    () => () => {
      pending.current?.resolve(false);
      pending.current = null;
    },
    [],
  );
  const confirm = useCallback(
    (options: Confirmation) =>
      new Promise<boolean>((resolve) => {
        if (concealed || pending.current) {
          resolve(false);
          return;
        }
        const trigger = currentFocus();
        // Capture the initiating context before another modal or navigation can
        // change focus. Touch browsers may focus the native dialog instead of
        // the tapped button, so retain that dialog's viewer ancestry as well.
        const viewerUI = Boolean(
          trigger?.closest('.viewer-shell,.viewer-frame,[data-viewer-ui]') ||
          document.querySelector('dialog[open]')?.closest('.viewer-shell,.viewer-frame'),
        );
        const value = {
          ...options,
          resolve,
          restoreFocus: focusReturn(trigger),
          viewerUI,
        };
        pending.current = value;
        setRequest(value);
      }),
    [concealed],
  );
  return (
    <ConfirmationContext.Provider value={confirm}>
      {children}
      {!concealed && request && <ConfirmDialog request={request} finish={finish} />}
    </ConfirmationContext.Provider>
  );
}
