import { useState } from 'react';
import { Check, RotateCcw, Route, BookmarkPlus } from 'lucide-react';
import { sample } from '../sample';
import { t } from '../i18n';
export function UtilityProof() {
  const [show, setShow] = useState(true),
    [tick, setTick] = useState(360);
  const points = sample.grenades![0].points.filter((p) => p.tick <= tick),
    last = points.at(-1);
  return (
    <div className="utility-proof" data-ui>
      <div className="proof-toolbar">
        <span>{t('Recorded trajectory')}</span>
        <button aria-pressed={show} onClick={() => setShow(!show)}>
          <Route size={15} />
          {t(show ? 'Path on' : 'Path off')}
        </button>
      </div>
      <svg viewBox="0 0 340 190" role="img" aria-label={t('Recorded practice grenade trajectory')}>
        <path
          d="M15 36h95v110H15zM255 18h66v150h-66zM132 16h98v35h-98z"
          fill="var(--preview-block)"
        />
        <path d="M115 60h132v104H115z" fill="var(--preview-floor)" />
        {show && (
          <path
            d={points
              .map((p, i) => (i ? 'L' : 'M') + (120 + p.x * 0.22) + ' ' + (150 - p.z * 0.35))
              .join(' ')}
            stroke="var(--signal)"
            strokeWidth="2"
            fill="none"
          />
        )}
        {last && (
          <circle cx={120 + last.x * 0.22} cy={150 - last.z * 0.35} r="5" fill="var(--signal)" />
        )}
        <circle
          cx="203"
          cy="151"
          r="12"
          fill="none"
          stroke="var(--preview-guide)"
          strokeWidth="1"
        />
      </svg>
      <div className="proof-scrub">
        <span>{t('Throw')}</span>
        <input
          type="range"
          aria-label={t('Practice grenade timeline')}
          min={256}
          max={448}
          step={4}
          value={tick}
          onChange={(e) => setTick(Number(e.target.value))}
        />
        <span>{t('Landing')}</span>
      </div>
    </div>
  );
}
export function NoteProof() {
  const [draft, setDraft] = useState(''),
    [note, setNote] = useState('');
  return (
    <div className="note-proof" data-ui>
      <div className="proof-toolbar">
        <span>
          <BookmarkPlus size={15} />
          {t('Practice note')} · 0:09
        </span>
        <span>{t('Only for this visit')}</span>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setNote(draft.trim());
        }}
      >
        <label>
          {t('What would you review?')}
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={100}
            required
            placeholder={t('Try writing a note for this moment')}
          />
        </label>
        <button className="button" disabled={!draft.trim()}>
          <Check size={15} />
          {t('Try a note')}
        </button>
      </form>
      <div className="proof-note-result" role="status">
        {note ? (
          <>
            <span>0:09</span>
            <strong>{note}</strong>
            <button
              className="icon-button"
              aria-label={t('Clear practice note')}
              onClick={() => {
                setNote('');
                setDraft('');
              }}
            >
              <RotateCcw size={14} />
            </button>
          </>
        ) : (
          <p>{t('Practice here. Sign in to keep notes on your own matches.')}</p>
        )}
      </div>
    </div>
  );
}
