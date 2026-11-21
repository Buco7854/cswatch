import { t, locale } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Search, RefreshCw, Lock, Globe, Upload, Play, Film, X } from 'lucide-react';
import { useApp } from '../context';
import { captureFocusReturn, focusMovedSince } from '../focus-return';
import { useDemoLibrary } from '../useDemoLibrary';
import UploadDialog from './UploadDialog';

export default function Library() {
  const { user, config } = useApp();
  const [params, setParams] = useSearchParams();
  const [uploadOpen, setUploadOpen] = useState(false);
  const [search, setSearch] = useState('');
  const addDemo = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const { demos, total, loading, error, more, load } = useDemoLibrary('mine', user?.id, search);
  function closeUpload() {
    const trigger = addDemo.current;
    const focusReturn = captureFocusReturn();
    setUploadOpen(false);
    if (params.has('upload')) {
      const next = new URLSearchParams(params);
      next.delete('upload');
      setParams(next, { replace: true });
    }
    requestAnimationFrame(() => {
      if (
        trigger?.isConnected &&
        !trigger.closest('[inert]') &&
        !document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]') &&
        !focusMovedSince(focusReturn)
      )
        trigger.focus({ preventScroll: true });
    });
  }
  useEffect(() => {
    if (user && params.get('upload') === '1') setUploadOpen(true);
  }, [user?.id, params]);
  return (
    <>
      <header className="page-heading">
        <h1 id="matches-heading">{t('Demo library')}</h1>
        <button
          ref={addDemo}
          className="button primary library-add"
          onClick={() => setUploadOpen(true)}
        >
          <Upload size={16} />
          {t('Add a demo')}
        </button>
      </header>
      <section className="library-section" aria-labelledby="matches-heading" aria-busy={loading}>
        <div className="library-controls">
          <span className="library-total">
            {t('demo_count', { count: total })}
            {more ? ' · ' + t('{{v0}} shown', { v0: demos.length }) : ''}
          </span>
          <div className="library-tools">
            <label className="search">
              <Search size={16} aria-hidden="true" />
              <input
                ref={searchInput}
                aria-label={t('Search demos')}
                placeholder={t('Search demos')}
                value={search}
                maxLength={120}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            {search && (
              <button
                className="icon-button"
                aria-label={t('Clear search')}
                title={t('Clear search')}
                onClick={() => {
                  setSearch('');
                  searchInput.current?.focus();
                }}
              >
                <X size={16} />
              </button>
            )}
            <button
              className="icon-button"
              onClick={() => void load()}
              aria-label={t('Refresh demos')}
              title={t('Refresh demos')}
              disabled={loading}
            >
              <RefreshCw size={16} className={loading ? 'spin' : ''} />
            </button>
          </div>
        </div>
        {error && (
          <div className="inline-state" role="alert">
            <p>{t(error)}</p>
            <button className="text-button" onClick={() => void load()}>
              {t('Try again')}
            </button>
          </div>
        )}
        {demos.length ? (
          <>
            <div className="demo-table">
              <div className="demo-row table-head">
                <span>{t('Match')}</span>
                <span>{t('Source')}</span>
                <span className="rounds-heading">{t('Rounds')}</span>
                <span className="added-heading">{t('Added')}</span>
                <span className="playback-heading">{t('Status')}</span>
              </div>
              {demos.map((demo) => (
                <Link
                  key={demo.id}
                  className="demo-row"
                  to={'/watch/' + demo.id}
                  state={{ from: '/library' }}
                >
                  <div className="match-name">
                    <span className="map-initial" aria-hidden="true">
                      {demo.map ? demo.map.replace('de_', '').slice(0, 2) : <Film size={17} />}
                    </span>
                    <span>
                      <strong className={demo.map ? 'match-map' : undefined}>
                        {demo.map ? demo.map.replace('de_', '') : t('Demo processing')}
                      </strong>
                      <small title={demo.name}>{demo.name}</small>
                    </span>
                  </div>
                  <div className="demo-details">
                    <span className="source">
                      {demo.source === 'faceit' ? 'FACEIT' : t('Upload')}
                      <small>
                        {demo.public ? (
                          <>
                            <Globe size={12} />
                            {t(config.public_access ? 'Public' : 'Shared')}
                          </>
                        ) : (
                          <>
                            <Lock size={12} />
                            {t('Private')}
                          </>
                        )}
                      </small>
                    </span>
                    <span className="num rounds-count">
                      <span className="desktop-round-count">{demo.rounds ?? '-'}</span>
                      <span className="mobile-round-count">
                        {demo.rounds === null ? '-' : t('round_count', { count: demo.rounds })}
                      </span>
                    </span>
                    <span className="added">
                      {new Date(demo.created_at * 1000).toLocaleDateString(locale(), {
                        month: 'short',
                        day: 'numeric',
                      })}
                    </span>
                  </div>
                  <span className={'demo-state status-' + demo.status}>
                    {demo.status === 'ready' ? (
                      <>
                        {t('Watch')}
                        <Play size={15} aria-hidden="true" />
                      </>
                    ) : (
                      t(
                        demo.status === 'failed'
                          ? 'Parse failed'
                          : demo.status === 'processing'
                            ? 'Processing…'
                            : 'In queue',
                      )
                    )}
                  </span>
                </Link>
              ))}
            </div>
            {more && (
              <button
                className="button load-more"
                disabled={loading}
                onClick={() => void load(true)}
              >
                {t(loading ? 'Loading matches…' : 'Load more demos')}
              </button>
            )}
          </>
        ) : (
          !error && (
            <div className="library-empty">
              <div>
                <h2>
                  {t(
                    loading ? 'Loading matches…' : search ? 'No matching demos.' : 'No demos yet.',
                  )}
                </h2>
                {!loading && (
                  <p>
                    {t(
                      search
                        ? 'Try a different map or match name.'
                        : 'Choose a .dem or .dem.zst file to add your first recording.',
                    )}
                  </p>
                )}
              </div>
            </div>
          )
        )}
        <div className="library-meta">
          <span>
            {config.retention_days > 0
              ? t('retention_count', { count: config.retention_days })
              : t('Demos retained until deleted')}{' '}
            {t('· CS2 only')}
          </span>
        </div>
      </section>
      {uploadOpen && <UploadDialog close={closeUpload} />}
    </>
  );
}
