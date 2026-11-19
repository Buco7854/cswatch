import { PlaybackClock } from '../playback-clock';
import { useViewerAudio, type ListenerPose } from '../viewer-audio';
import { useGameplayAudio } from '../useGameplayAudio';
import { captureFocusReturn, focusMovedSince, type FocusReturnContext } from '../focus-return';
import i18n, { t, setLanguage } from '../i18n';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
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
  ScanLine,
  X,
  Sun,
  Moon,
  ChevronDown,
  MoreHorizontal,
  MapPin,
} from 'lucide-react';
import { api } from '../api';
import { useReplay } from '../useReplay';
import { useViewerChrome } from '../useViewerChrome';
import { useReviewLayout } from '../useReviewLayout';
import { useApp } from '../context';
import type { Bookmark } from '../types';
import { frameAt, skipDeadTime } from '../playback';
import { useViewerPreferences } from '../viewer-device';
import { typingOrDialog } from '../free-camera';
import { roundAt, roundEvents } from '../review-events';
import { RoundEventReview } from './RoundEvents';
import ReplayTimeline from './ReplayTimeline';
import ObjectiveHud, {
  ObjectiveContext,
  ObjectiveAnnouncement,
  objectiveDescription,
} from './ObjectiveHud';
import { buildObjectiveTimeline, objectiveAt } from '../objective-state';
import ReviewHud from './ReviewHud';
import ReviewActions, { type ReviewAction } from './ReviewActions';
import ReviewEventGlyph from './ReviewEventGlyph';
import EquipmentGlyph from './EquipmentGlyph';
import { equipmentName } from '../equipment-display';
import './kill-feed.css';
import type { LandingPrompt, ThrowPrompt } from '../review-prompts';
import {
  buildReviewMoments,
  recentReviewMoment,
  indexThrowInputs,
  throwInputAt,
  type CombatMoment,
} from '../review-moments';
import MatchScore from './MatchScore';
import Scoreboard from './Scoreboard';
import ReviewFeed, { type ReviewFeedTab } from './ReviewFeed';
import ThrowInputBadges from './ThrowInputBadges';
import type { SceneFocus, MapRenderState } from './Scene';
import type { AssetStatus } from '../map-assets';
import { useDemoMapAssets } from '../useDemoMapAssets';
import { mapAcquisitionMessage } from '../demo-map-assets';
import PlayerPicker from './PlayerPicker';
import RecordedCrosshair from './RecordedCrosshair';
import { buildRecordedCrosshairTimeline, recordedCrosshairAt } from '../recorded-crosshair';
import CombatRecap from './CombatRecap';
import { combatDamage } from '../combat-recap';
import { damageFeedbackAt, DeathFollowController, indexSpectatorEvents } from '../spectator-state';
import DamageFeedback from './DamageFeedback';
import Communications from './Communications';
import ViewerOptions from './ViewerOptions';
import Crosshair from './Crosshair';
import TacticalPlot from './TacticalPlot';
import ManageDemo from './ManageDemo';
import AccountMenu from './AccountMenu';
import { ActionMenu, SelectControl, type MenuAction } from './Controls';
import { useConfirm } from './Confirmation';
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
  const audioIdentity = `${id || ''}:${user?.id || ''}`;
  const audio = useViewerAudio(audioIdentity);
  const audioCameraReady = useRef(false);
  const cameraAudio = useCallback(
    (pose: ListenerPose | null) => {
      audioCameraReady.current = Boolean(pose);
      if (pose) audio.setListener(pose);
    },
    [audio],
  );
  const confirm = useConfirm();
  const [cameraNotice, setCameraNotice] = useState(false);
  const cameraNoticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(cameraNoticeTimer.current), []);
  function cueCameraChange() {
    clearTimeout(cameraNoticeTimer.current);
    setCameraNotice(true);
    cameraNoticeTimer.current = setTimeout(() => setCameraNotice(false), 900);
  }
  function selectPlayer(playerId: string, dismissPicker = false) {
    if (!data?.players.some((player) => player.id === playerId)) return;
    deathFollow.current.reset();
    setSelected(playerId);
    setGrenadeFocus(undefined);
    setMode('pov');
    cueCameraChange();
    if (dismissPicker) closePanel();
  }
  const previous = location.state?.from;
  const backTo =
    typeof previous === 'string' && ['/', '/library'].includes(previous)
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
  const {
    data,
    demo,
    setDemo,
    error,
    chunkError,
    buffering,
    first,
    last,
    retryChunk,
    availableUntil,
  } = useReplay(
    id,
    tick,
    (replay, initialTick) => {
      playbackClock.current.reset(initialTick, performance.now());
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
  const mapAssets = useDemoMapAssets(
    data && !data.sample ? id : undefined,
    data && !data.sample ? data.map : undefined,
    user?.id,
  );
  const acquisitionNotice = mapAcquisitionMessage(mapAssets);
  const [mapRender, setMapRender] = useState<MapRenderState>();
  const using2D =
    mode === '2d' ||
    Boolean(mapRender && mapRender.map === data?.map && mapRender.renderer === '2d');
  const mapStatus: AssetStatus =
    mapAssets.status === 'pending'
      ? 'pending'
      : mapAssets.status === 'error'
        ? 'error'
        : using2D
          ? mapAssets.overviewStatus
          : mapRender && mapRender.map === data?.map
            ? mapRender.model
            : mapAssets.assets.model || mapAssets.assets.mobile
              ? 'pending'
              : 'missing';
  const environmentStatus: AssetStatus = mapAssets.assets.environment
    ? mapRender?.map === data?.map &&
      mapRender?.environmentVersion === mapAssets.assets.environment.assetVersion
      ? mapRender.environment
      : 'pending'
    : 'missing';
  const mapNoticeStatus =
    !using2D &&
    mapStatus === 'ready' &&
    (environmentStatus === 'pending' || environmentStatus === 'error')
      ? environmentStatus
      : mapStatus;
  const mapStatusText =
    acquisitionNotice && mapAssets.status !== 'ready'
      ? acquisitionNotice.title
      : using2D
        ? mapStatus === 'ready'
          ? mode === '2d'
            ? 'Map overview'
            : mapRender?.failure === 'webgl'
              ? '2D map · 3D unavailable'
              : mapRender?.failure === 'model'
                ? '2D map · 3D failed'
                : '2D map fallback'
          : mapStatus === 'pending'
            ? 'Loading map overview…'
            : mapStatus === 'error'
              ? 'Map overview failed to load'
              : 'Map unavailable'
        : mapStatus === 'ready'
          ? environmentStatus === 'pending'
            ? '3D map · loading sky…'
            : environmentStatus === 'error'
              ? '3D map · sky unavailable'
              : '3D map'
          : mapStatus === 'pending'
            ? 'Loading 3D map…'
            : mapStatus === 'error'
              ? '3D map failed to load'
              : 'Map unavailable';
  const allReviewEvents = useMemo(
    () => (data ? roundEvents(data, { number: 0, start: first, end: last }, selected) : []),
    [data, first, last, selected],
  );
  const { settings, setSettings } = useViewerPreferences();
  useEffect(() => {
    audio.setMaster(settings.audioVolume, settings.audioMuted);
  }, [audio, settings.audioVolume, settings.audioMuted]);
  const gameAudio = useGameplayAudio({
    identity: audioIdentity,
    audio,
    data,
    tick,
    playing: playing && !buffering,
    speed,
    selected,
    mode,
    settings,
    cameraReady: audioCameraReady,
  });
  const enableAudio = useCallback(() => {
    if ((settings.gameSounds || settings.voice) && !settings.audioMuted) void audio.unlock();
  }, [audio, settings.gameSounds, settings.voice, settings.audioMuted]);
  const [options, setOptions] = useState(false),
    [manage, setManage] = useState(false);
  const [communicationsOpen, setCommunicationsOpen] = useState(false);
  const [timelineOptionsOpen, setTimelineOptionsOpen] = useState(false);
  const [timelineScope, setTimelineScope] = useState<'match' | 'round'>('match');
  const [scoreboardOpen, setScoreboardOpen] = useState(false);
  const [feedTab, setFeedTab] = useState<ReviewFeedTab>('kills');
  const scoreboardHeld = useRef(false);
  const scoreboardTrigger = useRef<HTMLElement | null>(null);
  const [grenadeFocus, setGrenadeFocus] = useState<SceneFocus>();
  const focusSequence = useRef(0);
  const reviewIndex = useMemo(
    () => (data ? buildReviewMoments(data, first, last) : null),
    [data?.events, data?.players, data?.rounds, data?.tickRate, data?.sample, first, last],
  );
  const throwInputs = useMemo(
    () => (data ? indexThrowInputs(data) : new Map()),
    [data?.throwInputs],
  );
  const objectiveTimeline = useMemo(
    () => (data ? buildObjectiveTimeline(data) : null),
    [data?.events, data?.objectives, data?.rounds, data?.players, data?.tickRate],
  );
  const crosshairTimeline = useMemo(
    () => buildRecordedCrosshairTimeline(data),
    [data?.crosshairs, data?.players],
  );
  const objective =
    !buffering && objectiveTimeline ? objectiveAt(objectiveTimeline, tick) : undefined;
  const recentMoment = reviewIndex
    ? recentReviewMoment(reviewIndex, tick, selected, {
        kills: settings.killReplay,
        utilities: settings.grenadeLanding,
      })
    : null;
  const recapDamage = useMemo(
    () =>
      data && recentMoment?.kind === 'combat'
        ? combatDamage(data, recentMoment, selected, last)
        : undefined,
    [
      data?.events,
      data?.rounds,
      data?.players,
      data?.eventAvailability,
      recentMoment?.id,
      selected,
      last,
    ],
  );
  const communicationsTrigger = useRef<HTMLElement | null>(null);
  const communicationsWasOpen = useRef(false);
  useEffect(() => {
    if (communicationsOpen) communicationsWasOpen.current = true;
    else if (communicationsWasOpen.current) {
      communicationsWasOpen.current = false;
      queueMicrotask(() => restoreViewerFocus(communicationsTrigger.current));
    }
  }, [communicationsOpen]);
  const [panel, setPanel] = useState<'players' | 'review' | null>(null);
  const showReviewFeed =
    settings.reviewFeed &&
    !panel &&
    !buffering &&
    !options &&
    !manage &&
    !communicationsOpen &&
    !timelineOptionsOpen &&
    !scoreboardOpen;
  const mutationScope = useRef({ active: true });
  const [roundsOpen, setRoundsOpen] = useState(false);
  const [eventReviewKey, setEventReviewKey] = useState(0);
  const panelClose = useRef<HTMLButtonElement>(null);
  const panelTrigger = useRef<HTMLElement | null>(null);
  const panelWasOpen = useRef(false);
  const full = useRef<HTMLDivElement>(null);
  useReviewLayout(full, Boolean(data));
  const playbackDock = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const playTrigger = useRef<HTMLButtonElement>(null);
  const mobileMoreTrigger = useRef<HTMLButtonElement>(null);
  const momentMenuTrigger = useRef<HTMLButtonElement>(null);
  const eventMenuTrigger = useRef<HTMLElement | null>(null);
  const optionsTrigger = useRef<HTMLButtonElement>(null);
  const panelElement = useRef<HTMLElement>(null);
  const setControlsHidden = useCallback(
    (controlsHidden: boolean) =>
      setSettings((value) =>
        value.controlsHidden === controlsHidden ? value : { ...value, controlsHidden },
      ),
    [],
  );
  const chrome = useViewerChrome({
    frame: full,
    stage,
    hidden: settings.controlsHidden,
    setHidden: setControlsHidden,
    playing,
    autoHide: settings.autoHideControls,
    blocked:
      Boolean(panel) ||
      options ||
      manage ||
      communicationsOpen ||
      timelineOptionsOpen ||
      scoreboardOpen ||
      settings.reviewFeed ||
      roundsOpen ||
      buffering,
    ready: Boolean(data),
  });
  function restoreViewerFocus(preferred: HTMLElement | null, context?: FocusReturnContext) {
    if (context && focusMovedSince(context)) return;
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
  function closeViewerOptions() {
    const focusReturn = captureFocusReturn();
    setOptions(false);
    // React removes the native dialog before its normal close algorithm can
    // restore the opener. Wait for teardown and never steal another modal's focus.
    requestAnimationFrame(() => {
      if (
        !full.current?.isConnected ||
        document.querySelector('dialog[open]:not(.review-feed-inline)')
      )
        return;
      restoreViewerFocus(optionsTrigger.current, focusReturn);
    });
  }
  function openScoreboard(trigger: HTMLElement | null, held = false) {
    scoreboardHeld.current = held;
    scoreboardTrigger.current = trigger;
    setScoreboardOpen(true);
    chrome.show();
  }
  function closeScoreboard() {
    const focusReturn = captureFocusReturn();
    const held = scoreboardHeld.current;
    scoreboardHeld.current = false;
    setScoreboardOpen(false);
    requestAnimationFrame(() => {
      if (
        !full.current?.isConnected ||
        document.querySelector('dialog[open]:not(.review-feed-inline)')
      )
        return;
      if (held && scoreboardTrigger.current === stage.current)
        restoreViewerFocus(stage.current, focusReturn);
      else restoreViewerFocus(scoreboardTrigger.current, focusReturn);
    });
  }
  function closeReviewFeed() {
    const focusReturn = captureFocusReturn();
    setSettings((value) => ({ ...value, reviewFeed: false }));
    requestAnimationFrame(() => restoreViewerFocus(optionsTrigger.current, focusReturn));
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
    const update = () => {
      const frame = full.current;
      if (!frame) return;
      // Reserve the deck and its bottom inset, including an inset floating deck.
      frame.style.setProperty(
        '--viewer-dock-height',
        `${chrome.visible ? Math.max(0, frame.getBoundingClientRect().bottom - dock.getBoundingClientRect().top) : 0}px`,
      );
    };
    update();
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(update);
      observer.observe(dock);
      return () => observer.disconnect();
    }
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [Boolean(data), chrome.visible]);
  useEffect(() => {
    if (chrome.visible) return;
    // A closing native dialog may return focus after this commit. Wait for its
    // teardown before handing focus to the scene rather than an inert trigger.
    const handoff = requestAnimationFrame(() => {
      if (!document.querySelector('dialog[open]:not(.review-feed-inline),[aria-modal="true"]'))
        stage.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(handoff);
  }, [Boolean(data), chrome.visible]);
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
        !document.querySelector('dialog[open]:not(.review-feed-inline)') &&
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
        !document.querySelector('dialog[open]:not(.review-feed-inline)')
      )
        closePanel();
    }
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [panel, compactPanels]);
  const playbackClock = useRef(new PlaybackClock());
  const deathFollow = useRef(new DeathFollowController());
  const spectatorEvents = useMemo(
    () => (data ? indexSpectatorEvents(data) : undefined),
    [data?.events, data?.players, data?.sample],
  );
  const currentTick = useRef(tick);
  currentTick.current = tick;
  const playbackState = useRef({ data, availableUntil, autoSkip: settings.autoSkip });
  playbackState.current = { data, availableUntil, autoSkip: settings.autoSkip };
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
    setTimelineOptionsOpen(false);
    setScoreboardOpen(false);
    scoreboardHeld.current = false;
    setGrenadeFocus(undefined);
    return () => {
      scope.active = false;
    };
  }, [id, user?.id]);
  useEffect(() => {
    const controller = new AbortController();
    if (id !== 'sample') setBookmarks([]);
    if (id !== 'sample' && user && demo && !demo.guest_owned)
      api<Bookmark[]>('/api/demos/' + id + '/bookmarks', { signal: controller.signal })
        .then((notes) => {
          if (!controller.signal.aborted) setBookmarks(notes);
        })
        .catch(() => {});
    return () => controller.abort();
  }, [id, user?.id, demo?.id, demo?.guest_owned]);
  const rate = data?.tickRate ?? 64;
  const seek = useCallback(
    (value: number) => {
      audio.flush();
      deathFollow.current.reset();
      const next = Math.max(first, Math.min(last, value));
      playbackClock.current.reset(next, performance.now());
      setTick(next);
    },
    [first, last, audio],
  );
  useEffect(() => {
    if (!data || !spectatorEvents) return;
    const next = deathFollow.current.advance(data, spectatorEvents, {
      identity: audioIdentity,
      selected,
      mode,
      tick,
      playing,
      buffering,
      enabled: settings.autoFollowDeath,
    });
    if (!next) return;
    setSelected(next);
    setGrenadeFocus(undefined);
    cueCameraChange();
  }, [
    data,
    spectatorEvents,
    audioIdentity,
    selected,
    mode,
    tick,
    playing,
    buffering,
    settings.autoFollowDeath,
  ]);
  useEffect(() => {
    playbackClock.current.reset(currentTick.current, performance.now());
    if (!playing || !data || buffering) return;
    let frame = 0;
    const animate = (now: number) => {
      if (document.hidden) return;
      const state = playbackState.current;
      const ceiling = Math.min(last, state.availableUntil(playbackClock.current.tick));
      const advanced = playbackClock.current.at(now, rate * speed, ceiling);
      const requested =
        state.autoSkip && state.data ? skipDeadTime(state.data, advanced, 'all', last) : advanced;
      const next = Math.min(requested, ceiling, last);
      if (next !== advanced) playbackClock.current.reset(next, now);
      setTick(next);
      if (next >= last) {
        setPlaying(false);
        return;
      }
      frame = requestAnimationFrame(animate);
    };
    const visibility = () => {
      cancelAnimationFrame(frame);
      playbackClock.current.reset(currentTick.current, performance.now());
      if (!document.hidden) frame = requestAnimationFrame(animate);
    };
    if (!document.hidden) frame = requestAnimationFrame(animate);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [playing, Boolean(data), buffering, rate, speed, last, id, user?.id]);
  useEffect(() => {
    function keys(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const viewer = full.current;
      if (!viewer || (target !== document.body && !viewer.contains(target))) return;
      if (
        e.code === 'Escape' &&
        settings.reviewFeed &&
        !document.querySelector(
          'dialog[open]:not(.review-feed-inline),[role="menu"],[role="listbox"]',
        )
      ) {
        e.preventDefault();
        closeReviewFeed();
        return;
      }
      if (e.code === 'Tab' && scoreboardHeld.current) {
        e.preventDefault();
        return;
      }
      if (
        e.code === 'Tab' &&
        !e.shiftKey &&
        !e.repeat &&
        !typingOrDialog(target) &&
        !document.querySelector(
          'dialog[open]:not(.review-feed-inline),[aria-modal="true"],[role="menu"],[role="listbox"]',
        ) &&
        !scoreboardOpen
      ) {
        e.preventDefault();
        openScoreboard(target, true);
        return;
      }
      if (
        e.code === 'KeyH' &&
        !target.closest(
          'input,select,textarea,dialog,[role="dialog"],[contenteditable],[data-keyboard-managed]',
        ) &&
        !document.querySelector('dialog[open]:not(.review-feed-inline),[aria-modal="true"]')
      ) {
        if (e.repeat) return;
        e.preventDefault();
        const wasVisible = chrome.visible;
        chrome.toggle();
        if (!wasVisible)
          requestAnimationFrame(() => playTrigger.current?.focus({ preventScroll: true }));
        return;
      }
      if (!chrome.visible && e.code === 'Tab') {
        e.preventDefault();
        chrome.show();
        requestAnimationFrame(() => optionsTrigger.current?.focus({ preventScroll: true }));
        return;
      }
      if (target === stage.current && e.code === 'Enter') {
        e.preventDefault();
        chrome.toggle();
        return;
      }
      if (target.closest('input,select,textarea,button,a,dialog,[data-keyboard-managed]')) return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (playing) audio.flush();
        if (!playing) enableAudio();
        setPlaying((p) => !p);
      }
      if (e.code === 'ArrowRight') {
        e.preventDefault();
        seek(currentTick.current + rate * 5);
      }
      if (e.code === 'ArrowLeft') {
        e.preventDefault();
        seek(currentTick.current - rate * 5);
      }
      if (e.code === 'KeyF') void toggleFull();
    }
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  }, [
    last,
    first,
    rate,
    chrome.visible,
    chrome.toggle,
    chrome.show,
    panel,
    scoreboardOpen,
    settings.reviewFeed,
    playing,
    enableAudio,
    audio,
  ]);
  useEffect(() => {
    const release = (event: KeyboardEvent) => {
      if (event.code === 'Tab' && scoreboardHeld.current) closeScoreboard();
    };
    const blur = () => {
      if (scoreboardHeld.current) closeScoreboard();
    };
    window.addEventListener('keyup', release);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keyup', release);
      window.removeEventListener('blur', blur);
    };
  }, [scoreboardOpen]);
  const feedRound = data ? roundAt(data, tick, last) : undefined;
  const { feedKills, feedUtilities } = useMemo(() => {
    if (!data || !feedRound) return { feedKills: [], feedUtilities: [] };
    const reviewRound = feedRound;
    const feedKills = (reviewIndex?.kills || [])
      .filter((moment) => moment.tick >= reviewRound.start && moment.tick <= reviewRound.end)
      .map((moment) => ({
        id: moment.id,
        tick: moment.tick,
        timeLabel: clock((moment.tick - first) / rate),
        actor: { id: moment.attackerId || '', name: moment.attacker, team: moment.attackerTeam },
        target: { id: moment.victimId || '', name: moment.victim, team: moment.victimTeam },
        weapon: moment.weapon,
        headshot: moment.headshot,
        canReplayAttacker: Boolean(moment.attackerId && moment.attackerId !== moment.victimId),
        canReplayVictim: Boolean(moment.victimId),
      }));
    const feedUtilities = (reviewIndex?.utilities || [])
      .filter((moment) => moment.tick >= reviewRound.start && moment.tick <= reviewRound.end)
      .map((moment) => {
        const player = data.players.find((player) => player.id === moment.throwerId);
        const event = data.events[moment.eventIndex];
        const team = event?.user_team_num;
        return {
          id: moment.id,
          tick: moment.tick,
          timeLabel: clock((moment.tick - first) / rate),
          actor: {
            id: moment.throwerId,
            name: typeof event?.user_name === 'string' ? event.user_name : player?.name || '',
            team: team === 2 || team === 3 ? team : undefined,
          },
          weapon: moment.weapon,
          canReplayThrow: true,
          canViewLanding: Boolean(moment.landing),
          inputBadges: (
            <ThrowInputBadges
              snapshot={throwInputAt(throwInputs, moment)}
              layout={settings.inputLayout}
              synthetic={data.sample}
            />
          ),
        };
      });
    return { feedKills, feedUtilities };
  }, [
    reviewIndex,
    throwInputs,
    settings.inputLayout,
    first,
    rate,
    feedRound?.start,
    feedRound?.end,
    i18n.language,
    data?.events,
    data?.players,
  ]);
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
      !(await confirm({
        title: t('Share demo'),
        confirmLabel: t('Share demo'),
        tone: 'normal',
        description: t(
          config.public_access
            ? 'Make this demo public? Anyone with its link can access its replay data and recorded voice, chat and subtitles. Personal notes stay private.'
            : 'Share this demo with instance members, including replay data and recorded voice, chat and subtitles? They must sign in. Personal notes stay private.',
        ),
      }))
    )
      return;
    if (!scope.active) return;
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
          {t(backTo === '/' ? 'Back to home' : 'Back to library')}
        </Link>
      </div>
    );
  if (!data)
    return (
      <>
        <Link className="back-link" to={backTo}>
          <ArrowLeft size={16} />
          {t(backTo === '/' ? 'Home' : 'Library')}
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
            {demo?.error
              ? t(demo.error)
              : t(
                  demo?.guest_owned
                    ? 'Keep this link to return to your private demo in this browser before it expires.'
                    : 'You can leave this page. Your match will be ready in the library when processing finishes.',
                )}
          </p>
          {demo?.status === 'failed' && <p>{t('Demo reference: {{id}}', { id: demo.id })}</p>}
          <Link className="button" to={backTo}>
            {t(backTo === '/' ? 'Back to home' : 'Return to library')}
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
    if (demo?.guest_owned) return;
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
  function replayCombat(prompt: CombatMoment, perspective: 'attacker' | 'victim') {
    enableAudio();
    const playerId = perspective === 'attacker' ? prompt.attackerId : prompt.victimId;
    if (!playerId) return;
    setSelected(playerId);
    setGrenadeFocus(undefined);
    if (mode !== '2d') setMode('pov');
    seek(prompt.startTick);
    setPlaying(true);
    chrome.show();
    requestAnimationFrame(() => playTrigger.current?.focus({ preventScroll: true }));
  }
  function replayThrow(prompt: ThrowPrompt) {
    enableAudio();
    setSelected(prompt.throwerId);
    setGrenadeFocus(undefined);
    if (mode !== '2d') setMode('pov');
    seek(prompt.startTick);
    setPlaying(true);
    chrome.show();
    requestAnimationFrame(() => playTrigger.current?.focus({ preventScroll: true }));
  }
  function viewGrenadeLanding(prompt: LandingPrompt) {
    enableAudio();
    seek(Math.max(first, Math.floor(prompt.impactTick - rate / 4)));
    setGrenadeFocus({
      id: `${prompt.id}:${++focusSequence.current}`,
      target: prompt.target,
      origin: prompt.origin,
      fromTick: prompt.tick,
      untilTick: prompt.endTick,
    });
    if (mode !== '2d') setMode('orbit');
    setPlaying(true);
    chrome.show();
    requestAnimationFrame(() => playTrigger.current?.focus({ preventScroll: true }));
  }
  const momentActions: MenuAction[] = [
    {
      id: 'scoreboard',
      label: t('Scoreboard'),
      onSelect: () => openScoreboard(eventMenuTrigger.current),
    },
    {
      id: 'round-events',
      label: t('Current round events'),
      icon: <ListVideo size={16} />,
      onSelect: () => openRoundReview(eventMenuTrigger.current),
    },
    {
      id: 'previous-sample',
      label: t('Previous sample'),
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
  const playerCrosshairCode =
    !buffering && frame.players.some((player) => player.id === selected)
      ? recordedCrosshairAt(crosshairTimeline, selected, tick)
      : undefined;
  const round = data.rounds.filter((r) => r.tick <= tick).at(-1);
  const reviewRound = roundAt(data, tick, last);
  const reviewActions: ReviewAction[] = [];
  let reviewHeading: ReactNode;
  let reviewRecap: ReactNode;
  if (!panel && !buffering && recentMoment) {
    if (recentMoment.kind === 'combat') {
      const moment = recentMoment;
      const death = moment.victimId === selected;
      if (recapDamage)
        reviewRecap = <CombatRecap moment={moment} selected={selected} damage={recapDamage} />;
      if (moment.attackerId && moment.attackerId !== moment.victimId)
        reviewActions.push({
          id: moment.id + ':attacker',
          label: t('Replay kill'),
          shortLabel: t(death ? 'See kill' : 'Replay'),
          title: t('Replay this elimination from the killer’s perspective.'),
          icon: <ReviewEventGlyph event={{ type: 'kill' }} size={18} />,
          run: () => replayCombat(moment, 'attacker'),
        });
      if (moment.victimId)
        reviewActions.push({
          id: moment.id + ':victim',
          label: t('Replay death'),
          shortLabel: t(death ? 'Replay' : 'See death'),
          title: t('Replay this elimination from the victim’s perspective.'),
          icon: <ReviewEventGlyph event={{ type: 'death' }} size={18} />,
          run: () => replayCombat(moment, 'victim'),
        });
      if (death) reviewActions.reverse();
    } else {
      const moment = recentMoment;
      const actor = data.players.find((player) => player.id === moment.throwerId);
      reviewHeading = (
        <>
          <EquipmentGlyph item={moment.weapon} />
          <strong>{actor?.name || t('Unknown player')}</strong>
          <ThrowInputBadges
            snapshot={throwInputAt(throwInputs, moment)}
            layout={settings.inputLayout}
            synthetic={data.sample}
          />
        </>
      );
      reviewActions.push({
        id: moment.id + ':throw',
        label: t('Replay throw'),
        shortLabel: t('Replay'),
        title: t('Watch the recorded throw from the thrower’s perspective.'),
        icon: <Eye size={18} />,
        run: () => replayThrow(moment),
      });
      if (moment.landing)
        reviewActions.push({
          id: moment.id + ':landing',
          label: t('View grenade landing'),
          shortLabel: t('Landing'),
          title: t('View the recorded detonation position from a separate camera.'),
          icon: <MapPin size={18} />,
          run: () => viewGrenadeLanding(moment.landing!),
        });
    }
  }
  const viewerMenuActions: MenuAction[] = [
    ...(['en', 'fr'] as const).map((language) => ({
      id: 'language-' + language,
      label: language === 'en' ? 'English' : 'Français',
      onSelect: () => setLanguage(language),
      disabled: i18n.language === language,
    })),
    {
      id: 'theme',
      label: t(theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'),
      icon: theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />,
      onSelect: toggleTheme,
    },
    ...(demo?.owned
      ? [
          {
            id: 'manage',
            label: t('Manage'),
            onSelect: () => setManage(true),
            separatorBefore: true,
          },
          {
            id: 'share',
            label: t(demo.public ? 'Make private' : 'Share demo'),
            icon: <Share2 size={17} />,
            onSelect: () => void share(),
          },
        ]
      : []),
    ...(!user
      ? [{ id: 'sign-in', label: t('Sign in'), onSelect: signIn, separatorBefore: true }]
      : []),
  ];
  return (
    <div
      className={'viewer-frame' + (settings.inputs || settings.economy ? ' has-review-hud' : '')}
      data-controls-hidden={settings.controlsHidden}
      data-chrome-visible={chrome.visible}
      data-review-action-count={reviewActions.length}
      data-review-prompts={settings.killReplay || settings.grenadeLanding}
      data-score-visible={settings.matchScore}
      data-review-feed={showReviewFeed}
      ref={full}
    >
      <ObjectiveAnnouncement
        message={chrome.visible && objective && !panel ? objectiveDescription(objective) : ''}
      />
      <header
        className="viewer-titlebar"
        role="banner"
        data-viewer-chrome
        inert={!chrome.visible || (Boolean(panel) && compactPanels)}
        aria-hidden={!chrome.visible}
      >
        <div className="viewer-identity">
          <Link
            className="icon-button viewer-back"
            to={backTo}
            aria-label={t(backTo === '/' ? 'Back to home' : 'Back to library')}
          >
            <ArrowLeft size={19} />
          </Link>
          <div className="viewer-match">
            <h1
              title={
                data.sample ? t('Interactive sample · original scene & synthetic data') : demo?.name
              }
            >
              {data.sample ? t('Training courtyard') : data.map.replace('de_', '')}
            </h1>
            <div className="viewer-context">
              {data.sample && <span>{t('Interactive sample')}</span>}
              {!settings.matchScore && (
                <span>
                  {t('Round')} {round?.number ?? 1}
                </span>
              )}
              {!data.sample && (
                <span
                  className="viewer-map-status"
                  data-status={mapNoticeStatus}
                  title={t(mapStatusText)}
                >
                  {t(mapStatusText)}
                </span>
              )}
              {!data.sample &&
                (mapAssets.acquisition?.verification === 'version-unverified' ||
                  mapAssets.acquisition?.verification === 'latest-official') && (
                  <span
                    className="viewer-map-verification"
                    data-map-verification={mapAssets.acquisition.verification}
                    title={t(
                      mapAssets.acquisition.verification === 'latest-official'
                        ? 'This is the latest official map, not a verified historical match. Its layout may differ from this recording.'
                        : 'This operator-installed pack has not been matched to the recorded map version.',
                    )}
                  >
                    <span className="map-verification-full">
                      {t(
                        mapAssets.acquisition.verification === 'latest-official'
                          ? 'Latest official map'
                          : 'Map version unverified',
                      )}
                    </span>
                    <span className="map-verification-short">
                      {t(
                        mapAssets.acquisition.verification === 'latest-official'
                          ? 'Latest map'
                          : 'Unverified',
                      )}
                    </span>
                  </span>
                )}
              {data.deadTimes?.some((period) => tick >= period.start && tick < period.end) && (
                <span>
                  {t(
                    data.deadTimes.find((period) => tick >= period.start && tick < period.end)
                      ?.kind || '',
                  )}
                </span>
              )}
            </div>
          </div>
        </div>
        <div
          className="viewer-global-actions viewer-camera-tools"
          data-camera-changed={cameraNotice}
        >
          <span className="visually-hidden" role="status">
            {cameraNotice
              ? t('Camera changed to {{mode}}', {
                  mode: t(
                    mode === 'pov'
                      ? 'Player perspective'
                      : mode === 'follow'
                        ? 'Third-person follow'
                        : mode === 'orbit'
                          ? 'Free camera'
                          : mode === 'tactical'
                            ? 'Overhead'
                            : '2D tactical · low power',
                  ),
                })
              : ''}
          </span>
          <SelectControl
            label={t('Camera mode')}
            className="camera-select"
            icon={<Eye size={16} />}
            value={mode}
            onValueChange={(value) => {
              deathFollow.current.reset();
              setGrenadeFocus(undefined);
              setMode(value);
              cueCameraChange();
            }}
            options={[
              { value: 'orbit', label: t('Free camera') },
              { value: 'tactical', label: t('Overhead') },
              { value: '2d', label: t('2D tactical · low power') },
              { value: 'follow', label: t('Third-person follow') },
              { value: 'pov', label: t('Player perspective') },
            ]}
          />
          <button
            ref={optionsTrigger}
            className="button options-button"
            aria-label={t('Options')}
            title={t('Options')}
            onClick={() => setOptions(true)}
          >
            <SlidersHorizontal size={17} />
            <span>{t('Options')}</span>
          </button>
          {user ? (
            <AccountMenu compact label={t('Viewer menu')} extraActions={viewerMenuActions} />
          ) : (
            <ActionMenu
              label={t('Viewer menu')}
              trigger={
                <button className="icon-button" aria-label={t('Viewer menu')}>
                  <MoreHorizontal size={19} />
                </button>
              }
              items={viewerMenuActions}
            />
          )}
        </div>
      </header>
      <div className="viewer-surface">
        {settings.matchScore && !buffering && (
          <MatchScore
            data={data}
            tick={tick}
            objective={
              objective && !panel ? <ObjectiveHud value={objective} variant="score" /> : undefined
            }
            objectiveCaption={
              objective && !panel ? <ObjectiveContext value={objective} /> : undefined
            }
            objectiveDescription={objective && !panel ? objectiveDescription(objective) : undefined}
            chromeVisible={chrome.visible && !(panel && compactPanels)}
            onOpenScoreboard={() =>
              openScoreboard(
                full.current?.querySelector('.viewer-match-score') as HTMLElement | null,
              )
            }
          />
        )}
        {showReviewFeed && (
          <ReviewFeed
            kills={feedKills}
            utilities={feedUtilities}
            activeTab={feedTab}
            onTabChange={setFeedTab}
            chromeVisible={chrome.visible}
            modal={compactPanels}
            focusOnOpen
            onClose={closeReviewFeed}
            onSeek={(value) => {
              if (compactPanels) closeReviewFeed();
              seekEvent(value);
            }}
            onReplayKill={(momentId, perspective) => {
              const moment = reviewIndex?.kills.find((value) => value.id === momentId);
              if (moment) {
                if (compactPanels) closeReviewFeed();
                replayCombat(moment, perspective);
              }
            }}
            onReviewUtility={(momentId, action) => {
              const moment = reviewIndex?.utilities.find((value) => value.id === momentId);
              if (!moment) return;
              if (compactPanels) closeReviewFeed();
              if (action === 'landing' && moment.landing) viewGrenadeLanding(moment.landing);
              else if (action === 'throw') replayThrow(moment);
            }}
          />
        )}

        <div
          className="viewer-stage"
          ref={stage}
          role="group"
          tabIndex={0}
          aria-label={t('Demo view · tap or press H to show or hide controls')}
          aria-keyshortcuts="H Enter Tab"
          aria-description={t('Hold Tab to view the scoreboard. Shift+Tab navigates to controls.')}
          inert={Boolean(panel) && compactPanels}
        >
          <Suspense fallback={<div className="scene-fallback">{t('Starting renderer…')}</div>}>
            <Scene
              data={data}
              tick={tick}
              mode={mode}
              selected={selected}
              settings={settings}
              mapAssets={mapAssets}
              assetScope={user?.id || 'public'}
              onMapStatus={setMapRender}
              focus={grenadeFocus}
              onAudioListener={cameraAudio}
            />
          </Suspense>
          {settings.damageFeedback &&
            mode === 'pov' &&
            !using2D &&
            !buffering &&
            spectatorEvents && (
              <DamageFeedback value={damageFeedbackAt(data, spectatorEvents, selected, tick)} />
            )}
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
          {settings.crosshair &&
            mode === 'pov' &&
            !using2D &&
            (settings.crosshairSource === 'player' ? (
              <RecordedCrosshair code={playerCrosshairCode} />
            ) : (
              <Crosshair value={settings.crosshairStyle} />
            ))}
          <div
            className="viewer-game-hud"
            data-viewer-chrome
            inert={!chrome.visible}
            aria-hidden={!chrome.visible}
          >
            {settings.killfeed && !settings.reviewFeed && (
              <div className="killfeed">
                {data.events
                  .filter(
                    (e) => e.type === 'player_death' && e.tick <= tick && e.tick > tick - rate * 6,
                  )
                  .slice(-4)
                  .map((e, i) => (
                    <div key={i} className="killfeed-entry">
                      <strong>{e.attacker_name || t('World')}</strong>
                      <span
                        className="killfeed-weapon"
                        role="img"
                        aria-label={
                          (e.weapon ? equipmentName(e.weapon) : t('eliminated')) +
                          (e.headshot === true ? ` · ${t('Headshot')}` : '')
                        }
                      >
                        {e.weapon ? (
                          <EquipmentGlyph item={e.weapon} />
                        ) : (
                          <ReviewEventGlyph event={{ type: 'elimination' }} />
                        )}
                        {e.headshot === true && (
                          <ReviewEventGlyph event={{ type: 'kill' }} detail="headshot" size={14} />
                        )}
                      </span>
                      <span className="killfeed-player">{e.user_name || t('Player')}</span>
                    </div>
                  ))}
              </div>
            )}
            {settings.radar && !using2D && (
              <TacticalPlot
                data={data}
                tick={tick}
                selected={selected}
                settings={settings}
                compact
                overview={mapAssets.assets.overview}
                overviewStatus={mapAssets.overviewStatus}
                onOverviewState={mapAssets.reportOverview}
              />
            )}
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
                <PlayerPicker
                  players={data.players}
                  frame={frame}
                  selected={selected}
                  onSelect={(playerId) => selectPlayer(playerId, true)}
                />
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
          hidden={Boolean(panel) || buffering}
          chromeVisible={chrome.visible}
          onSelect={selectPlayer}
        />
        <div
          className="viewer-objective-layer"
          data-viewer-chrome
          inert={!chrome.visible}
          aria-hidden={!chrome.visible}
        >
          {!settings.matchScore && objective && !panel && <ObjectiveHud value={objective} />}
        </div>
        <div
          ref={playbackDock}
          inert={!chrome.visible || (Boolean(panel) && compactPanels)}
          data-viewer-chrome
          aria-hidden={!chrome.visible}
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
            scope={timelineScope}
            onSeek={seekEvent}
            onReview={() => openRoundReview(mobileMoreTrigger.current)}
            optionsOpen={timelineOptionsOpen}
            onCloseOptions={() => {
              setTimelineOptionsOpen(false);
              requestAnimationFrame(() => {
                if (panelClose.current?.isConnected) panelClose.current.focus();
                else restoreViewerFocus(mobileMoreTrigger.current);
              });
            }}
          />
          <div className="viewer-controlbar">
            <div className="viewer-timeline-navigation">
              <SelectControl
                label={t('Timeline range')}
                className="timeline-scope-control"
                value={timelineScope}
                onValueChange={(value) => setTimelineScope(value === 'round' ? 'round' : 'match')}
                icon={<ScanLine size={16} />}
                options={[
                  { value: 'match', label: t('All match') },
                  { value: 'round', label: t('Current round'), disabled: !data.rounds.length },
                ]}
              />
            </div>
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
                ref={playTrigger}
                aria-label={playing ? t('Pause') : t('Play')}
                onClick={() => {
                  if (playing) audio.flush();
                  if (!playing) enableAudio();
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
                onValueChange={(value) => {
                  audio.flush();
                  setSpeed(Number(value));
                }}
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
                className="icon-button labeled-viewer-action"
                aria-label={t('Players')}
                title={t('Players')}
                aria-expanded={panel === 'players'}
                onClick={(e) => togglePanel('players', e.currentTarget)}
              >
                <Users size={19} />
                <span className="viewer-action-label">{t('Players')}</span>
              </button>
              <button
                className="icon-button labeled-viewer-action"
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
                <span className="viewer-action-label">{t('Key moments')}</span>
              </button>
              {!demo?.guest_owned && (
                <button
                  className="icon-button desktop-viewer-action"
                  aria-label={t('Add note')}
                  title={t('Add note')}
                  onClick={(event) => openNote(event.currentTarget)}
                >
                  <BookmarkPlus size={19} />
                </button>
              )}
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
                    id: 'players',
                    label: t('Players'),
                    onSelect: () => togglePanel('players', mobileMoreTrigger.current!),
                  },
                  {
                    id: 'key-moments',
                    label: t('Key moments'),
                    onSelect: () => openRoundReview(mobileMoreTrigger.current),
                  },
                  {
                    id: 'timeline-options',
                    label: t('Timeline options'),
                    icon: <SlidersHorizontal size={16} />,
                    onSelect: () => setTimelineOptionsOpen(true),
                  },
                  {
                    id: 'next-live-round',
                    label: t('Next live round'),
                    icon: <SkipForward size={16} />,
                    onSelect: () => {
                      const next = data.rounds.find(
                        (round) => (round.liveTick ?? round.tick) > tick,
                      );
                      if (next) seek(next.liveTick ?? next.tick);
                      else notify('You are in the last recorded round.');
                    },
                  },
                  {
                    id: 'skip-dead-time',
                    label: t('Skip dead time'),
                    icon: <FastForward size={16} />,
                    onSelect: () => {
                      const target = skipDeadTime(data, tick, 'all', last);
                      if (target === tick) notify('No freeze period or timeout at this position.');
                      else seek(target);
                    },
                  },
                  {
                    id: 'rounds',
                    label: t('Rounds'),
                    onSelect: () => setRoundsOpen((value) => !value),
                  },
                  ...(demo?.guest_owned
                    ? []
                    : [
                        {
                          id: 'add-note',
                          label: t('Add note'),
                          icon: <BookmarkPlus size={16} />,
                          onSelect: () => openNote(mobileMoreTrigger.current),
                        },
                      ]),
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
        {!(mapAssets.acquisition?.acquisition === 'failed' && mapAssets.acquisition.canAcquire) && (
          <ReviewActions actions={reviewActions} heading={reviewHeading} recap={reviewRecap} />
        )}
      </div>
      {scoreboardOpen && (
        <Scoreboard
          data={data}
          frame={frame}
          tick={tick}
          selected={selected}
          buffering={buffering}
          close={closeScoreboard}
          onSelect={(playerId) => {
            selectPlayer(playerId);
            closeScoreboard();
          }}
        />
      )}
      {manage && demo && (
        <ManageDemo demo={demo} onChange={setDemo} close={() => setManage(false)} />
      )}
      {options && (
        <ViewerOptions
          settings={settings}
          playerCrosshairCode={playerCrosshairCode}
          equipment={mapRender?.map === data.map ? mapRender.equipment : undefined}
          mapAcquisition={mapAssets.acquisition}
          recordedMapIdentity={data.mapIdentity}
          audio={audio}
          gameAudio={gameAudio}
          onChange={setSettings}
          close={closeViewerOptions}
          openCommunications={() => {
            communicationsTrigger.current = optionsTrigger.current;
            setOptions(false);
            setCommunicationsOpen(true);
          }}
        />
      )}
      <Communications
        audio={audio}
        id={id || ''}
        owned={Boolean(demo?.owned)}
        data={data}
        tick={tick}
        first={first}
        playing={playing && !buffering}
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
