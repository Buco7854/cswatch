import { t } from '../i18n';
import { useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { X, Trash2 } from 'lucide-react';
import type { Demo } from '../types';
import { api } from '../api';
import { useApp } from '../context';
import { useConfirm } from './Confirmation';
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
  const confirm = useConfirm();
  const headingId = useId();
  const operation = useRef({ active: true });
  useEffect(() => {
    const scope = { active: true };
    operation.current = scope;
    setName(demo.name);
    setBusy(false);
    setError('');
    const element = dialog.current;
    element?.showModal();
    return () => {
      scope.active = false;
      element?.close();
    };
  }, [demo.id]);
  async function rename() {
    const scope = operation.current;
    setBusy(true);
    setError('');
    try {
      await api('/api/demos/' + demo.id, {
        method: 'PATCH',
        body: JSON.stringify({ name: name.trim() }),
      });
      if (!scope.active) return;
      onChange({ ...demo, name: name.trim() });
      notify(t('Demo renamed.'));
      close();
    } catch (e) {
      if (scope.active) setError((e as Error).message);
    } finally {
      if (scope.active) setBusy(false);
    }
  }
  async function remove() {
    const scope = operation.current;
    if (
      !(await confirm({
        title: t('Delete demo'),
        description: t(
          'Delete “{{v0}}”? This permanently removes its demo file, playback data, and all notes.',
          { v0: demo.name },
        ),
        confirmLabel: t('Delete permanently'),
        tone: 'danger',
      })) ||
      !scope.active
    )
      return;
    setBusy(true);
    setError('');
    try {
      await api('/api/demos/' + demo.id, { method: 'DELETE' });
      if (!scope.active) return;
      notify(t('Demo deleted.'));
      nav('/library');
    } catch (e) {
      if (scope.active) setError((e as Error).message);
    } finally {
      if (scope.active) setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="options-dialog member-dialog"
      aria-labelledby={headingId}
      onCancel={close}
    >
      <div className="panel-heading">
        <h2 id={headingId}>{t('Manage demo')}</h2>
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
