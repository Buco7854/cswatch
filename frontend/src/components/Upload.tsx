import { t } from '../i18n';
import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, FileUp, LockKeyhole } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api, uploadFile } from '../api';
import { useApp } from '../context';
import { SelectControl } from './Controls';
import ImportGuide, { type GuidedSource } from './ImportGuide';

export default function Upload({ compact = false }: { compact?: boolean }) {
  const { config, user, signIn } = useApp();
  const nav = useNavigate();
  const input = useRef<HTMLInputElement>(null);
  const pending = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const hint = useId();
  const [source, setSource] = useState<GuidedSource>('steam');
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
      );
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
      className={'upload-panel' + (compact ? ' compact-upload' : '')}
      aria-labelledby={compact ? undefined : 'upload-title'}
      aria-label={compact ? t('Choose a CS2 demo') : undefined}
    >
      {!compact && <h2 id="upload-title">{t('Upload a demo')}</h2>}
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
            {t('.dem or .dem.zst · up to')} {config.max_upload_mb} {t('MB')}
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
      <details className="upload-help">
        <summary>
          {t('Where do I get a demo?')}
          <ChevronDown size={16} aria-hidden="true" />
        </summary>
        <div className="upload-help-content">
          <SelectControl
            label={t('Demo import source')}
            value={source}
            onValueChange={(value) => setSource(value as GuidedSource)}
            options={[
              { value: 'steam', label: t('Premier / Competitive / Wingman') },
              { value: 'faceit', label: 'FACEIT' },
              { value: 'hltv', label: 'HLTV' },
            ]}
            disabled={busy}
          />
          <ImportGuide source={source} />
        </div>
      </details>
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
