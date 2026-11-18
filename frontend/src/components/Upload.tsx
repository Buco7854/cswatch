import { t } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { UploadCloud, ArrowUpRight, Check, FileUp } from 'lucide-react';
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
  const [source, setSource] = useState<'file' | GuidedSource>('file');
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
  return (
    <section
      className={'upload-panel' + (compact ? ' compact-upload' : '')}
      aria-labelledby={compact ? undefined : 'upload-title'}
      aria-label={compact ? t('Choose a CS2 demo') : undefined}
    >
      {!compact && (
        <>
          <div className="panel-heading">
            <h2 id="upload-title">{t('Bring your own match')}</h2>
            <UploadCloud size={19} />
          </div>
          <p>{t('Premier, Competitive, FACEIT or pro matches. Start with a CS2 demo file.')}</p>
        </>
      )}
      <div className="upload-source-choice">
        <span id="upload-source-label" className={compact ? 'visually-hidden' : undefined}>
          {t(compact ? 'Source' : 'Where is your demo?')}
        </span>
        <SelectControl
          label={t('Demo import source')}
          value={source}
          onValueChange={(value) => {
            setSource(value as 'file' | GuidedSource);
            setError('');
          }}
          options={[
            { value: 'file', label: t(compact ? 'Demo file' : 'I already have a demo file') },
            { value: 'steam', label: t(compact ? 'Steam' : 'Premier / Competitive / Wingman') },
            { value: 'faceit', label: 'FACEIT' },
            { value: 'hltv', label: 'HLTV' },
          ]}
          disabled={busy}
        />
      </div>
      {source === 'file' ? (
        <>
          <button
            className={'dropzone ' + (drag ? 'dragging' : '')}
            disabled={busy}
            onClick={chooseFile}
            onDragOver={(e) => {
              e.preventDefault();
              setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDrag(false);
              void upload(e.dataTransfer.files[0]);
            }}
          >
            {busy ? (
              <Check size={compact ? 32 : 27} />
            ) : compact ? (
              <FileUp size={32} strokeWidth={1.4} aria-hidden="true" />
            ) : (
              <UploadCloud size={27} strokeWidth={1.3} />
            )}
            {(!compact || busy) && (
              <strong>
                {busy
                  ? progress === 100
                    ? t('Adding to processing queue…')
                    : t('Uploading {{v0}}%', { v0: progress })
                  : t('Drop your demo here')}
              </strong>
            )}
            <span className={compact && !busy ? 'upload-file-action' : undefined}>
              {busy
                ? t('Keep this window open.')
                : compact
                  ? t('Choose demo file')
                  : t('or choose a file')}
              {compact && !busy && <ArrowUpRight size={15} aria-hidden="true" />}
            </span>
            <small>
              {t('.dem or .dem.zst · up to')} {config.max_upload_mb} {t('MB')}
            </small>
            {busy && <progress max={100} value={progress} aria-label={t('Upload progress')} />}
          </button>
          {!compact && (
            <button
              type="button"
              className="text-button upload-find-match"
              onClick={() => setSource('steam')}
              disabled={busy}
            >
              {t('Find my Premier or Competitive demo')}
              <ArrowUpRight size={14} />
            </button>
          )}
        </>
      ) : (
        <>
          <ImportGuide source={source} chooseFile={chooseFile} disabled={busy} />
          {busy && (
            <div className="upload-guide-progress" role="status">
              <p>
                {progress === 100
                  ? t('Adding to processing queue…')
                  : t('Uploading {{v0}}%', { v0: progress })}
              </p>
              <progress max={100} value={progress} aria-label={t('Upload progress')} />
            </div>
          )}
        </>
      )}
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
        <p role="alert" className="error">
          {t(error)}
        </p>
      )}
      {!compact && (
        <div className="upload-note">
          <span className="status-dot" />
          {t(
            busy
              ? 'Closing this dialog cancels the upload.'
              : user
                ? 'Private by default. Yours to share.'
                : 'Private guest upload. Available only in this browser.',
          )}
        </div>
      )}
    </section>
  );
}
