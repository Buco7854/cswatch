import { t } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { X, Trash2 } from 'lucide-react';
import type { Demo } from '../types';
import { api } from '../api';
import { useApp } from '../context';
export default function ManageDemo({
  demo,
  onChange,
  close,
}: {
  demo: Demo;
  onChange: (d: Demo) => void;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    nav = useNavigate(),
    { notify } = useApp();
  const [name, setName] = useState(demo.name),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  async function rename() {
    setBusy(true);
    setError('');
    try {
      await api('/api/demos/' + demo.id, {
        method: 'PATCH',
        body: JSON.stringify({ name: name.trim() }),
      });
      onChange({ ...demo, name: name.trim() });
      notify(t('Demo renamed.'));
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (
      !window.confirm(
        t(
          'Delete “{{v0}}”? This permanently removes its demo file, playback data, and all notes.',
          { v0: demo.name },
        ),
      )
    )
      return;
    setBusy(true);
    setError('');
    try {
      await api('/api/demos/' + demo.id, { method: 'DELETE' });
      notify(t('Demo deleted.'));
      nav('/library');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog ref={dialog} className="options-dialog member-dialog" onCancel={close}>
      <div className="panel-heading">
        <h2>{t('Manage demo')}</h2>
        <button className="icon-button" aria-label={t('Close demo management')} onClick={close}>
          <X size={20} />
        </button>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void rename();
        }}
      >
        <label>
          {t('Demo name')}
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            minLength={1}
            maxLength={120}
            required
          />
        </label>
        <button className="button primary" disabled={busy}>
          {t('Save name')}
        </button>
      </form>
      <section className="danger-zone">
        <h3>{t('Delete demo')}</h3>
        <p>
          {t(
            'Deleting removes the original file, playback data, and everyone’s notes. This cannot be undone.',
          )}
        </p>
        <button className="button" onClick={() => void remove()} disabled={busy}>
          <Trash2 size={15} />
          {t('Delete permanently')}
        </button>
      </section>
      {error && (
        <p className="error" role="alert">
          {t(error)}
        </p>
      )}
    </dialog>
  );
}
