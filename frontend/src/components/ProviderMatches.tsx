import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { ArrowUpRight, Download, RefreshCw } from 'lucide-react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { useApp } from '../context';
import { locale, t } from '../i18n';
import type { MatchActivity, MatchActivityRow, MatchDemo } from '../match-activity';
import { MapThumbnail, MatchDetails, mapName } from './MatchDetails';
import { useConfirm } from './Confirmation';
import './provider-matches.css';
import { Pagination, SelectControl } from './Controls';

export type MatchSource = 'steam' | 'faceit';
type Match = {
  match_id: string;
  share_code?: string | null;
  played_at?: number | null;
  competition?: string | null;
  faceit_level?: number;
  map?: string | null;
  teams?: { name: string | null; score: number | null }[];
  result?: 'win' | 'loss' | null;
  no_demo?: boolean;
  demos: MatchDemo[];
};
type Page = {
  items: Match[];
  next: string | null;
  had_matches?: boolean;
  needs_codes?: boolean;
  retry_at?: number;
};

function faceitMatchId(input: string) {
  if (/^[A-Za-z0-9_-]{1,128}$/.test(input)) return input;
  try {
    const url = new URL(input);
    if (url.origin === 'https://www.faceit.com' && !url.username && !url.password)
      return /^\/[a-z-]+\/cs2\/room\/([A-Za-z0-9_-]{1,128})\/?$/.exec(url.pathname)?.[1];
  } catch {
    return undefined;
  }
}

function matchLabel(source: MatchSource, id: string) {
  return t(source === 'steam' ? 'Steam match {{v0}}' : 'FACEIT match {{v0}}', { v0: id });
}

function OpenDemo({
  demo,
  returnTo,
  label,
}: {
  demo: MatchDemo;
  returnTo: string;
  label?: string;
}) {
  const location = useLocation();
  return (
    <Link
      className="button match-open"
      to={'/watch/' + demo.id}
      state={{ from: returnTo, fromState: location.state }}
    >
      {label ?? t('Open')}
      <span className={'match-demo-state status-' + demo.status}>
        {t(
          demo.status === 'ready'
            ? 'Ready'
            : demo.status === 'failed'
              ? 'Parse failed'
              : demo.status === 'processing'
                ? 'Processing…'
                : 'In queue',
        )}
      </span>
    </Link>
  );
}

