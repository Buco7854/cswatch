import { t, locale } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { Search, RefreshCw, Lock, Globe, Upload, Play, Film, Trash2, X } from 'lucide-react';
import { useApp } from '../context';
import { useDeleteDemo } from '../demo-deletion';
import { captureFocusReturn, focusMovedSince, type FocusReturnContext } from '../focus-return';
import type { Demo } from '../types';
import { useDemoLibrary } from '../useDemoLibrary';
import { ProviderLogo } from './ProviderBrand';
import ProviderMatches, { type MatchSource } from './ProviderMatches';
import type { MatchActivity } from '../match-activity';
import UploadDialog from './UploadDialog';

function returnFocus(target: HTMLElement | null, context: FocusReturnContext) {
  requestAnimationFrame(() => {
    if (
      target?.isConnected &&
      !target.closest('[inert]') &&
      !document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]') &&
      !focusMovedSince(context)
    )
      target.focus({ preventScroll: true });
  });
}
export default function Library({ activity }: { activity: MatchActivity }) {
  const { user } = useApp();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const addDemo = useRef<HTMLButtonElement>(null);
  const uploadTrigger = useRef<HTMLElement | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const tabs: ('mine' | MatchSource)[] = ['mine'];
  if (user?.match_sources?.faceit) tabs.push('faceit');
  if (user?.match_sources?.steam) tabs.push('steam');
  const requested = params.get('source');
  const active =
    requested === 'faceit' && tabs.includes('faceit')
      ? 'faceit'
      : requested === 'steam' && tabs.includes('steam')
        ? 'steam'
        : 'mine';
  const unavailable = !!requested && active === 'mine';
  function selectTab(tab: typeof active) {
    if (tab === active && !unavailable) return;
    setParams(tab === 'mine' ? {} : { source: tab });
  }
  const uploadRequested = params.get('upload') === '1';
  useEffect(() => {
    if (uploadRequested) {
      const focused = document.activeElement;
      uploadTrigger.current =
        focused instanceof HTMLElement && focused.matches('a[href]') ? focused : addDemo.current;
    }
    setUploadOpen(uploadRequested);
  }, [uploadRequested, location.key]);
  const steamId = params.get('steamMatch') ?? '';
  const faceitId = params.get('faceitMatch') ?? '';
  const match =
    active === 'steam' && /^[1-9]\d{0,19}$/.test(steamId)
      ? { source: 'steam' as const, id: steamId }
      : active === 'faceit' && /^[A-Za-z0-9_-]{1,128}$/.test(faceitId)
        ? { source: 'faceit' as const, id: faceitId }
        : undefined;
  const back = new URLSearchParams(params);
  back.delete('upload');
  back.delete('steamMatch');
  back.delete('faceitMatch');
  function closeUpload() {
    const focus = captureFocusReturn();
    const trigger = uploadTrigger.current;
    setUploadOpen(false);
    if (uploadRequested) setParams(back, { replace: true, state: location.state });
    returnFocus(trigger?.isConnected ? trigger : addDemo.current, focus);
  }
  return (
    <>
      <header className="page-heading">
        <h1 id="matches-heading">{t('Demo library')}</h1>
        <button
          ref={addDemo}
          className="button primary library-add"
          onClick={() => {
            uploadTrigger.current = addDemo.current;
            setUploadOpen(true);
          }}
        >
          <Upload size={16} /> {t('Add a demo')}
        </button>
      </header>
      <div
        className="library-tabs"
        role="tablist"
        aria-label={t('Match sources')}
        onKeyDown={(event) => {
          const index = tabs.indexOf(active);
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? tabs.length - 1
                : event.key === 'ArrowRight'
                  ? (index + 1) % tabs.length
                  : event.key === 'ArrowLeft'
                    ? (index - 1 + tabs.length) % tabs.length
                    : undefined;
          if (next === undefined) return;
          event.preventDefault();
          selectTab(tabs[next]);
          event.currentTarget.querySelectorAll('button')[next]?.focus();
        }}
      >
        {tabs.map((tab) => (
          <button
            type="button"
            key={tab}
            role="tab"
            id={'tab-' + tab}
            aria-controls={'panel-' + tab}
            aria-selected={tab === active}
            tabIndex={tab === active ? 0 : -1}
            onClick={() => selectTab(tab)}
          >
            {tab !== 'mine' && <ProviderLogo provider={tab} />}
            {t(tab === 'mine' ? 'My demos' : tab === 'steam' ? 'Steam' : 'FACEIT')}
          </button>
        ))}
      </div>
      {unavailable && (
        <div className="library-source-notice" role="status">
          <p>{t('This match source is unavailable for your account.')}</p>
          <Link to="/account/connections">{t('Connected accounts')}</Link>
        </div>
      )}
      {tabs.map((tab) => (
        <div
          key={tab}
          id={'panel-' + tab}
          role="tabpanel"
          aria-labelledby={'tab-' + tab}
          hidden={tab !== active}
        >
          {tab === active &&
            (tab === 'mine' ? <MyDemos /> : <ProviderMatches source={tab} activity={activity} />)}
        </div>
      ))}
      {uploadOpen && (
        <UploadDialog
          key={match?.id}
          close={closeUpload}
          match={match}
          returnTo={'/library' + (back.size ? '?' + back : '')}
        />
      )}
    </>
  );
}

