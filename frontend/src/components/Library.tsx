import { t, locale } from '../i18n';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowUpRight, Search, RefreshCw, Lock, Globe } from 'lucide-react';
import { useApp } from '../context';
import { useDemoLibrary } from '../useDemoLibrary';
import UploadDialog from './UploadDialog';

export default function Library() {
  const { user, config } = useApp();
  const [params, setParams] = useSearchParams();
  const [uploadOpen, setUploadOpen] = useState(false);
  const [search, setSearch] = useState('');
  const { demos, total, loading, error, more, load } = useDemoLibrary('mine', user?.id, search);
  function closeUpload() {
    setUploadOpen(false);
    if (params.has('upload')) {
      const next = new URLSearchParams(params);
      next.delete('upload');
      setParams(next, { replace: true });
    }
  }
  useEffect(() => {
    if (user && params.get('upload') === '1') setUploadOpen(true);
  }, [user?.id, params]);
  return (
    <>
      <header className="page-heading">
        <div>
          <h1>{t('Demo library')}</h1>
          <p>{t('Your matches. A clearer picture.')}</p>
        </div>
        <button className="button primary" onClick={() => setUploadOpen(true)}>
          <ArrowUpRight size={16} />
          {t('Add a demo')}
        </button>
      </header>
      <div className="library-workspace">
        <div className="library-primary">
          <section
            className="library-section"
            aria-labelledby="matches-heading"
            aria-busy={loading}
          >
            <div className="section-heading">
              <h2 id="matches-heading">{t('Your demos')}</h2>
              <div className="library-tools">
                <label className="search">
                  <Search size={16} aria-hidden="true" />
                  <input
                    aria-label={t('Search demos')}
                    placeholder={t('Search demos')}
                    value={search}
                    maxLength={120}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </label>
                <button
                  className="icon-button"
                  onClick={() => void load()}
                  aria-label={t('Refresh demos')}
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
                    <span>{t('Rounds')}</span>
                    <span>{t('Added')}</span>
                    <span>{t('Playback')}</span>
                  </div>
                  {demos.map((demo) => (
                    <Link
                      key={demo.id}
                      className="demo-row"
                      to={'/watch/' + demo.id}
                      state={{ from: '/library' }}
                    >
                      <div className="match-name">
                        <span className="map-initial">
                          {(demo.map || 'D').replace('de_', '').slice(0, 2)}
                        </span>
                        <span>
                          <strong>
                            {demo.map ? demo.map.replace('de_', '') : t('Demo processing')}
                          </strong>
                          <small title={demo.name}>{demo.name}</small>
                        </span>
                      </div>
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
                      <span className={'demo-state status-' + demo.status}>
                        {demo.status === 'ready' ? (
                          <>
                            {t('Watch')}
                            <ArrowUpRight size={16} />
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
                        loading
                          ? 'Loading matches…'
                          : search
                            ? 'No matching demos.'
                            : 'Your matches belong here.',
                      )}
                    </h2>
                    <p>
                      {t(
                        search
                          ? 'Try a different map or match name.'
                          : 'Upload a demo above, or connect an account to start reviewing.',
                      )}
                    </p>
                  </div>
                  {!loading && !search && (
                    <button className="button" onClick={() => setUploadOpen(true)}>
                      {t('Upload a demo')}
                      <ArrowUpRight size={17} />
                    </button>
                  )}
                </div>
              )
            )}
            <div className="library-meta">
              <span>
                {t('demo_count', { count: total })}
                {more ? ' · ' + t('{{v0}} shown', { v0: demos.length }) : ''}
              </span>
              <span>
                {config.retention_days > 0
                  ? t('retention_count', { count: config.retention_days })
                  : t('Demos retained until deleted')}{' '}
                {t('· CS2 only')}
              </span>
            </div>
          </section>
        </div>
      </div>
      {uploadOpen && <UploadDialog close={closeUpload} />}
    </>
  );
}