function MatchRow({
  source,
  match,
  activity,
  canDownload,
  returnTo,
  inspect,
  download,
}: {
  source: MatchSource;
  match: Match;
  activity: MatchActivity;
  canDownload: boolean;
  returnTo: string;
  inspect: (id: string) => void;
  download: (id: string, resource: string) => void;
}) {
  const location = useLocation();
  const id = match.match_id;
  const state = useSyncExternalStore(activity.subscribe, () =>
    source === 'faceit' ? activity.get(id) : undefined,
  );
  const demos =
    state?.added && !match.demos.some((demo) => demo.id === state.added!.id)
      ? [state.added, ...match.demos]
      : match.demos;
  const unavailable = Boolean(state?.unavailable || match.no_demo);
  // A member can always pair their own file, whether or not an automatic download exists.
  const needsDemo = demos.every((demo) => demo.status === 'failed');
  const ready = match.demos.filter((demo) => demo.status === 'ready');
  const recorded = ready.length === 1 ? ready[0] : undefined;
  const map = match.map ?? recorded?.map;
  const time = match.played_at;
  const title = match.teams?.some((team) => team.name)
    ? match.teams.map((team) => team.name ?? t('Unknown team')).join(t(' vs '))
    : matchLabel(source, id);
  const scores =
    match.teams?.length === 2 && match.teams.every((team) => team.score !== null)
      ? match.teams.map((team) => team.score)
      : undefined;
  const upload = new URLSearchParams(returnTo.split('?')[1]);
  upload.set('upload', '1');
  upload.set(source === 'steam' ? 'steamMatch' : 'faceitMatch', id);

  return (
    <li className="provider-match-row" data-outcome={match.result ?? undefined}>
      <div className="provider-match-identity">
        <MapThumbnail map={map} />
        <div className="provider-match-info">
          <strong>{title}</strong>
          <div className="provider-match-meta">
            {scores?.length === 2 && (
              <span className="provider-match-score">{scores.join('–')}</span>
            )}
            {match.result && (
              <span className="provider-match-result" data-outcome={match.result}>
                {t(match.result === 'win' ? 'Win' : 'Loss')}
              </span>
            )}
            {match.competition && <span>{match.competition}</span>}
            {time != null && (
              <time dateTime={new Date(time * 1000).toISOString()}>
                {new Date(time * 1000).toLocaleDateString(locale(), { dateStyle: 'medium' })}
              </time>
            )}
            <span className="match-map">{mapName(map) || t('Unknown map')}</span>
          </div>
          <MatchDetails
            performance={recorded?.performance}
            faceitLevel={match.faceit_level}
            score={scores ? undefined : recorded?.score}
          />
        </div>
      </div>
      <div className="provider-match-actions">
        {demos.map((demo) => (
          <OpenDemo
            key={demo.id}
            demo={demo}
            returnTo={returnTo}
            label={
              demos.length > 1 && demo.map
                ? t('Open {{v0}}', { v0: demo.map.replace(/^de_/, '') })
                : undefined
            }
          />
        ))}
        {source === 'steam' && match.share_code && (
          <a
            className="button"
            href={
              'steam://rungame/730/76561202255233023/+csgo_download_match%20' + match.share_code
            }
          >
            <Download size={16} aria-hidden="true" /> {t('Download in CS2')}
          </a>
        )}
        {source === 'faceit' && canDownload && !unavailable && (
          <button className="button" disabled={!!state?.busy} onClick={() => inspect(id)}>
            <Download size={16} aria-hidden="true" />
            {t(demos.length ? 'More demo files' : 'Download')}
          </button>
        )}
        {needsDemo && (source === 'faceit' || match.share_code) && (
          <Link className="button" to={'/library?' + upload} state={location.state}>
            {t(source === 'steam' ? 'Upload this demo' : 'Upload demo')}
          </Link>
        )}
        {source === 'faceit' && (
          <a
            className="button"
            href={'https://www.faceit.com/en/cs2/room/' + id}
            target="_blank"
            rel="noreferrer"
          >
            {t('Open on FACEIT')} <ArrowUpRight size={16} aria-hidden="true" />
          </a>
        )}
      </div>
      {(state?.busy || unavailable) && (
        <p className="provider-match-feedback" role="status">
          {t(
            unavailable
              ? 'No demo available'
              : state?.busy === 'details'
                ? 'Checking demo files…'
                : 'Downloading…',
          )}
        </p>
      )}
      {state?.error && (
        <p className="provider-match-feedback error" role="alert">
          {t(state.error)}
        </p>
      )}
      {!!state?.files?.length && (
        <div className="provider-match-files">
          <strong>{t('Choose a demo file')}</strong>
          <div className="provider-match-actions">
            {state.files.map((file) => {
              const demo = demos.find((entry) => entry.id === file.demo?.id) ?? file.demo;
              const label = t('Demo file {{v0}}', { v0: file.file });
              return demo ? (
                <OpenDemo key={file.id} demo={demo} label={label} returnTo={returnTo} />
              ) : (
                <button
                  className="button"
                  key={file.id}
                  disabled={!!state.busy}
                  onClick={() => download(id, file.id)}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </li>
  );
}

export default function ProviderMatches({
  source,
  activity,
}: {
  source: MatchSource;
  activity: MatchActivity;
}) {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const { user, config, refresh } = useApp();
  const canDownload = Boolean(user?.match_sources?.faceit_download);
  const confirm = useConfirm();
  const [loaded, setLoaded] = useState<{ path: string; page?: Page; error?: string }>();
  const [reload, setReload] = useState(0);
  const [sync, setSync] = useState({ busy: false, message: '', error: false });
  const [manual, setManual] = useState('');
  const [manualError, setManualError] = useState(false);
  const [now, setNow] = useState(() => Date.now() / 1000);
  const filter =
    params.get('filter') === 'downloaded'
      ? 'downloaded'
      : params.get('filter') === 'missing'
        ? 'missing'
        : 'all';
  const token = params.get('cursor') ?? '';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const previousCursors: string[] = Array.isArray(location.state?.previousCursors)
    ? location.state.previousCursors
    : [];
  const query = new URLSearchParams({ filter });
  if (token) query.set(source === 'faceit' && filter !== 'downloaded' ? 'cursor' : 'offset', token);
  const endpoint = '/api/connections/' + source + '/matches?' + query;
  const current = loaded?.path === endpoint ? loaded : undefined;
  const data = current?.page;
  const polling = Boolean(
    data?.items.some((match) =>
      match.demos.some((demo) => ['queued', 'processing'].includes(demo.status)),
    ),
  );
  const scope = useRef('');
  const scopeKey = endpoint + ':' + location.key;
  scope.current = scopeKey;
  useEffect(() => {
    scope.current = scopeKey;
    return () => {
      scope.current = '';
    };
  }, [scopeKey]);
  const importRevision = useSyncExternalStore(activity.subscribe, activity.completed);
  const listHeading = useRef<HTMLHeadingElement>(null);
  const returnParams = new URLSearchParams(params);
  returnParams.delete('upload');
  returnParams.delete('steamMatch');
  returnParams.delete('faceitMatch');
  const returnTo = '/library?' + returnParams;

  useEffect(() => {
    const controller = new AbortController();
    const get = () =>
      api<Page>(endpoint, { signal: controller.signal })
        .then((result) => {
          if (!controller.signal.aborted) {
            // A completed import lookup is authoritative again after revisiting the list.
            if (source === 'faceit')
              for (const match of result.items) {
                const row = activity.get(match.match_id);
                if (row?.added && match.demos.some((demo) => demo.id === row.added!.id))
                  activity.set(match.match_id, { ...row, added: undefined });
              }
            setLoaded({ path: endpoint, page: result });
          }
        })
        .catch((error: Error) => {
          if (controller.signal.aborted) return;
          setLoaded((prior) => ({
            path: endpoint,
            page: prior?.path === endpoint ? prior.page : undefined,
            error: error.message,
          }));
          // Another browser tab can revoke a connection while this list is open.
          if (error instanceof ApiError && [401, 403, 409].includes(error.status))
            void refresh().catch(() => {});
        });
    void get();
    return () => controller.abort();
  }, [endpoint, reload, source, activity, importRevision, refresh]);

  // Match metadata follows the worker without recurring reads of completed pages.
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => setReload((value) => value + 1), 10_000);
    return () => clearInterval(timer);
  }, [polling]);
  useEffect(() => {
    if (!data?.retry_at || data.retry_at <= now) return;
    const timer = setTimeout(() => setNow(Date.now() / 1000), (data.retry_at - now) * 1000);
    return () => clearTimeout(timer);
  }, [data?.retry_at, now]);

  function go(cursor: string, number: number) {
    const search = new URLSearchParams(returnParams);
    if (cursor) search.set('cursor', cursor);
    else search.delete('cursor');
    if (number > 1) search.set('page', String(number));
    else search.delete('page');
    const previous =
      number > page
        ? [...previousCursors.slice(-255), token]
        : previousCursors.slice(0, Math.max(0, previousCursors.length - (page - number)));
    listHeading.current?.focus({ preventScroll: true });
    setParams(search, { state: { previousCursors: previous } });
  }

  function setFilter(value: string) {
    const search = new URLSearchParams(returnParams);
    if (value === 'all') search.delete('filter');
    else search.set('filter', value);
    search.delete('cursor');
    search.delete('page');
    setParams(search);
  }

  async function syncSteam() {
    if (sync.busy) return;
    const started = scope.current;
    setSync({ busy: true, message: '', error: false });
    try {
      const result = await api<{ up_to_date: boolean }>('/api/connections/steam/history/sync', {
        method: 'POST',
      });
      setSync({
        busy: false,
        error: false,
        message: result.up_to_date
          ? 'Steam match list is up to date.'
          : 'More Steam matches may be available. Sync again to continue.',
      });
      if (started === scope.current && token) go('', 1);
    } catch (error) {
      setSync({ busy: false, error: true, message: (error as Error).message });
    } finally {
      setNow(Date.now() / 1000);
      setReload((value) => value + 1);
    }
  }

  async function download(id: string, resource: string) {
    const prior = activity.get(id);
    if (prior?.busy) return;
    if (
      !(await confirm({
        title: t('Download FACEIT demo?'),
        description: t('The demo will be added to your private library and queued for processing.'),
        confirmLabel: t('Download'),
      }))
    )
      return;
    activity.set(id, { ...prior, busy: 'download', error: undefined });
    try {
      const result = await api<{ id: string }>('/api/connections/faceit/import', {
        method: 'POST',
        body: JSON.stringify({ match_id: id, resource_id: resource }),
      });
      const demo: MatchDemo = { id: result.id, status: 'queued' };
      activity.set(id, {
        ...prior,
        added: demo,
        error: undefined,
        files: prior?.files?.map((file) => (file.id === resource ? { ...file, demo } : file)),
      });
    } catch (error) {
      activity.set(id, { ...prior, ...failureState(error) });
    }
  }

  async function inspect(id: string) {
    const started = scope.current;
    const prior = activity.get(id);
    if (prior?.busy || prior?.unavailable) return;
    activity.set(id, { ...prior, busy: 'details', error: undefined });
    try {
      const { files } = await api<{ files: NonNullable<MatchActivityRow['files']> }>(
        '/api/connections/faceit/match-demos?' + new URLSearchParams({ match_id: id }),
      );
      activity.set(id, { ...prior, files, error: undefined });
      if (started === scope.current && files.length === 1 && !files[0].demo)
        await download(id, files[0].id);
    } catch (error) {
      activity.set(id, { ...prior, ...failureState(error) });
    }
  }

  function lookup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const id = faceitMatchId(String(new FormData(event.currentTarget).get('match')).trim());
    setManualError(!id);
    if (!id) return;
    setManual(id);
    void inspect(id);
  }

  const prior =
    source === 'faceit' && filter !== 'downloaded'
      ? previousCursors.at(-1)
      : String(Math.max(0, Number(token) - 25));
  const cooldown = (data?.retry_at ?? 0) > now;
  const nextCursor = data?.next;
  return (
    <div className="library-section provider-matches">
      <div className="provider-match-toolbar">
        <h2 className="visually-hidden" ref={listHeading} tabIndex={-1}>
          {t(source === 'steam' ? 'Steam matches' : 'FACEIT matches')}
        </h2>
        <div className="provider-match-filter">
          <span aria-hidden="true">{t('Show matches')}</span>
          <SelectControl
            label={t('Show matches')}
            value={filter}
            onValueChange={setFilter}
            options={[
              { value: 'all', label: t('All') },
              { value: 'downloaded', label: t('Downloaded') },
              { value: 'missing', label: t('Not downloaded') },
            ]}
          />
        </div>
        <Pagination
          status={t('Page {{v0}}', { v0: page })}
          previous={
            page > 1
              ? () =>
                  go(
                    page === 2 || prior === undefined ? '' : prior,
                    prior === undefined ? 1 : Math.max(1, page - 1),
                  )
              : undefined
          }
          next={nextCursor && !sync.busy ? () => go(nextCursor, page + 1) : undefined}
        />
        {source === 'steam' && (
          <button
            className="button"
            disabled={sync.busy || !data || data.needs_codes || cooldown}
            onClick={() => void syncSteam()}
          >
            <RefreshCw size={16} aria-hidden="true" />{' '}
            {t(sync.busy ? 'Syncing…' : 'Sync Steam matches')}
          </button>
        )}
      </div>
      {source === 'steam' && (
        <div className="provider-match-hint">
          <p>{t('CS2 saves the downloaded demo under game/csgo/replays.')}</p>
          {sync.message && (
            <p className={sync.error ? 'error' : undefined} role={sync.error ? 'alert' : 'status'}>
              {t(sync.message)}
            </p>
          )}
          {cooldown && (
            <p role="status">{t('Steam match discovery is cooling down. Try again later.')}</p>
          )}
          {data?.needs_codes && (
            <p role="status">
              {t('Replace your Steam sync codes to resume sync.')}{' '}
              <Link to="/account/connections">{t('Connected accounts')}</Link>
            </p>
          )}
        </div>
      )}
      {source === 'faceit' && !canDownload && (
        <div className="provider-match-hint">
          <p>
            {t(
              'This instance does not have everything needed to download FACEIT demos. You can still upload them yourself.',
            )}
          </p>
          {config.admin_access && (
            <p>
              {t(
                'Set an approved FACEIT Downloads API token as FACEIT_DOWNLOAD_TOKEN, then restart the web service.',
              )}
            </p>
          )}
        </div>
      )}
      {source === 'faceit' && canDownload && (
        <details className="provider-match-lookup">
          <summary>{t('Import by FACEIT match URL')}</summary>
          <form onSubmit={lookup}>
            <label>
              {t('FACEIT match ID or match room URL')}
              <input name="match" required maxLength={300} />
            </label>
            <button className="button">{t('Find demo files')}</button>
          </form>
          {manualError && (
            <p className="error" role="alert">
              {t('Enter a FACEIT CS2 match ID or match room URL.')}
            </p>
          )}
          {manual && (
            <ul>
              <MatchRow
                source={source}
                match={
                  data?.items.find((match) => match.match_id === manual) ?? {
                    match_id: manual,
                    demos: [],
                  }
                }
                activity={activity}
                canDownload
                returnTo={returnTo}
                inspect={inspect}
                download={(id, resource) => void download(id, resource)}
              />
            </ul>
          )}
        </details>
      )}
      <div className="provider-match-body" aria-busy={!current}>
        {current?.error && (
          <div className="inline-state" role="alert">
            <p>{t(current.error)}</p>
            <button
              className="button"
              onClick={() => {
                if (!data) setLoaded(undefined);
                setReload((value) => value + 1);
              }}
            >
              {t('Try again')}
            </button>
          </div>
        )}
        {!current && (
          <>
            <p className="visually-hidden" role="status">
              {t('Loading matches…')}
            </p>
            <div className="provider-match-skeleton" aria-hidden="true">
              {Array.from({ length: 6 }, (_, index) => (
                <div key={index}>
                  <i />
                  <i />
                </div>
              ))}
            </div>
          </>
        )}
        {data?.items.length ? (
          <ul className="provider-match-list">
            {data.items.map((match) => (
              <MatchRow
                key={match.match_id}
                source={source}
                match={match}
                activity={activity}
                canDownload={canDownload}
                returnTo={returnTo}
                inspect={(id) => void inspect(id)}
                download={(id, resource) => void download(id, resource)}
              />
            ))}
          </ul>
        ) : (
          data &&
          !current?.error && (
            <div className="library-empty">
              <p role="status">{emptyMessage(source, filter, page, data)}</p>
            </div>
          )
        )}
      </div>
    </div>
  );
}

function emptyMessage(source: MatchSource, filter: string, page: number, data: Page) {
  if (filter === 'missing' && data.next)
    return t('No undownloaded matches in this part of your history. Continue to the next page.');
  if (page > 1) return t('No more matches for this filter.');
  if (filter === 'downloaded') return t('No demos have been added from this source.');
  if (filter === 'missing' && data.had_matches) return t('All matches have been downloaded.');
  return t(
    source === 'steam'
      ? 'No synced Steam matches yet.'
      : 'FACEIT lists no CS2 matches for this account.',
  );
}

function failureState(error: unknown): MatchActivityRow {
  if (error instanceof ApiError && error.code === 'faceit_no_demo') return { unavailable: true };
  return { error: (error as Error).message };
}