function MyDemos() {
  const { user, config, notify } = useApp();
  const [source, setSource] = useState('');
  const [search, setSearch] = useState('');
  const [deleting, setDeleting] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const { demos, total, loading, error, more, load } = useDemoLibrary(user?.id, search, source);
  const deleteDemo = useDeleteDemo();
  const latestLoad = useRef(load);
  latestLoad.current = load;
  const deletion = useRef({ active: true, pending: false });
  useEffect(() => {
    const scope = { active: true, pending: false };
    deletion.current = scope;
    setDeleting(false);
    return () => {
      scope.active = false;
    };
  }, [user?.id]);
  async function remove(demo: Demo) {
    const scope = deletion.current;
    if (!demo.owned || scope.pending) return;
    scope.pending = true;
    const focusReturn = captureFocusReturn();
    try {
      if (
        !(await deleteDemo(
          demo,
          () => scope.active,
          () => setDeleting(true),
        ))
      )
        return;
      notify(t('Demo deleted.'));
      await latestLoad.current();
      if (scope.active) returnFocus(searchInput.current, focusReturn);
    } catch (error) {
      if (scope.active) notify(t((error as Error).message));
    } finally {
      scope.pending = false;
      if (scope.active) setDeleting(false);
    }
  }
  return (
    <section className="library-section" aria-labelledby="matches-heading" aria-busy={loading}>
      <div className="library-controls">
        <div className="library-sources">
          <span className="library-total">
            {t('demo_count', { count: total })}
            {more ? ' · ' + t('{{v0}} shown', { v0: demos.length }) : ''}
          </span>
          <select
            aria-label={t('Demo source')}
            value={source}
            onChange={(event) => setSource(event.target.value)}
          >
            <option value="">{t('All sources')}</option>
            <option value="upload">{t('Upload')}</option>
            <option value="faceit">{t('FACEIT')}</option>
            <option value="steam">{t('Steam')}</option>
          </select>
        </div>
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
              <div className="demo-row-shell" key={demo.id}>
                <Link className="demo-row" to={'/watch/' + demo.id} state={{ from: '/library' }}>
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
                      {t(
                        demo.source === 'faceit'
                          ? 'FACEIT'
                          : demo.source === 'steam'
                            ? 'Steam'
                            : 'Upload',
                      )}
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
                {demo.owned && (
                  <button
                    className="icon-button demo-delete"
                    aria-label={t('Delete demo') + ': ' + demo.name}
                    title={t('Delete demo')}
                    disabled={
                      deleting || demo.status === 'uploading' || demo.status === 'processing'
                    }
                    onClick={() => void remove(demo)}
                  >
                    <Trash2 size={17} aria-hidden="true" />
                  </button>
                )}
              </div>
            ))}
          </div>
          {more && (
            <button className="button load-more" disabled={loading} onClick={() => void load(true)}>
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
                    : search || source
                      ? 'No matching demos.'
                      : 'No demos yet.',
                )}
              </h2>
              {!loading && (
                <p>
                  {t(
                    source
                      ? 'Try a different source or search.'
                      : search
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
  );
}
