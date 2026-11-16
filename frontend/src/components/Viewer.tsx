import i18n, { t, locale, setLanguage, type Language } from '../i18n';
import Brand from './Brand';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useLocation } from 'react-router-dom';
import {
  ArrowLeft,
  BookmarkPlus,
  Expand,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Trash2,
  Share2,
  Eye,
  SlidersHorizontal,
  FastForward,
  Users,
  ListVideo,
  X,
  Sun,
  Moon,
  ChevronDown,
  MoreHorizontal,
} from 'lucide-react';
import { api } from '../api';
import { useReplay } from '../useReplay';
import { useApp } from '../context';
import type { Bookmark } from '../types';
import { frameAt, readSettings, skipDeadTime } from '../playback';
import { roundAt, roundEvents } from '../review-events';
import { RoundEventReview } from './RoundEvents';
import ReplayTimeline from './ReplayTimeline';
import ObjectiveHud from './ObjectiveHud';
import ReviewHud from './ReviewHud';
import Communications from './Communications';
import ViewerOptions from './ViewerOptions';
import TacticalPlot from './TacticalPlot';
import ManageDemo from './ManageDemo';
import AccountMenu from './AccountMenu';
import { ActionMenu, SelectControl, type MenuAction } from './Controls';
const Scene = lazy(() => import('./Scene'));
const clock = (seconds: number) =>
  t('{{v0}}:{{v1}}', {
    v0: Math.floor(seconds / 60),
    v1: String(Math.floor(seconds % 60)).padStart(2, '0'),
  });
