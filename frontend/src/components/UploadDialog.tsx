import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { t } from '../i18n';
import DemoConnectionsLink from './DemoConnectionsLink';
import Upload from './Upload';
export default function UploadDialog({
  close,
  steamMatch,
}: {
  close: () => void;
  steamMatch?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
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
      <Upload steamMatch={steamMatch} />
      <DemoConnectionsLink />
    </dialog>
  );
}
