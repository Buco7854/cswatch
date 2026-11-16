import { t, locale } from '../i18n';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowRight, ArrowUpRight, Search, Play, RefreshCw, Lock, Globe } from 'lucide-react';
import { useApp } from '../context';
import { useDemoLibrary } from '../useDemoLibrary';
import UploadDialog from './UploadDialog';
export default function Library({ publicOnly = false }: { publicOnly?: boolean }) {
  const { user, config } = useApp();
  const [params, setParams] = useSearchParams();
  const [uploadOpen, setUploadOpen] = useState(false);
  function closeUpload() {
    setUploadOpen(false);
    if (params.has('upload')) {
      const next = new URLSearchParams(params);
      next.delete('upload');
      setParams(next, { replace: true });
    }
  }
  const [search, setSearch] = useState('');
  const effectiveScope = publicOnly ? 'public' : 'mine';
  const { demos, total, loading, error, more, load } = useDemoLibrary(
    effectiveScope,
    user?.id,
    search,
  );
  useEffect(() => {
    if (user && !publicOnly && params.get('upload') === '1') setUploadOpen(true);
  }, [user?.id, publicOnly, params]);
  return (
    <>
      <header className="page-heading">
        <div>
          <h1>
            {t(
              publicOnly
                ? config.public_access
                  ? 'Explore demos'
                  : 'Shared demos'
                : 'Demo library',
            )}
          </h1>
          <p>
            {t(
              publicOnly
                ? config.public_access
                  ? 'Matches shared by the community.'
                  : 'Matches shared with instance members.'
                : 'Your matches. A clearer picture.',
            )}
          </p>
        </div>
        {publicOnly ? (
          <Link className="button primary" to="/library?upload=1">
            <ArrowUpRight size={16} />
            {t('Add a demo')}
          </Link>
        ) : (
          <button className="button primary" onClick={() => setUploadOpen(true)}>
            <ArrowUpRight size={16} />
            {t('Add a demo')}
          </button>
        )}
      </header>
      <div className="library-workspace">
        <div className="library-primary">
          <section
            className="library-section"
            aria-labelledby="matches-heading"
            aria-busy={loading}
          >
            <div className="section-heading">
              <nav className="tabs" aria-label={t('Demo source')}>
                <Link id="matches-heading" className={!publicOnly ? 'active' : ''} to="/library">
                  {t('Your demos')}
                </Link>
                <Link className={publicOnly ? 'active' : ''} to="/explore">
                  {t(config.public_access ? 'Community' : 'Shared demos')}
                </Link>
              </nav>
              <div className="library-tools">
                <label className="search">
                  <Search size={16} />
                  <input
                    aria-label={t('Search demos')}
                    placeholder={t('Search demos or maps')}
                    value={search}
                    maxLength={120}
                    onChange={(e) => setSearch(e.target.value)}
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
                  {demos.map((d) => (
                    <Link
                      key={d.id}
                      className="demo-row"
                      to={'/watch/' + d.id}
                      state={{ from: publicOnly ? '/explore' : '/library' }}
                    >
                      <div className="match-name">
                        <span className="map-initial">
                          {(d.map || 'D').replace('de_', '').slice(0, 2)}
                        </span>
                        <span>
                          <strong>{d.map ? d.map.replace('de_', '') : t('Demo processing')}</strong>
                          <small title={d.name}>{d.name}</small>
                        </span>
                      </div>
                      <span className="source">
                        {d.source === 'faceit'
                          ? 'FACEIT'
                          : d.source === 'hltv'
                            ? 'HLTV'
                            : t('Upload')}
                        <small>
                          {d.public ? (
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
                        <span className="desktop-round-count">{d.rounds ?? '—'}</span>
                        <span className="mobile-round-count">
                          {d.rounds === null ? '—' : t('round_count', { count: d.rounds })}
                        </span>
                      </span>
                      <span className="added">
                        {new Date(d.created_at * 1000).toLocaleDateString(locale(), {
                          month: 'short',
                          day: 'numeric',
                        })}
                      </span>
                      <span className={'demo-state status-' + d.status}>
                        {d.status === 'ready' ? (
                          <>
                            {t('Watch')}
                            <ArrowUpRight size={16} />
                          </>
                        ) : d.status === 'failed' ? (
                          t('Parse failed')
                        ) : d.status === 'processing' ? (
                          t('Processing…')
                        ) : (
                          t('In queue')
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
                    {loading ? t('Loading matches…') : t('Load more demos')}
                  </button>
                )}
              </>
            ) : (
              !error && (
                <div className="library-empty">
                  <div>
                    <h2>
                      {loading
                        ? t('Loading matches…')
                        : search
                          ? t('No matching demos.')
                          : effectiveScope === 'mine'
                            ? t('Your matches belong here.')
                            : t('The next match could be yours.')}
                    </h2>
                    <p>
                      {search
                        ? t('Try a different map or match name.')
                        : effectiveScope === 'mine'
                          ? t('Upload a demo above, or connect an account to start reviewing.')
                          : t(
                              config.public_access
                                ? 'No public demos yet. Explore the sample or add your own match.'
                                : 'No shared demos yet. Explore the sample or add your own match.',
                            )}
                    </p>
                  </div>
                  <Link
                    className="button"
                    to="/watch/sample"
                    state={{ from: publicOnly ? '/explore' : '/library' }}
                  >
                    {t('Take a look around')}
                    <ArrowRight size={17} />
                  </Link>
                </div>
              )
            )}
            <div className="library-meta">
              <span>
                {t(
                  publicOnly
                    ? config.public_access
                      ? 'community_demo_count'
                      : 'shared_demo_count'
                    : 'demo_count',
                  { count: total },
                )}
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
          <div className="practice-entry">
            <Play size={17} />
            <div>
              <Link to="/watch/sample" state={{ from: publicOnly ? '/explore' : '/library' }}>
                {t('Explore sample')}
                <ArrowUpRight size={14} />
              </Link>
              <small>{t('Original scene · synthetic match data')}</small>
            </div>
          </div>
        </div>
      </div>
      {uploadOpen && <UploadDialog close={closeUpload} />}
    </>
  );
}