export default function Viewer({ theme, toggleTheme }: { theme: string; toggleTheme: () => void }) {
  const { id } = useParams();
  const location = useLocation();
  const { user, config, notify, signIn } = useApp();
  const previous = location.state?.from;
  const backTo =
    typeof previous === 'string' &&
    ['/', '/library', '/explore', '/features/viewer'].includes(previous)
      ? previous
      : user
        ? '/library'
        : '/';
  const [playing, setPlaying] = useState(false),
    [tick, setTick] = useState(0),
    [speed, setSpeed] = useState(1),
    [mode, setMode] = useState('orbit'),
    [selected, setSelected] = useState('0'),
    [tab, setTab] = useState('events'),
    [bookmarks, setBookmarks] = useState<Bookmark[]>([]),
    [label, setLabel] = useState(''),
    [showNote, setShowNote] = useState(false),
    [busy, setBusy] = useState(false);
  const { data, demo, setDemo, error, chunkError, buffering, first, last, retryChunk } = useReplay(
    id,
    tick,
    (replay, initialTick) => {
      setTick(initialTick);
      setSelected((previous) =>
        replay.players.some((player) => player.id === previous)
          ? previous
          : (replay.players[0]?.id ?? ''),
      );
      setPlaying(false);
    },
    user?.id,
  );
  const allReviewEvents = useMemo(
    () => (data ? roundEvents(data, { number: 0, start: first, end: last }, selected) : []),
    [data, first, last, selected],
  );
  const [settings, setSettings] = useState(readSettings),
    [options, setOptions] = useState(false),
    [manage, setManage] = useState(false);
  const [communicationsOpen, setCommunicationsOpen] = useState(false);
  const [mapAvailable, setMapAvailable] = useState(false);
  const communicationsTrigger = useRef<HTMLElement | null>(null);
  const communicationsWasOpen = useRef(false);
  useEffect(() => {
    if (communicationsOpen) communicationsWasOpen.current = true;
    else if (communicationsWasOpen.current) {
      communicationsWasOpen.current = false;
      queueMicrotask(() => restoreViewerFocus(communicationsTrigger.current));
    }
  }, [communicationsOpen]);
  useEffect(() => {
    try {
      localStorage.setItem('viewer-settings', JSON.stringify(settings));
    } catch {}
  }, [settings]);
  const [panel, setPanel] = useState<'players' | 'review' | null>(null);
  const mutationScope = useRef({ active: true });
  const [roundsOpen, setRoundsOpen] = useState(false);
  const [eventReviewKey, setEventReviewKey] = useState(0);
  const panelClose = useRef<HTMLButtonElement>(null);
  const panelTrigger = useRef<HTMLElement | null>(null);
  const panelWasOpen = useRef(false);
  const full = useRef<HTMLDivElement>(null);
  const playbackDock = useRef<HTMLDivElement>(null);
  const mobileMoreTrigger = useRef<HTMLButtonElement>(null);
  const momentMenuTrigger = useRef<HTMLButtonElement>(null);
  const eventMenuTrigger = useRef<HTMLElement | null>(null);
  const optionsTrigger = useRef<HTMLButtonElement>(null);
  const panelElement = useRef<HTMLElement>(null);
  function restoreViewerFocus(preferred: HTMLElement | null) {
    const target = [preferred, optionsTrigger.current, panelClose.current].find((element) => {
      if (!element?.isConnected || element.closest('[inert]') || element.matches(':disabled'))
        return false;
      const bounds = element.getBoundingClientRect();
      return (
        bounds.width > 0 && bounds.height > 0 && getComputedStyle(element).visibility !== 'hidden'
      );
    });
    target?.focus({ preventScroll: true });
  }
  const [compactPanels, setCompactPanels] = useState(
    () => window.matchMedia('(max-width:540px),(max-height:560px)').matches,
  );
  useEffect(() => {
    const media = window.matchMedia('(max-width:540px),(max-height:560px)');
    const update = () => setCompactPanels(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    const dock = playbackDock.current;
    if (!dock) return;
    const update = () =>
      full.current?.style.setProperty(
        '--viewer-dock-height',
        `${dock.getBoundingClientRect().height}px`,
      );
    update();
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(update);
      observer.observe(dock);
      return () => observer.disconnect();
    }
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [Boolean(data)]);
  function closePanel() {
    setPanel(null);
  }
  function togglePanel(next: 'players' | 'review', trigger: HTMLElement) {
    panelTrigger.current = trigger;
    if (panel === next) closePanel();
    else setPanel(next);
  }
  useEffect(() => {
    if (panel) {
      panelWasOpen.current = true;
      panelClose.current?.focus();
    } else if (panelWasOpen.current) {
      panelWasOpen.current = false;
      queueMicrotask(() => restoreViewerFocus(panelTrigger.current));
    }
  }, [panel, compactPanels]);
  useEffect(() => {
    function escape(e: KeyboardEvent) {
      if (
        e.key === 'Tab' &&
        compactPanels &&
        panel &&
        !e.defaultPrevented &&
        !document.querySelector('dialog[open]') &&
        !document.querySelector('[role="listbox"],[role="menu"]')
      ) {
        const candidates = [
          ...(panelElement.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],summary',
          ) || []),
        ].filter(
          (element) =>
            element.getBoundingClientRect().width > 0 &&
            (!element.checkVisibility || element.checkVisibility()),
        );
        const first = candidates[0],
          last = candidates.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
      if (
        !e.defaultPrevented &&
        e.key === 'Escape' &&
        panel &&
        !document.querySelector('dialog[open]')
      )
        closePanel();
    }
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [panel, compactPanels]);
  const timeRef = useRef<number | null>(null);
  useEffect(() => {
    const scope = { active: true };
    mutationScope.current = scope;
    setPlaying(false);
    setBookmarks([]);
    setLabel('');
    setShowNote(false);
    setBusy(false);
    setTab('events');
    setPanel(null);
    setOptions(false);
    setManage(false);
    setCommunicationsOpen(false);
    return () => {
      scope.active = false;
    };
  }, [id, user?.id]);
  useEffect(() => {
    const controller = new AbortController();
    if (id !== 'sample') setBookmarks([]);
    if (id !== 'sample' && user)
      api<Bookmark[]>('/api/demos/' + id + '/bookmarks', { signal: controller.signal })
        .then((notes) => {
          if (!controller.signal.aborted) setBookmarks(notes);
        })
        .catch(() => {});
    return () => controller.abort();
  }, [id, user?.id]);
  const rate = data?.tickRate ?? 64;
  const seek = useCallback(
    (value: number) => {
      setTick(Math.max(first, Math.min(last, value)));
    },
    [first, last],
  );
  useEffect(() => {
    if (!playing || !data || buffering) {
      timeRef.current = null;
      return;
    }
    let frame = 0;
    const animate = (now: number) => {
      const dt = timeRef.current === null ? 0 : Math.min((now - timeRef.current) / 1000, 0.1);
      timeRef.current = now;
      setTick((t) => {
        const proposed = t + dt * rate * speed;
        const next = settings.autoSkip ? skipDeadTime(data, proposed, 'all', last) : proposed;
        if (next >= last) {
          setPlaying(false);
          return last;
        }
        return next;
      });
      frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);
    return () => {
      cancelAnimationFrame(frame);
      timeRef.current = null;
    };
  }, [playing, data, buffering, rate, speed, last, settings.autoSkip]);
  useEffect(() => {
    function keys(e: KeyboardEvent) {
      if (
        e.defaultPrevented ||
        (e.target as HTMLElement).closest(
          'input,select,textarea,button,a,dialog,[data-keyboard-managed]',
        )
      )
        return;
      if (e.code === 'Space') {
        e.preventDefault();
        setPlaying((p) => !p);
      }
      if (e.code === 'ArrowRight') {
        e.preventDefault();
        setTick((t) => Math.min(last, t + rate * 5));
      }
      if (e.code === 'ArrowLeft') {
        e.preventDefault();
        setTick((t) => Math.max(first, t - rate * 5));
      }
      if (e.code === 'KeyF') void toggleFull();
    }
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  }, [last, first, rate]);
  async function toggleFull() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await full.current?.requestFullscreen();
    } catch {
      notify(t('Fullscreen is unavailable in this browser.'));
    }
  }
  async function saveNote() {
    if (!user && id !== 'sample') {
      signIn();
      return;
    }
    if (!label.trim()) return;
    const scope = mutationScope.current;
    setBusy(true);
    try {
      if (id === 'sample') {
        setBookmarks((b) => [
          ...b,
          { id: crypto.randomUUID(), tick: Math.round(tick), label: label.trim() },
        ]);
        notify(t('Sample note added for this visit.'));
      } else {
        const b = await api<Bookmark>('/api/demos/' + id + '/bookmarks', {
          method: 'POST',
          body: JSON.stringify({ tick: Math.round(tick), label: label.trim() }),
        });
        if (!scope.active) return;
        setBookmarks((bs) => [...bs, b].sort((a, b) => a.tick - b.tick));
      }
      setLabel('');
      setShowNote(false);
      setTab('notes');
      setPanel('review');
    } catch (e) {
      if (scope.active) notify((e as Error).message);
    } finally {
      if (scope.active) setBusy(false);
    }
  }
  async function removeNote(bid: string) {
    const scope = mutationScope.current;
    try {
      if (id !== 'sample') await api('/api/bookmarks/' + bid, { method: 'DELETE' });
      if (!scope.active) return;
      setBookmarks((bs) => bs.filter((b) => b.id !== bid));
    } catch (e) {
      if (scope.active) notify((e as Error).message);
    }
  }
  async function share() {
    if (!demo?.owned) return;
    const scope = mutationScope.current;
    const url = window.location.href;
    const publish = !demo.public;
    if (
      publish &&
      !window.confirm(
        t(
          config.public_access
            ? 'Make this demo public? Anyone can access its replay data and recorded voice, chat and subtitles. It will appear in Community. Personal notes stay private.'
            : 'Share this demo with instance members, including replay data and recorded voice, chat and subtitles? They must sign in. Personal notes stay private.',
        ),
      )
    )
      return;
    try {
      await api('/api/demos/' + id, { method: 'PATCH', body: JSON.stringify({ public: publish }) });
      if (!scope.active) return;
      setDemo({ ...demo, public: publish });
      if (publish) {
        await navigator.clipboard?.writeText(url).catch(() => {});
        if (!scope.active) return;
        notify(
          t(
            config.public_access
              ? 'Demo is public. Link copied if clipboard is available.'
              : 'Demo shared with members. Link copied if clipboard is available.',
          ),
        );
      } else notify(t('Demo is private.'));
    } catch (e) {
      if (scope.active) notify((e as Error).message);
    }
  }
  if (error)
    return (
      <div className="inline-state">
        <h1>{t('Demo unavailable')}</h1>
        <p role="alert">{t(error)}</p>
        <Link className="button" to={backTo}>
          {t('Back to library')}
        </Link>
      </div>
    );
  if (!data)
    return (
      <>
        <Link className="back-link" to={backTo}>
          <ArrowLeft size={16} />
          {t('Library')}
        </Link>
        <div className="processing">
          <span className={'processing-mark ' + (demo?.status !== 'failed' ? 'spin' : '')}>↻</span>
          <h1>
            {demo?.status === 'failed'
              ? t('This demo could not be parsed')
              : demo?.status === 'processing'
                ? t('Reading the match…')
                : t('Your demo is in the queue')}
          </h1>
          <p>
            {demo?.error ||
              t(
                'You can leave this page. Your match will be ready in the library when processing finishes.',
              )}
          </p>
          <Link className="button" to={backTo}>
            {t('Return to library')}
          </Link>
          {demo?.owned && demo.status === 'failed' && (
            <button className="button" onClick={() => setManage(true)}>
              {t('Manage failed demo')}
            </button>
          )}
          {manage && demo && (
            <ManageDemo demo={demo} onChange={setDemo} close={() => setManage(false)} />
          )}
        </div>
      </>
    );
  function openNote(trigger: HTMLElement | null) {
    panelTrigger.current = trigger;
    setPlaying(false);
    setTab('notes');
    setShowNote(true);
    setPanel('review');
  }
  function openRoundReview(trigger: HTMLElement | null) {
    panelTrigger.current = trigger;
    setTab('events');
    setEventReviewKey((value) => value + 1);
    setPanel('review');
  }
  function seekEvent(value: number) {
    setPlaying(false);
    seek(value);
  }
  const momentActions: MenuAction[] = [
    {
      id: 'communications',
      label: t('Communications'),
      onSelect: () => {
        communicationsTrigger.current = eventMenuTrigger.current;
        setCommunicationsOpen(true);
      },
    },
    {
      id: 'round-events',
      label: t('Current round events'),
      icon: <ListVideo size={16} />,
      onSelect: () => openRoundReview(eventMenuTrigger.current),
    },
    {
      id: 'timeout',
      label: t('Skip timeout'),
      onSelect: () => {
        const target = skipDeadTime(data, tick, 'timeout', last);
        if (target === tick) notify('No tactical or technical timeout at this position.');
        else seek(target);
      },
    },
    {
      id: 'kill',
      label: t('Next player kill'),
      onSelect: () => {
        const event = allReviewEvents.find((event) => event.type === 'kill' && event.tick > tick);
        if (event) seek(Math.max(first, event.tick - rate * 3));
        else notify('No later elimination by this player.');
      },
    },
    {
      id: 'death',
      label: t('Next player death'),
      onSelect: () => {
        const event = allReviewEvents.find((event) => event.type === 'death' && event.tick > tick);
        if (event) seek(Math.max(first, event.tick - rate * 3));
        else notify('No later death for this player.');
      },
    },
    {
      id: 'previous-sample',
      label: t('Previous sample'),
      separatorBefore: true,
      onSelect: () => {
        setPlaying(false);
        seek(tick - 4);
      },
    },
    {
      id: 'next-sample',
      label: t('Next sample'),
      onSelect: () => {
        setPlaying(false);
        seek(tick + 4);
      },
    },
  ];
  const { frame } = frameAt(data, tick);
  const round = data.rounds.filter((r) => r.tick <= tick).at(-1);
  const reviewRound = roundAt(data, tick, last);
  return (
    <div
      className={'viewer-frame' + (settings.inputs || settings.economy ? ' has-review-hud' : '')}
      ref={full}
    >
      <header className="viewer-titlebar" role="banner" inert={Boolean(panel) && compactPanels}>
        <div className="viewer-identity">
          <Link className="icon-button viewer-back" to={backTo} aria-label={t('Back to library')}>
            <ArrowLeft size={19} />
          </Link>
          <Brand to={backTo} />
          <div className="viewer-match">
            <h1>{data.sample ? t('Training courtyard') : data.map.replace('de_', '')}</h1>
            <span>
              {data.sample ? t('Interactive sample · original scene & synthetic data') : demo?.name}
            </span>
          </div>
        </div>
        <div className="viewer-global-actions">
          {demo?.owned && (
            <button className="button" onClick={() => setManage(true)}>
              {t('Manage')}
            </button>
          )}
          {demo?.owned && (
            <button
              className="icon-button"
              aria-label={t(demo.public ? 'Make private' : 'Share demo')}
              onClick={() => void share()}
            >
              <Share2 size={17} />
            </button>
          )}
          <SelectControl
            label={t('Language')}
            className="viewer-language"
            value={i18n.language}
            onValueChange={(value) => setLanguage(value as Language)}
            options={[
              { value: 'en', label: 'EN' },
              { value: 'fr', label: 'FR' },
            ]}
          />
          <button
            className="icon-button"
            aria-label={t(theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme')}
            onClick={toggleTheme}
          >
            {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
          </button>
          {!user && (
            <button className="button viewer-signin" onClick={signIn}>
              {t('Sign in')}
            </button>
          )}
          {user && <AccountMenu compact />}
        </div>
      </header>
      <div className="viewer-surface">
        <div className="viewer-stage" inert={Boolean(panel) && compactPanels}>
          <Suspense fallback={<div className="scene-fallback">{t('Starting renderer…')}</div>}>
            <Scene
              data={data}
              tick={tick}
              mode={mode}
              selected={selected}
              settings={settings}
              onMapAvailability={setMapAvailable}
            />
          </Suspense>
          {buffering && (
            <div className="replay-buffer" role={chunkError ? 'alert' : 'status'}>
              <span>{t(chunkError || 'Loading this moment…')}</span>
              {chunkError && (
                <button className="button" onClick={retryChunk}>
                  {t('Try again')}
                </button>
              )}
            </div>
          )}
          {settings.crosshair && mode === 'pov' && (
            <span className="crosshair" aria-hidden="true">
              <i />
              <i />
            </span>
          )}
          {settings.killfeed && (
            <div className="killfeed">
              {data.events
                .filter(
                  (e) => e.type === 'player_death' && e.tick <= tick && e.tick > tick - rate * 6,
                )
                .slice(-4)
                .map((e, i) => (
                  <div key={i}>
                    <strong>{e.attacker_name || t('World')}</strong>
                    <span>{e.weapon || t('eliminated')}</span>
                    {e.user_name || t('Player')}
                  </div>
                ))}
            </div>
          )}
          {settings.radar && mode !== '2d' && (
            <TacticalPlot data={data} tick={tick} selected={selected} compact />
          )}
        </div>
        <div className="viewer-scene-tools" inert={Boolean(panel) && compactPanels}>
          <div className="viewer-context">
            <span className="status-dot" />
            {t('Round')} {round?.number ?? 1}
            {!data.sample && mode !== '2d' && !mapAvailable && (
              <span
                className="viewer-map-status"
                title={t('Position view · map model not installed')}
              >
                {t('Position view')}
              </span>
            )}
            <span>
              {data.deadTimes?.some((s) => tick >= s.start && tick < s.end)
                ? t(data.deadTimes.find((s) => tick >= s.start && tick < s.end)?.kind || '')
                : t('Live playback')}
            </span>
          </div>
          <div className="viewer-camera-tools">
            <SelectControl
              label={t('Camera mode')}
              className="camera-select"
              icon={<Eye size={16} />}
              value={mode}
              onValueChange={setMode}
              options={[
                { value: 'orbit', label: t('Free camera') },
                { value: 'tactical', label: t('Overhead') },
                { value: '2d', label: t('2D tactical · low power') },
                { value: 'pov', label: t('Player perspective') },
              ]}
            />
            <button
              ref={optionsTrigger}
              className="button options-button"
              aria-label={t('Options')}
              onClick={() => setOptions(true)}
            >
              <SlidersHorizontal size={17} />
              <span>{t('Options')}</span>
            </button>
          </div>
        </div>
        {panel && (
          <aside
            ref={panelElement}
            className="viewer-drawer"
            role={compactPanels ? 'dialog' : undefined}
            aria-modal={compactPanels ? true : undefined}
            aria-label={t(panel === 'players' ? 'Players' : 'Match review')}
          >
            <div className="viewer-drawer-heading">
              <h2>{t(panel === 'players' ? 'Players' : 'Match review')}</h2>
              <button
                ref={panelClose}
                className="icon-button"
                aria-label={t('Close panel')}
                onClick={closePanel}
              >
                <X size={19} />
              </button>
            </div>
            <div className="viewer-drawer-content">
              {panel === 'players' ? (
                <div className="roster-panel">
                  {' '}
                  {[3, 2, 1, 0].map((team) => {
                    const ps = data.players.filter(
                      (p) => (frame.players.find((s) => s.id === p.id)?.team ?? p.team) === team,
                    );
                    if (!ps.length) return null;
                    return (
                      <div className="team-roster" key={team}>
                        <h3>
                          <span className={'team-dot team-' + team} />
                          {team === 3
                            ? t('Counter-terrorists')
                            : team === 2
                              ? t('Terrorists')
                              : t('Other players')}
                        </h3>
                        {ps.map((p) => {
                          const state = frame.players.find((s) => s.id === p.id);
                          return (
                            <button
                              className={'player-row ' + (p.id === selected ? 'selected' : '')}
                              key={p.id}
                              onClick={() => {
                                setSelected(p.id);
                                if (window.innerWidth < 700) closePanel();
                              }}
                              aria-pressed={p.id === selected}
                            >
                              <span className={'player-number team-' + team}>
                                {data.players.indexOf(p) + 1}
                              </span>
                              <span className="player-identity">
                                <strong>{p.name}</strong>
                                <small>
                                  {state?.weapon?.replace('weapon_', '').replaceAll('_', ' ') ||
                                    t('No weapon')}
                                  {state?.ammo !== undefined
                                    ? t(' · {{v0}}', { v0: state.ammo })
                                    : ''}
                                </small>
                                {state?.money !== undefined && (
                                  <small>
                                    ${state.money.toLocaleString(locale())} · {state.armor ?? 0}{' '}
                                    {t('armor')}
                                  </small>
                                )}
                              </span>
                              <span className={'health num ' + (!state?.alive ? 'dead' : '')}>
                                {state?.alive ? state.health : '—'}
                                <small>{state?.alive ? t('HP') : t('Out')}</small>
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    );
                  })}
                  <div className="roster-foot">
                    {t('Select a player, then choose player perspective.')}
                  </div>
                </div>
              ) : (
                <>
                  {' '}
                  {showNote && (
                    <form
                      className="note-form"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void saveNote();
                      }}
                    >
                      <label>
                        {t('Note at')} {clock((tick - first) / rate)}
                        <input
                          autoFocus
                          value={label}
                          onChange={(e) => setLabel(e.target.value)}
                          maxLength={100}
                          placeholder={t('What happened here?')}
                          required
                        />
                      </label>
                      <button className="button primary" disabled={busy}>
                        {t('Save note')}
                      </button>
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => setShowNote(false)}
                      >
                        {t('Cancel')}
                      </button>
                    </form>
                  )}{' '}
                  <section className="event-panel">
                    <div className="tabs">
                      <button
                        className={tab === 'events' ? 'active' : ''}
                        onClick={() => setTab('events')}
                      >
                        {t('Key moments')} <span>{allReviewEvents.length}</span>
                      </button>
                      <button
                        className={tab === 'notes' ? 'active' : ''}
                        onClick={() => setTab('notes')}
                      >
                        {t('Your notes')} <span>{bookmarks.length}</span>
                      </button>
                    </div>
                    {tab === 'events' ? (
                      <RoundEventReview
                        key={eventReviewKey}
                        data={data}
                        round={reviewRound}
                        tick={tick}
                        selected={selected}
                        first={first}
                        last={last}
                        onSeek={seekEvent}
                      />
                    ) : bookmarks.length ? (
                      <div className="event-list">
                        {bookmarks.map((b) => (
                          <div className="note-row" key={b.id}>
                            <button className="event-row" onClick={() => seek(b.tick)}>
                              <span className="num event-time">
                                {clock((b.tick - first) / rate)}
                              </span>
                              <span>{b.label}</span>
                            </button>
                            <button
                              className="icon-button"
                              aria-label={t('Delete note ') + b.label}
                              onClick={() => void removeNote(b.id)}
                            >
                              <Trash2 size={15} />
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="panel-empty">
                        {t('Save a moment with “Add note”.')}{' '}
                        {data.sample
                          ? t('Sample notes last for this visit.')
                          : t('Your notes stay private.')}
                      </p>
                    )}
                  </section>
                </>
              )}
            </div>
          </aside>
        )}
        <ReviewHud
          data={data}
          frame={frame}
          selected={selected}
          settings={settings}
          hidden={Boolean(panel)}
          onSelect={setSelected}
          onCloseInputs={() => {
            setSettings((value) => ({ ...value, inputs: false }));
            optionsTrigger.current?.focus();
          }}
        />
        <ObjectiveHud data={data} tick={tick} hidden={Boolean(panel)} />
        <div
          ref={playbackDock}
          inert={Boolean(panel) && compactPanels}
          className={'viewer-dock' + (roundsOpen ? ' rounds-visible' : '')}
          role="region"
          aria-label={t('Playback controls')}
        >
          <ReplayTimeline
            data={data}
            tick={tick}
            first={first}
            last={last}
            round={reviewRound}
            selected={selected}
            onSeek={seekEvent}
            onReview={openRoundReview}
          />
          <div className="viewer-controlbar">
            <div className="viewer-transport">
              <button
                className="icon-button transport-step"
                aria-label={t('Rewind five seconds')}
                onClick={() => seek(tick - rate * 5)}
              >
                <SkipBack size={18} />
              </button>
              <button
                className="play-button"
                aria-label={playing ? t('Pause') : t('Play')}
                onClick={() => {
                  if (tick >= last) seek(first);
                  setPlaying(!playing);
                }}
              >
                {playing ? <Pause size={18} /> : <Play size={18} fill="currentColor" />}
              </button>
              <button
                className="icon-button transport-step"
                aria-label={t('Forward five seconds')}
                onClick={() => seek(tick + rate * 5)}
              >
                <SkipForward size={18} />
              </button>
              <SelectControl
                label={t('Playback speed')}
                className="speed-select"
                value={String(speed)}
                onValueChange={(value) => setSpeed(Number(value))}
                options={[0.25, 0.5, 1, 2, 4].map((value) => ({
                  value: String(value),
                  label: value + '×',
                }))}
              />
            </div>
            <div className="viewer-round-controls">
              <SelectControl
                label={t('Round')}
                className="round-select"
                value={String(round?.number ?? data.rounds[0]?.number ?? '')}
                disabled={!data.rounds.length}
                onValueChange={(value) => {
                  const r = data.rounds.find((r) => r.number === Number(value));
                  if (r) seek(r.tick);
                }}
                options={data.rounds.map((r) => ({
                  value: String(r.number),
                  label: t('Round') + ' ' + r.number,
                }))}
              />
              <button
                className="icon-button"
                aria-label={t('Next live round')}
                title={t('Next live round')}
                onClick={() => {
                  const next = data.rounds.find((r) => (r.liveTick ?? r.tick) > tick);
                  if (next) seek(next.liveTick ?? next.tick);
                  else notify('You are in the last recorded round.');
                }}
              >
                <SkipForward size={17} />
              </button>
              <button
                className="button skip-dead-time"
                aria-label={t('Skip dead time')}
                title={t('Skip dead time')}
                onClick={() => {
                  const target = skipDeadTime(data, tick, 'all', last);
                  if (target === tick) notify('No freeze period or timeout at this position.');
                  else seek(target);
                }}
              >
                <FastForward size={16} />
                <span>{t('Skip dead time')}</span>
              </button>
              <button
                className="button mobile-rounds-toggle"
                aria-expanded={roundsOpen}
                onClick={() => setRoundsOpen((v) => !v)}
              >
                {t('Rounds')}
              </button>
            </div>
            <div className="viewer-panel-controls">
              <button
                className="icon-button"
                aria-label={t('Players')}
                title={t('Players')}
                aria-expanded={panel === 'players'}
                onClick={(e) => togglePanel('players', e.currentTarget)}
              >
                <Users size={19} />
              </button>
              <button
                className="icon-button"
                aria-label={t('Key moments')}
                title={t('Key moments')}
                aria-expanded={panel === 'review' && tab === 'events'}
                onClick={(e) => {
                  setTab('events');
                  if (panel === 'review' && tab !== 'events') return;
                  togglePanel('review', e.currentTarget);
                }}
              >
                <ListVideo size={19} />
              </button>
              <button
                className="icon-button desktop-viewer-action"
                aria-label={t('Add note')}
                title={t('Add note')}
                onClick={(event) => openNote(event.currentTarget)}
              >
                <BookmarkPlus size={19} />
              </button>
              <button
                className="icon-button desktop-viewer-action"
                aria-label={t('Toggle fullscreen')}
                onClick={() => void toggleFull()}
              >
                <Expand size={19} />
              </button>
              <ActionMenu
                label={t('Viewer controls')}
                onOpenChange={(open) => {
                  if (open) eventMenuTrigger.current = mobileMoreTrigger.current;
                }}
                trigger={
                  <button
                    ref={mobileMoreTrigger}
                    className="icon-button mobile-viewer-menu"
                    aria-label={t('More controls')}
                  >
                    <MoreHorizontal size={20} />
                  </button>
                }
                items={[
                  {
                    id: 'add-note',
                    label: t('Add note'),
                    icon: <BookmarkPlus size={16} />,
                    onSelect: () => openNote(mobileMoreTrigger.current),
                  },
                  {
                    id: 'rewind',
                    label: t('Rewind five seconds'),
                    icon: <SkipBack size={16} />,
                    onSelect: () => seek(tick - rate * 5),
                  },
                  {
                    id: 'forward',
                    label: t('Forward five seconds'),
                    icon: <SkipForward size={16} />,
                    onSelect: () => seek(tick + rate * 5),
                  },
                  {
                    id: 'fullscreen',
                    label: t('Toggle fullscreen'),
                    icon: <Expand size={16} />,
                    onSelect: () => void toggleFull(),
                  },
                  ...momentActions.map((action, index) => ({
                    ...action,
                    separatorBefore: index === 0 || action.separatorBefore,
                  })),
                ]}
              />
              <button
                className="button rounds-toggle"
                aria-expanded={roundsOpen}
                onClick={() => setRoundsOpen((v) => !v)}
              >
                {t('Rounds')}
              </button>
            </div>
          </div>
          <div className="viewer-review-rails">
            {roundsOpen && (
              <div className="viewer-rounds-rail" role="region" aria-label={t('Round timeline')}>
                <div className="round-strip">
                  {data.rounds.map((r) => (
                    <button
                      key={r.number}
                      aria-current={round?.number === r.number ? 'step' : undefined}
                      className={round?.number === r.number ? 'active' : ''}
                      onClick={() => seek(r.tick)}
                      aria-label={t('Jump to round ') + r.number}
                    >
                      <span>{String(r.number).padStart(2, '0')}</span>
                      <i />
                    </button>
                  ))}
                </div>
                <ActionMenu
                  label={t('More navigation')}
                  className="moment-menu"
                  onOpenChange={(open) => {
                    if (open) eventMenuTrigger.current = momentMenuTrigger.current;
                  }}
                  trigger={
                    <button
                      ref={momentMenuTrigger}
                      className="moment-menu-trigger desktop-moment-menu"
                    >
                      {t('More navigation')}
                      <ChevronDown size={14} />
                    </button>
                  }
                  items={momentActions}
                />
              </div>
            )}
          </div>
        </div>
        {!panel && !settings.inputs && !settings.economy && (
          <p className="viewer-hint">
            {mode === 'orbit'
              ? t('Drag to orbit · pinch or scroll to zoom')
              : mode === 'pov'
                ? t('Select a player to follow their view')
                : t('Overhead position view')}
          </p>
        )}
      </div>
      {manage && demo && (
        <ManageDemo demo={demo} onChange={setDemo} close={() => setManage(false)} />
      )}
      {options && (
        <ViewerOptions
          settings={settings}
          onChange={setSettings}
          close={() => setOptions(false)}
          openCommunications={() => {
            communicationsTrigger.current = optionsTrigger.current;
            setOptions(false);
            setCommunicationsOpen(true);
          }}
        />
      )}
      <Communications
        id={id || ''}
        owned={Boolean(demo?.owned)}
        data={data}
        tick={tick}
        first={first}
        playing={playing}
        speed={speed}
        selected={selected}
        settings={settings}
        onChange={setSettings}
        open={communicationsOpen}
        close={() => setCommunicationsOpen(false)}
        onSeek={(value) => {
          seek(value);
          setPlaying(false);
        }}
      />
    </div>
  );
}
