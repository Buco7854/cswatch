import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { t } from '../i18n';
import Upload from './Upload';
export default function UploadDialog({ close }: { close: () => void }) {
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
      <button className="icon-button dialog-close" aria-label={t('Close upload')} onClick={close}>
        <X size={20} />
      </button>
      <Upload />
    </dialog>
  );
}
