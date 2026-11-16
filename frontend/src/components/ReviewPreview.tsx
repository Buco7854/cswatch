import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, RotateCcw, ScanLine } from 'lucide-react';
import { sample } from '../sample';
import { frameAt } from '../playback';
import { t } from '../i18n';
/** An honest, lightweight live product fragment. No invented personal stats or fake game render. */
export default function ReviewPreview() {
  const [tick, setTick] = useState(620),
    [perspective, setPerspective] = useState<'all' | '0'>('all');
  const { frame } = frameAt(sample, tick);
  const trail = useMemo(
    () =>
      sample.frames
        .filter((f) => f.tick <= tick && f.tick > tick - 200)
        .map((f) => f.players.find((p) => p.id === '0')!)
        .map((p) => [150 + p.x * 0.17, 160 - p.y * 0.17]),
    [tick],
  );
  return (
    <div className="review-preview" data-ui>
      <div className="preview-header">
        <span>
          <span className="live-square" />
          {t('Practice review')}
        </span>
        <span>
          {t('Round')} 01 <span className="preview-separator">/</span> 03
        </span>
        <ScanLine size={16} />
      </div>
      <div className="preview-perspectives" aria-label={t('Preview perspective')}>
        <button
          className={perspective === 'all' ? 'selected' : ''}
          onClick={() => setPerspective('all')}
        >
          {t('All players')}
        </button>
        <button
          className={perspective === '0' ? 'selected' : ''}
          onClick={() => setPerspective('0')}
        >
          {t('Follow marlow')}
        </button>
      </div>
      <div className="preview-map">
        <svg
          viewBox="0 0 340 320"
          role="img"
          aria-label={t('Live position preview from the synthetic practice demo')}
        >
          <path
            fill="var(--preview-block)"
            d="M22 30h65v86H22zM250 24h64v105h-64zM95 15h135v42H95zM23 198h65v90H23zM252 186h63v106h-63zM106 272h126v30H106z"
          />
          <path
            fill="var(--preview-floor)"
            d="M92 62h148v197H92zM90 124H27v63h63zM242 137h73v37h-73z"
          />
          <path
            d="M96 165h140M170 65v194"
            stroke="var(--preview-guide)"
            strokeWidth=".7"
            strokeDasharray="3 7"
          />
          <path
            d={trail.map(([x, y], i) => (i ? 'L' : 'M') + x + ' ' + y).join(' ')}
            fill="none"
            stroke="var(--signal)"
            strokeWidth="1.5"
          />
          <rect x="185" y="112" width="18" height="22" fill="var(--preview-block)" />
          <rect x="205" y="112" width="18" height="22" fill="var(--preview-block)" />
          <circle
            cx="170"
            cy="169"
            r="30"
            fill="none"
            stroke="var(--preview-guide)"
            strokeWidth="1"
          />
          <text x="166" y="174" fontSize="13" fill="var(--preview-ink)">
            A
          </text>
          {frame.players
            .filter((p) => p.alive)
            .map((p) => (
              <g
                key={p.id}
                opacity={perspective === '0' && p.id !== '0' ? 0.3 : 1}
                transform={`translate(${150 + p.x * 0.17} ${160 - p.y * 0.17})`}
              >
                <circle r={p.id === '0' ? 5.5 : 4} fill={p.team === 3 ? '#9acbd9' : '#dfb16c'} />
                <path
                  d="M6 0h5"
                  stroke={p.team === 3 ? '#9acbd9' : '#dfb16c'}
                  strokeWidth="1.8"
                  transform={`rotate(${-p.yaw})`}
                />
                {p.id === '0' && (
                  <circle r="10" stroke="var(--signal)" strokeWidth="1" fill="none" />
                )}
              </g>
            ))}
        </svg>
        <div className="preview-player">
          <span className="player-swatch" />
          <span>
            marlow<small>M4A1 · 100 HP</small>
          </span>
          <span>{t('Selected player')}</span>
        </div>
      </div>
      <div className="preview-timeline">
        <RotateCcw size={16} />
        <input
          type="range"
          aria-label={t('Practice preview timeline')}
          min={0}
          max={1240}
          step={4}
          value={tick}
          onChange={(e) => setTick(Number(e.target.value))}
        />
        <span>0:{String(Math.floor(tick / 64)).padStart(2, '0')}</span>
      </div>
      <div className="preview-bottom">
        <span>{t('Synthetic practice data')}</span>
        <Link to="/watch/sample">
          {t('Open full viewer')}
          <ArrowUpRight size={15} />
        </Link>
      </div>
    </div>
  );
}
