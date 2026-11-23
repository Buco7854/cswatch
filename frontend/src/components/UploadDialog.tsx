import { useRef } from 'react';
import { X } from 'lucide-react';
import { useWorkspaceDialog } from '../context';
import { t } from '../i18n';
import DemoConnectionsLink from './DemoConnectionsLink';
import Upload, { type UploadMatch } from './Upload';
export default function UploadDialog({
  close,
  match,
  returnTo,
}: {
  close: () => void;
  match?: UploadMatch;
  returnTo?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useWorkspaceDialog(dialog);
  return (
    <dialog
      ref={dialog}
      className="options-dialog member-dialog upload-dialog"
      aria-labelledby="upload-title"
      onCancel={close}
      onClick={(e) => {
        if (e.target === dialog.current) close();
      }}
    >
      <div className="upload-dialog-closebar">
        <button className="icon-button dialog-close" aria-label={t('Close upload')} onClick={close}>
          <X size={20} />
        </button>
      </div>
      <Upload match={match} returnTo={returnTo} />
      {!match && <DemoConnectionsLink />}
    </dialog>
  );
}
