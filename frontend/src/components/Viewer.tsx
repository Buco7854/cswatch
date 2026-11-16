import i18n, { t, locale, setLanguage, type Language } from '../i18n';
import Brand from './Brand';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
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
} from 'lucide-react';
import { api } from '../api';
import { sample } from '../sample';
import { useApp } from '../context';
import type { Bookmark, Demo, Playback } from '../types';
import { frameAt, readSettings, skipDeadTime } from '../playback';
import ViewerOptions from './ViewerOptions';
import TacticalPlot from './TacticalPlot';
import ManageDemo from './ManageDemo';
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
  const [data, setData] = useState<Playback | null>(id === 'sample' ? sample : null),
    [demo, setDemo] = useState<Demo | null>(null),
    [error, setError] = useState(''),
    [playing, setPlaying] = useState(false),
    [tick, setTick] = useState(0),
    [speed, setSpeed] = useState(1),
    [mode, setMode] = useState('orbit'),
    [selected, setSelected] = useState('0'),
    [tab, setTab] = useState('events'),
    [bookmarks, setBookmarks] = useState<Bookmark[]>([]),
    [label, setLabel] = useState(''),
    [showNote, setShowNote] = useState(false),
    [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState(readSettings),
    [options, setOptions] = useState(false),
    [manage, setManage] = useState(false);
  useEffect(() => {
    localStorage.setItem('viewer-settings', JSON.stringify(settings));
  }, [settings]);
  const [panel, setPanel] = useState<'players' | 'review' | null>(null);
  const [roundsOpen, setRoundsOpen] = useState(true);
  const panelClose = useRef<HTMLButtonElement>(null);
  const panelTrigger = useRef<HTMLElement | null>(null);
  const full = useRef<HTMLDivElement>(null);
  function closePanel() {
    setPanel(null);
    panelTrigger.current?.focus();
  }
  function togglePanel(next: 'players' | 'review', trigger: HTMLElement) {
    panelTrigger.current = trigger;
    if (panel === next) closePanel();
    else setPanel(next);
  }
  useEffect(() => {
    if (panel) panelClose.current?.focus();
  }, [panel]);
  useEffect(() => {
    function escape(e: KeyboardEvent) {
      if (e.key === 'Escape' && panel && !document.querySelector('dialog[open]')) closePanel();
    }
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [panel]);
  const timeRef = useRef<number | null>(null);
  useEffect(() => {
    let disposed = false,
      timer: ReturnType<typeof setTimeout>;
    setData(id === 'sample' ? sample : null);
    setError('');
    setPlaying(false);
    setDemo(null);
    setBookmarks([]);
    async function load() {
      try {
        const d = await api<Demo>('/api/demos/' + id);
        if (disposed) return;
        setDemo(d);
        if (d.status === 'ready') {
          const p = await api<Playback>('/api/demos/' + id + '/playback');
          if (disposed) return;
          setData(p);
          setTick(p.frames[0].tick);
          setSelected(p.players[0]?.id ?? '');
        } else if (d.status !== 'failed') timer = setTimeout(load, 3000);
      } catch (e) {
        if (!disposed) setError((e as Error).message);
      }
    }
    if (id !== 'sample') void load();
    else {
      setTick(400);
      setSelected('0');
    }
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [id]);
  useEffect(() => {
    if (id !== 'sample' && user)
      api<Bookmark[]>('/api/demos/' + id + '/bookmarks')
        .then(setBookmarks)
        .catch(() => {});
  }, [id, user?.id]);
  const first = data?.frames[0].tick ?? 0,
    last = data?.frames.at(-1)?.tick ?? 0,
    rate = data?.tickRate ?? 64;
  const seek = useCallback(
    (value: number) => {
      setTick(Math.max(first, Math.min(last, value)));
    },
    [first, last],
  );
  useEffect(() => {
    if (!playing || !data) {
      timeRef.current = null;
      return;
    }
    let frame = 0;
    const animate = (now: number) => {
      const dt = timeRef.current === null ? 0 : Math.min((now - timeRef.current) / 1000, 0.1);
      timeRef.current = now;
      setTick((t) => {
        const proposed = t + dt * rate * speed;
        const next = settings.autoSkip ? skipDeadTime(data, proposed) : proposed;
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
  }, [playing, data, rate, speed, last, settings.autoSkip]);
  useEffect(() => {
    function keys(e: KeyboardEvent) {
      if ((e.target as HTMLElement).closest('input,select,textarea,button,a,dialog')) return;
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
        setBookmarks((bs) => [...bs, b].sort((a, b) => a.tick - b.tick));
      }
      setLabel('');
      setShowNote(false);
      setTab('notes');
      setPanel('review');
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function removeNote(bid: string) {
    try {
      if (id !== 'sample') await api('/api/bookmarks/' + bid, { method: 'DELETE' });
      setBookmarks((bs) => bs.filter((b) => b.id !== bid));
    } catch (e) {
      notify((e as Error).message);
    }
  }
  async function share() {
    if (!demo?.owned) return;
    const publish = !demo.public;
    if (
      publish &&
      !window.confirm(
        t(
          config.public_access
            ? 'Make this demo public? Anyone with the link can watch it, and it will appear in Community.'
            : 'Make this demo available to instance members? They must sign in to watch it. Personal notes stay private.',
        ),
      )
    )
      return;
    try {
      await api('/api/demos/' + id, { method: 'PATCH', body: JSON.stringify({ public: publish }) });
      setDemo({ ...demo, public: publish });
      if (publish) {
        await navigator.clipboard?.writeText(window.location.href).catch(() => {});
        notify(
          t(
            config.public_access
              ? 'Demo is public. Link copied if clipboard is available.'
              : 'Demo shared with members. Link copied if clipboard is available.',
          ),
        );
      } else notify(t('Demo is private.'));
    } catch (e) {
      notify((e as Error).message);
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
  const { frame } = frameAt(data, tick);
  const round = data.rounds.filter((r) => r.tick <= tick).at(-1);
  const events = data.events.filter((e) => e.type === 'player_death' || e.type.startsWith('bomb_'));
  return (
    <div className="viewer-frame" ref={full}>
      <header className="viewer-titlebar" role="banner">
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
          <select
            aria-label={t('Language')}
            value={i18n.language}
            onChange={(e) => setLanguage(e.target.value as Language)}
          >
            <option value="en">EN</option>
            <option value="fr">FR</option>
          </select>
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
        </div>
      </header>
      <div className="viewer-surface">
        <div className="viewer-stage">
          <Suspense fallback={<div className="scene-fallback">{t('Starting renderer…')}</div>}>
            <Scene data={data} tick={tick} mode={mode} selected={selected} settings={settings} />
          </Suspense>
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
        <div className="viewer-scene-tools">
          <div className="viewer-context">
            <span className="status-dot" />
            {t('Round')} {round?.number ?? 1}
            <span>
              {data.deadTimes?.some((s) => tick >= s.start && tick < s.end)
                ? t(data.deadTimes.find((s) => tick >= s.start && tick < s.end)?.kind || '')
                : t('Live playback')}
            </span>
          </div>
          <div className="viewer-camera-tools">
            <label className="camera-label">
              <Eye size={16} />
              <select
                aria-label={t('Camera mode')}
                value={mode}
                onChange={(e) => setMode(e.target.value)}
              >
                <option value="orbit">{t('Free camera')}</option>
                <option value="tactical">{t('Overhead')}</option>
                <option value="2d">{t('2D tactical · low power')}</option>
                <option value="pov">{t('Player perspective')}</option>
              </select>
            </label>
            <button
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
            className="viewer-drawer"
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
                        {t('Key moments')} <span>{events.length}</span>
                      </button>
                      <button
                        className={tab === 'notes' ? 'active' : ''}
                        onClick={() => setTab('notes')}
                      >
                        {t('Your notes')} <span>{bookmarks.length}</span>
                      </button>
                    </div>
                    {tab === 'events' ? (
                      events.length ? (
                        <div className="event-list">
                          {events.slice(0, 200).map((e, i) => (
                            <button key={i} className="event-row" onClick={() => seek(e.tick)}>
                              <span className="num event-time">
                                {clock((e.tick - first) / rate)}
                              </span>
                              <span>
                                {e.type === 'player_death' ? (
                                  <>
                                    <strong>{e.attacker_name || t('World')}</strong>
                                    <span className="muted"> {e.weapon || t('eliminated')} </span>
                                    {e.user_name || t('a player')}
                                  </>
                                ) : (
                                  t(e.type.replaceAll('_', ' '))
                                )}
                              </span>
                              <Play size={14} />
                            </button>
                          ))}
                          {events.length > 200 && (
                            <p className="muted">
                              {t(
                                'First 200 key moments shown. Use the timeline to explore the entire match.',
                              )}
                            </p>
                          )}
                        </div>
                      ) : (
                        <p className="panel-empty">
                          {t('No elimination or bomb events in this demo.')}
                        </p>
                      )
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
        <div
          className={'viewer-dock' + (roundsOpen ? ' rounds-visible' : '')}
          role="region"
          aria-label={t('Playback controls')}
        >
          <div className="scrubber">
            <span className="num">{clock((tick - first) / rate)}</span>
            <input
              aria-label={t('Playback position')}
              type="range"
              min={first}
              max={last}
              step={1}
              value={Math.round(tick)}
              onChange={(e) => seek(Number(e.target.value))}
            />
            <span className="num">{clock((last - first) / rate)}</span>
          </div>
          <div className="viewer-controlbar">
            <div className="viewer-transport">
              <button
                className="icon-button"
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
                className="icon-button"
                aria-label={t('Forward five seconds')}
                onClick={() => seek(tick + rate * 5)}
              >
                <SkipForward size={18} />
              </button>
              <select
                aria-label={t('Playback speed')}
                value={speed}
                onChange={(e) => setSpeed(Number(e.target.value))}
              >
                {[0.25, 0.5, 1, 2, 4].map((s) => (
                  <option key={s} value={s}>
                    {s}×
                  </option>
                ))}
              </select>
            </div>
            <div className="viewer-round-controls">
              <select
                aria-label={t('Round')}
                value={round?.number ?? data.rounds[0].number}
                onChange={(e) => {
                  const r = data.rounds.find((r) => r.number === Number(e.target.value));
                  if (r) seek(r.tick);
                }}
              >
                {data.rounds.map((r) => (
                  <option key={r.number} value={r.number}>
                    {t('Round')} {r.number}
                  </option>
                ))}
              </select>
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
                onClick={() => {
                  const target = skipDeadTime(data, tick);
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
                className="icon-button"
                aria-label={t('Add note')}
                title={t('Add note')}
                onClick={(e) => {
                  panelTrigger.current = e.currentTarget;
                  setPlaying(false);
                  setTab('notes');
                  setShowNote(true);
                  setPanel('review');
                }}
              >
                <BookmarkPlus size={19} />
              </button>
              <button
                className="icon-button"
                aria-label={t('Toggle fullscreen')}
                onClick={() => void toggleFull()}
              >
                <Expand size={19} />
              </button>
              <button
                className="button rounds-toggle"
                aria-expanded={roundsOpen}
                onClick={() => setRoundsOpen((v) => !v)}
              >
                {t('Rounds')}
              </button>
            </div>
          </div>
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
              <details className="moment-navigation">
                <summary>{t('More navigation')}</summary>{' '}
                <div className="actions">
                  <button
                    className="button"
                    onClick={() => {
                      const target = skipDeadTime(data, tick, 'timeout');
                      if (target === tick)
                        notify('No tactical or technical timeout at this position.');
                      else seek(target);
                    }}
                  >
                    {t('Skip timeout')}
                  </button>
                  <button
                    className="button"
                    onClick={() => {
                      const e = data.events.find(
                        (e) =>
                          e.type === 'player_death' &&
                          e.tick > tick &&
                          String(e.attacker_steamid) === selected,
                      );
                      if (e) seek(Math.max(first, e.tick - rate * 3));
                      else notify('No later elimination by this player.');
                    }}
                  >
                    {t('Next player kill')}
                  </button>
                  <button
                    className="button"
                    onClick={() => {
                      const e = data.events.find(
                        (e) =>
                          e.type === 'player_death' &&
                          e.tick > tick &&
                          String(e.user_steamid) === selected,
                      );
                      if (e) seek(Math.max(first, e.tick - rate * 3));
                      else notify('No later death for this player.');
                    }}
                  >
                    {t('Next player death')}
                  </button>
                  <button
                    className="button"
                    onClick={() => {
                      setPlaying(false);
                      seek(tick - 4);
                    }}
                  >
                    {t('Previous sample')}
                  </button>
                  <button
                    className="button"
                    onClick={() => {
                      setPlaying(false);
                      seek(tick + 4);
                    }}
                  >
                    {t('Next sample')}
                  </button>
                </div>
              </details>
            </div>
          )}
        </div>
        {!panel && (
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
        <ViewerOptions settings={settings} onChange={setSettings} close={() => setOptions(false)} />
      )}
    </div>
  );
}
