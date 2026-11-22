import { t } from '../i18n';
import { useEffect, useId, useRef, useState } from 'react';
import { FileUp, LockKeyhole } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api, uploadFile } from '../api';
import { useApp } from '../context';
import './upload.css';

export default function Upload({
  compact = false,
  steamMatch,
}: {
  compact?: boolean;
  steamMatch?: string;
}) {
  const { config, user, signIn, refresh } = useApp();
  const nav = useNavigate();
  const input = useRef<HTMLInputElement>(null);
  const pending = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const hint = useId();
  const [busy, setBusy] = useState(false),
    [progress, setProgress] = useState(0),
    [error, setError] = useState(''),
    [drag, setDrag] = useState(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pending.current?.abort();
    };
  }, []);
  function chooseFile() {
    if (!busy) {
      if (user || config.guest_uploads_enabled) input.current?.click();
      else signIn();
    }
  }
  async function upload(file?: File) {
    if (!user && !config.guest_uploads_enabled) {
      signIn();
      return;
    }
    if (!file || busy || pending.current) return;
    setError('');
    if (!/\.dem(\.zst)?$/i.test(file.name)) {
      setError(
        t(
          /\.(?:bz2|gz|zip|rar|7z)$/i.test(file.name)
            ? 'Extract this download first, then choose its .dem file. You can upload .dem.zst directly.'
            : 'Choose a .dem or .dem.zst file.',
        ),
      );
      return;
    }
    if (file.size > config.max_upload_mb * 1024 ** 2) {
      setError(t('Maximum file size is {{v0}} MB.', { v0: config.max_upload_mb }));
      return;
    }
    setBusy(true);
    setProgress(0);
    const controller = new AbortController();
    pending.current = controller;
    try {
      const session = !user
        ? await api<{ csrf: string; expires_at: number }>('/api/guest/session', {
            method: 'POST',
            signal: controller.signal,
          })
        : undefined;
      if (controller.signal.aborted || !mounted.current) return;
      if (!user && (!session || typeof session.csrf !== 'string' || !session.csrf))
        throw new Error(t('Could not start a private upload. Try again.'));
      const result = await uploadFile(
        file,
        (value) => {
          if (mounted.current && !controller.signal.aborted) setProgress(value);
        },
        controller.signal,
        session?.csrf,
        steamMatch,
      );
      if (controller.signal.aborted || !mounted.current) return;
      // The guest cookie already exists. Update the app's CSRF with the current
      // session before navigation so the viewer's owner actions can use it.
      if (session) await refresh().catch(() => {});
      if (controller.signal.aborted || !mounted.current) return;
      nav('/watch/' + result.id, { state: { from: user ? '/library' : '/' } });
    } catch (e) {
      if (mounted.current && !controller.signal.aborted) setError((e as Error).message);
    } finally {
      if (pending.current === controller) pending.current = null;
      if (mounted.current && !controller.signal.aborted) {
        setBusy(false);
        if (input.current) input.current.value = '';
      }
    }
  }
  const uploadStatus =
    progress === 100 ? t('Adding to processing queue…') : t('Uploading {{v0}}%', { v0: progress });
  return (
    <section
      className="upload-panel"
      aria-labelledby={compact ? undefined : 'upload-title'}
      aria-label={compact ? t('Choose a CS2 demo') : undefined}
    >
      {!compact && <h2 id="upload-title">{t('Upload a demo')}</h2>}
      {steamMatch && <p>{t('Steam match {{v0}}', { v0: steamMatch })}</p>}
      <div
        className={'demo-drop-target' + (drag ? ' is-dragging' : '')}
        onDragOver={(event) => {
          event.preventDefault();
          if (!busy) setDrag(true);
        }}
        onDragLeave={(event) => {
          if (
            !(event.relatedTarget instanceof Node) ||
            !event.currentTarget.contains(event.relatedTarget)
          )
            setDrag(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDrag(false);
          void upload(event.dataTransfer.files[0]);
        }}
      >
        <button
          type="button"
          className="demo-file-picker"
          disabled={busy}
          aria-describedby={hint}
          onClick={chooseFile}
        >
          <span className="demo-file-action">
            <FileUp size={18} aria-hidden="true" />
            {t('Choose demo file')}
          </span>
        </button>
        {busy ? (
          <div className="demo-upload-status" id={hint}>
            <span role="status">{uploadStatus}</span>
            <progress max={100} value={progress} aria-label={t('Upload progress')} />
          </div>
        ) : (
          <p className="demo-file-hint" id={hint}>
            {t('Drop a .dem or .dem.zst file · {{size}} MB max', {
              size: config.max_upload_mb,
            })}
          </p>
        )}
      </div>
      <input
        ref={input}
        type="file"
        accept=".dem,.zst"
        hidden
        aria-label={t('Choose a CS2 demo')}
        onChange={(e) => void upload(e.target.files?.[0])}
        disabled={busy}
      />
      {error && (
        <p role="alert" className="error demo-upload-error">
          {t(error)}
        </p>
      )}
      {(!compact || busy) && (
        <p className="demo-upload-note">
          {!busy && <LockKeyhole size={15} aria-hidden="true" />}
          {t(
            busy
              ? compact
                ? 'Keep this window open.'
                : 'Closing this dialog cancels the upload.'
              : 'Private by default.',
          )}
        </p>
      )}
    </section>
  );
}
