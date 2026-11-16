import { t } from '../i18n';
import { useRef, useState } from 'react';
import { UploadCloud, ArrowUpRight, Check } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { uploadFile } from '../api';
import { useApp } from '../context';

export default function Upload() {
  const { config, user, signIn } = useApp();
  const nav = useNavigate();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false),
    [progress, setProgress] = useState(0),
    [error, setError] = useState(''),
    [drag, setDrag] = useState(false);
  async function upload(file?: File) {
    if (!user) {
      signIn();
      return;
    }
    if (!file || busy) return;
    setError('');
    if (!/\.dem(\.zst)?$/i.test(file.name)) {
      setError(t('Choose a .dem or .dem.zst file.'));
      return;
    }
    if (file.size > config.max_upload_mb * 1024 ** 2) {
      setError(t('Maximum file size is {{v0}} MB.', { v0: config.max_upload_mb }));
      return;
    }
    setBusy(true);
    setProgress(0);
    try {
      const result = await uploadFile(file, setProgress);
      nav('/watch/' + result.id, { state: { from: '/library' } });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }
  return (
    <section className="upload-panel" aria-labelledby="upload-title">
      <div className="panel-heading">
        <h2 id="upload-title">{t('Bring your own match')}</h2>
        <UploadCloud size={19} />
      </div>
      <p>{t('The next good round starts with a second look.')}</p>
      <button
        className={'dropzone ' + (drag ? 'dragging' : '')}
        disabled={busy}
        onClick={() => (user ? input.current?.click() : signIn())}
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
        {busy ? <Check size={27} /> : <UploadCloud size={27} strokeWidth={1.3} />}
        <strong>
          {busy
            ? progress === 100
              ? t('Adding to processing queue…')
              : t('Uploading {{v0}}%', { v0: progress })
            : t('Drop your demo here')}
        </strong>
        <span>{busy ? t('Keep this window open.') : t('or choose a file')}</span>
        <small>
          {t('.dem or .dem.zst · up to')} {config.max_upload_mb} {t('MB')}
        </small>
        {busy && <progress max={100} value={progress} aria-label={t('Upload progress')} />}
      </button>
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
      <div className="upload-note">
        <span className="status-dot" />
        {t('Private by default. Yours to share.')}
      </div>
      <button className="connection-shortcut" onClick={() => nav('/connections')}>
        <span>
          {t('Import from your accounts')}
          <small>{t('Steam & FACEIT connections')}</small>
        </span>
        <ArrowUpRight size={20} />
      </button>
    </section>
  );
}
