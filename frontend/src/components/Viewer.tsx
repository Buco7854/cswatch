import { ReplayFrames, ReplayFrameContext } from '../replay-frames';
import { PlaybackClock } from '../playback-clock';
import { useViewerAudio, type ListenerPose } from '../viewer-audio';
import type { WallTrace } from '../shot-wall-audio';
import { useGameplayAudio } from '../useGameplayAudio';
import { captureFocusReturn, focusMovedSince, type FocusReturnContext } from '../focus-return';
import i18n, { t, setLanguage } from '../i18n';
import {
  lazy,
  memo,
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
  RotateCcw,
  RotateCw,
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
  MoreHorizontal,
  MapPin,
} from 'lucide-react';
import { api } from '../api';
import { openingPlayer, playerShortcut } from '../replay-opening';
import { useReplay } from '../useReplay';
import { useViewerChrome } from '../useViewerChrome';
import { useReviewLayout } from '../useReviewLayout';
import { useApp, useWorkspaceConcealed } from '../context';
import type { Bookmark } from '../types';
import { frameAt, skipDeadTime, type DeadTimeFilter } from '../playback';
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
  replayLeadInTick,
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
import {
  damageFeedbackAt,
  DeathFollowController,
  indexSpectatorEvents,
  killfeedAt,
  watchedDeath,
} from '../spectator-state';
import DamageFeedback from './DamageFeedback';
import FlashFeedback from './FlashFeedback';
import { flashFeedbackAt } from '../flash-feedback';
import Communications from './Communications';
import ViewerOptions from './ViewerOptions';
import ViewerLoading from './ViewerLoading';
import { mapName } from './MatchDetails';
import Crosshair from './Crosshair';
import { scopedVerticalFov } from '../pov-camera';
import TacticalPlot from './TacticalPlot';
import ManageDemo from './ManageDemo';
import AccountMenu from './AccountMenu';
import {
  ViewerCameraControls,
  ViewerSpeedControls,
  ViewerTimelineScope,
} from './ViewerPlaybackControls';
import { ActionMenu, type MenuAction } from './Controls';
import { useConfirm } from './Confirmation';
const loadScene = () => import('./Scene');
const Scene = memo(lazy(loadScene));
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
  const concealed = useWorkspaceConcealed();
  const audio = useViewerAudio(audioIdentity, concealed);
  const audioCameraReady = useRef(false);
  const audioWallTrace = useRef<WallTrace | undefined>(undefined);
  const cameraAudio = useCallback(
    (pose: ListenerPose | null, trace?: WallTrace) => {
      audioWallTrace.current = pose ? trace : undefined;
      audioCameraReady.current = Boolean(pose);
      if (pose) audio.setListener(pose);
    },
    [audio],
  );
  const confirm = useConfirm();
  const [cameraNotice, setCameraNotice] = useState(false);
  const cameraNoticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(cameraNoticeTimer.current), []);
  const cueCameraChange = useCallback(() => {
    clearTimeout(cameraNoticeTimer.current);
    setCameraNotice(true);
    cameraNoticeTimer.current = setTimeout(() => setCameraNotice(false), 900);
  }, []);
  const query = new URLSearchParams(location.search);
  const tickParam = query.get('tick');
  const linkedTick = tickParam && /^\d+$/.test(tickParam) ? Number(tickParam) : undefined;
  const linkedPlayer = query.get('player') || undefined;
  const previous = location.state?.from;
  const backTo =
    typeof previous === 'string' && (previous === '/' || /^\/library(?:\?[^#]*)?$/.test(previous))
      ? previous
      : user
        ? '/library'
        : '/';
  const backState = backTo === previous ? location.state?.fromState : undefined;
  const [requestedPlayback, setPlaying] = useState(false),
    [tick, setTick] = useState(0),
    [speed, setSpeed] = useState(1),
    [requestedMode, setMode] = useState('pov'),
    [selected, setSelected] = useState(''),
    [tab, setTab] = useState('events'),
    [bookmarks, setBookmarks] = useState<Bookmark[]>([]),
    [label, setLabel] = useState(''),
    [showNote, setShowNote] = useState(false),
    [busy, setBusy] = useState(false);
  const mode = requestedMode === 'pov' && !selected ? 'tactical' : requestedMode;
  const openedReplay = useRef<string>(undefined);
  const playing = requestedPlayback && !concealed;
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
      replayFrames.tick = initialTick;
      setTick(initialTick);
      const player = openingPlayer(replay, initialTick, linkedPlayer);
      setSelected(player);
      const sameReplay = openedReplay.current === audioIdentity;
      openedReplay.current = audioIdentity;
      setMode((previous) => (sameReplay && previous === '2d' ? previous : 'pov'));
      setPlaying(false);
    },
    user?.id,
    linkedTick,
  );
  useEffect(() => {
    if (!data || selected || requestedMode !== 'pov' || buffering) return;
    const player = openingPlayer(data, tick);
    if (player) setSelected(player);
  }, [data, selected, requestedMode, buffering, tick]);
  const selectPlayer = useCallback(
    (playerId: string, dismissPicker = false) => {
      if (!data?.players.some((player) => player.id === playerId)) return;
      deathFollow.current.reset();
      setSelected(playerId);
      setGrenadeFocus(undefined);
      if (mode !== '2d') {
        setMode('pov');
        cueCameraChange();
      }
      if (dismissPicker) closePanel();
    },
    [data?.players, mode],
  );
  useEffect(() => {
    if (linkedPlayer && data?.players.some((player) => player.id === linkedPlayer))
      setSelected(linkedPlayer);
  }, [linkedPlayer, data?.players]);
  useEffect(() => {
    // Download the renderer while the authorized replay manifest and first slice load.
    if (demo?.status === 'ready') void loadScene().catch(() => {});
  }, [demo?.status]);
  // The authorized detail already identifies the map while the first replay slice loads.
  const replayMap = data && !data.sample ? data.map : undefined;
  const discoveryMap =
    id !== 'sample' && !error && demo?.status === 'ready' ? (replayMap ?? demo.map) : undefined;
  const mapAssets = useDemoMapAssets(id, discoveryMap ?? undefined, user?.id, Boolean(replayMap));
  const acquisitionNotice = mapAcquisitionMessage(mapAssets);
  const [sceneAttempt, setSceneAttempt] = useState(0);
  const sceneKey = JSON.stringify([id, user?.id, sceneAttempt]);
  const [earlyReviewScene, setEarlyReviewScene] = useState<string>();
  const [mapReport, setMapReport] = useState<{ key: string; value: MapRenderState }>();
  const reportMap = useCallback(
    (value: MapRenderState) => setMapReport({ key: sceneKey, value }),
    [sceneKey],
  );
  const mapRender =
    mapReport?.key === sceneKey && mapReport.value.map === data?.map ? mapReport.value : undefined;
  const using2D = mode === '2d' || mapRender?.renderer === '2d';
  const fallbackCamera = using2D && mode !== '2d';
  const activeCamera = fallbackCamera ? 'fallback' : mode;
  const has3DMap = Boolean(
    data?.sample || mapAssets.assets.model || mapAssets.assets.mobile || mapAssets.assets.compact,
  );
  const mapStatus: AssetStatus =
    mapAssets.status === 'pending'
      ? 'pending'
      : mapAssets.status === 'error'
        ? 'error'
        : using2D
          ? mapAssets.overviewStatus
          : mapRender
            ? mapRender.model
            : has3DMap
              ? 'pending'
              : 'missing';
  const environmentStatus: AssetStatus =
    !mapRender?.compact && mapAssets.assets.environment
      ? mapRender?.environmentVersion === mapAssets.assets.environment.assetVersion
        ? mapRender.environment
        : 'pending'
      : 'missing';
  const preparation = acquisitionNotice?.preparing ? acquisitionNotice : undefined;
  const mapLoading = Boolean(
    data &&
    !data.sample &&
    earlyReviewScene !== sceneKey &&
    (preparation || (mapStatus === 'pending' && !acquisitionNotice)),
  );
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
            : mapRender?.failure === 'textures'
              ? 'This device lacks the texture support needed for 3D'
              : mapRender?.failure === 'webgl'
                ? '3D unavailable'
                : mapRender?.failure === 'model'
                  ? '3D failed'
                  : '2D map fallback'
          : mapStatus === 'pending'
            ? 'Loading map overview…'
            : mapStatus === 'error'
              ? 'Map overview failed to load'
              : 'Map unavailable'
        : mapStatus === 'ready'
          ? mapRender?.compact
            ? 'Compact 3D'
            : environmentStatus === 'pending'
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
    [data?.events, data?.players, data?.sample, first, last, selected],
  );
  const { settings, setSettings, mobile } = useViewerPreferences();
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
    mode: using2D ? '2d' : mode,
    settings,
    cameraReady: audioCameraReady,
    wallTrace: audioWallTrace,
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
  const [compactFeedOpen, setCompactFeedOpen] = useState<boolean>();
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
  const [compactPanels, setCompactPanels] = useState(
    () => window.matchMedia('(max-width:540px),(max-height:560px)').matches,
  );
  useEffect(() => {
    const media = window.matchMedia('(max-width:540px),(max-height:560px)');
    const update = () => setCompactPanels(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  const compactFeedVisible = compactPanels && (compactFeedOpen ?? (mobile && settings.reviewFeed));
  const showReviewFeed =
    (compactFeedVisible || (settings.reviewFeed && !compactPanels)) &&
    !panel &&
    !buffering &&
    !mapLoading &&
    !options &&
    !manage &&
    !communicationsOpen &&
    !timelineOptionsOpen &&
    !scoreboardOpen;
  const mutationScope = useRef({ active: true });
  const [eventReviewKey, setEventReviewKey] = useState(0);
  const panelClose = useRef<HTMLButtonElement>(null);
  const panelTrigger = useRef<HTMLElement | null>(null);
  const panelWasOpen = useRef(false);
  const full = useRef<HTMLDivElement>(null);
  const overlayLayout = useReviewLayout(full, Boolean(data));
  const playbackDock = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const playTrigger = useRef<HTMLButtonElement>(null);
  const mobileMoreTrigger = useRef<HTMLButtonElement>(null);
  const eventMenuTrigger = useRef<HTMLElement | null>(null);
  const reviewFeedTrigger = useRef<HTMLElement | null>(null);
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
      (mapAssets.status === 'pending' && Boolean(acquisitionNotice)) ||
      Boolean(panel) ||
      options ||
      manage ||
      communicationsOpen ||
      timelineOptionsOpen ||
      scoreboardOpen ||
      compactFeedVisible ||
      buffering,
    ready: Boolean(data),
  });
  const controlsVisible = chrome.visible && !mapLoading;
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
      if (!full.current?.isConnected || document.querySelector('dialog[open]')) return;
      restoreViewerFocus(optionsTrigger.current, focusReturn);
    });
  }
  const openScoreboard = useCallback(
    (trigger: HTMLElement | null, held = false) => {
      scoreboardHeld.current = held;
      scoreboardTrigger.current = trigger;
      setScoreboardOpen(true);
      chrome.show();
    },
    [chrome.show],
  );
  const openScoreFromHeader = useCallback(
    () => openScoreboard(full.current?.querySelector<HTMLElement>('.viewer-match-score') ?? null),
    [openScoreboard],
  );
  function closeScoreboard() {
    const focusReturn = captureFocusReturn();
    const held = scoreboardHeld.current;
    scoreboardHeld.current = false;
    setScoreboardOpen(false);
    requestAnimationFrame(() => {
      if (!full.current?.isConnected || document.querySelector('dialog[open]')) return;
      if (held && scoreboardTrigger.current === stage.current)
        restoreViewerFocus(stage.current, focusReturn);
      else restoreViewerFocus(scoreboardTrigger.current, focusReturn);
    });
  }
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
      if (!document.querySelector('dialog[open],[aria-modal="true"]'))
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
  const replayFrames = useMemo(() => new ReplayFrames(), []);
  const playbackClock = useRef(new PlaybackClock());
  const deathFollow = useRef(new DeathFollowController());
  const spectatorEvents = useMemo(
    () => (data ? indexSpectatorEvents(data) : undefined),
    [data?.events, data?.players, data?.sample],
  );
  const currentTick = useRef(tick);
  currentTick.current = tick;
  const autoSkip = settings.autoSkipFreeze
    ? settings.autoSkipTimeouts
      ? 'all'
      : 'freeze'
    : settings.autoSkipTimeouts
      ? 'timeout'
      : null;
  const playbackState = useRef<{
    data: typeof data;
    availableUntil: typeof availableUntil;
    autoSkip: DeadTimeFilter | null;
  }>({ data, availableUntil, autoSkip });
  playbackState.current = { data, availableUntil, autoSkip };
  useEffect(() => {
    const scope = { active: true };
    mutationScope.current = scope;
    setEarlyReviewScene(undefined);
    setPlaying(false);
    setBookmarks([]);
    setLabel('');
    setShowNote(false);
    setBusy(false);
    setTab('events');
    setPanel(null);
    setCompactFeedOpen(undefined);
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
      replayFrames.tick = next;
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
    const stop = replayFrames.play(
      (now: number) => {
        const state = playbackState.current;
        const ceiling = Math.min(last, state.availableUntil(playbackClock.current.tick));
        const advanced = playbackClock.current.at(now, rate * speed, ceiling);
        const requested =
          state.autoSkip && state.data
            ? skipDeadTime(state.data, advanced, state.autoSkip, last)
            : advanced;
        const next = Math.min(requested, ceiling, last);
        if (next !== advanced) {
          audio.flush();
          playbackClock.current.reset(next, now);
        }
        return next;
      },
      (next) => {
        setTick(next);
        if (next >= last) setPlaying(false);
      },
    );
    const visibility = () => {
      audio.flush();
      playbackClock.current.reset(replayFrames.tick, performance.now());
    };
    document.addEventListener('visibilitychange', visibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [playing, Boolean(data), buffering, rate, speed, last, id, user?.id, audio]);
  useEffect(() => {
    function keys(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      if (mapLoading || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const viewer = full.current;
      if (
        !viewer ||
        viewer.closest('[inert]') ||
        (target !== document.body && !viewer.contains(target))
      )
        return;
      if (
        e.code === 'Escape' &&
        compactFeedVisible &&
        !document.querySelector('dialog[open],[role="menu"],[role="listbox"]')
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
          'dialog[open],[aria-modal="true"],[role="menu"],[role="listbox"]',
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
        !document.querySelector('dialog[open],[aria-modal="true"]')
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
      if (
        !typingOrDialog(target) &&
        !document.querySelector('dialog[open],[role="menu"],[role="listbox"]')
      ) {
        const key = e.code.startsWith('Digit') ? e.code.slice(5) : e.key;
        const shortcut = data?.players.find((_, index) => key === playerShortcut(index));
        if (shortcut) {
          e.preventDefault();
          selectPlayer(shortcut.id);
          return;
        }
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
    mapLoading,
    last,
    first,
    rate,
    chrome.visible,
    chrome.toggle,
    chrome.show,
    panel,
    scoreboardOpen,
    compactFeedVisible,
    data?.players,
    mode,
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
  const changeCamera = useCallback(
    (value: string) => {
      deathFollow.current.reset();
      setGrenadeFocus(undefined);
      if (
        value !== '2d' &&
        using2D &&
        (mapRender?.failure === 'model' || mapRender?.failure === 'webgl')
      )
        setSceneAttempt((attempt) => attempt + 1);
      setMode(value);
      cueCameraChange();
    },
    [using2D, mapRender?.failure, cueCameraChange],
  );
  const changeSpeed = useCallback(
    (value: number) => {
      audio.flush();
      setSpeed(value);
    },
    [audio],
  );
  const seekEvent = useCallback(
    (value: number) => {
      setPlaying(false);
      seek(value);
    },
    [seek],
  );
  function replayCombat(prompt: CombatMoment, perspective: 'attacker' | 'victim') {
    enableAudio();
    const playerId = perspective === 'attacker' ? prompt.attackerId : prompt.victimId;
    if (!data || !playerId) return;
    setSelected(playerId);
    setGrenadeFocus(undefined);
    if (mode !== '2d') setMode('pov');
    seek(replayLeadInTick(data, prompt.tick, settings.killLeadIn, first, last));
    setPlaying(true);
    chrome.show();
    requestAnimationFrame(() => playTrigger.current?.focus({ preventScroll: true }));
  }
  function replayThrow(prompt: ThrowPrompt) {
    enableAudio();
    if (!data) return;
    setSelected(prompt.throwerId);
    setGrenadeFocus(undefined);
    if (mode !== '2d') setMode('pov');
    seek(replayLeadInTick(data, prompt.tick, settings.utilityLeadIn, first, last));
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
  // The event rows are static across playback. Event actions read the current
  // camera/transport session only when invoked.
  const feedTransport = useRef({ replayCombat, replayThrow, viewGrenadeLanding });
  feedTransport.current = { replayCombat, replayThrow, viewGrenadeLanding };
  const closeReviewFeed = useCallback(() => {
    const focusReturn = captureFocusReturn();
    setCompactFeedOpen(false);
    setSettings((value) => ({ ...value, reviewFeed: false }));
    requestAnimationFrame(() => restoreViewerFocus(reviewFeedTrigger.current, focusReturn));
  }, [setSettings]);
  const reviewFeedActions = useMemo(
    () => ({
      onSeek: (value: number) => {
        if (compactPanels) closeReviewFeed();
        seekEvent(value);
      },
      onReplayKill: (momentId: string, perspective: 'attacker' | 'victim') => {
        const moment = reviewIndex?.kills.find((value) => value.id === momentId);
        if (!moment) return;
        if (compactPanels) closeReviewFeed();
        feedTransport.current.replayCombat(moment, perspective);
      },
      onReviewUtility: (momentId: string, action: 'throw' | 'landing') => {
        const moment = reviewIndex?.utilities.find((value) => value.id === momentId);
        if (!moment) return;
        if (compactPanels) closeReviewFeed();
        if (action === 'landing' && moment.landing)
          feedTransport.current.viewGrenadeLanding(moment.landing);
        else if (action === 'throw') feedTransport.current.replayThrow(moment);
      },
    }),
    [compactPanels, reviewIndex, closeReviewFeed, seekEvent],
  );
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
  const returnLink = (
    <Link className="button" to={backTo} state={backState}>
      <ArrowLeft size={16} aria-hidden="true" />
      {t(backTo === '/' ? 'Back to home' : 'Back to library')}
    </Link>
  );
  if (error || !data) {
    const failed = demo?.status === 'failed';
    const loading = !demo || demo.status === 'ready';
    const label = error
      ? 'Demo unavailable'
      : failed
        ? 'This demo could not be parsed'
        : loading
          ? 'Loading demo…'
          : demo.status === 'processing'
            ? 'Reading the match…'
            : 'Your demo is in the queue';
    const detail =
      error ||
      demo?.error ||
      (!loading &&
        !failed &&
        (demo.guest_owned
          ? 'Keep this link to return to your private demo in this browser before it expires.'
          : 'You can leave this page. Your match will be ready in the library when processing finishes.'));
    return (
      <div className="viewer-frame">
        <ViewerLoading
          key="opening"
          label={label}
          back={returnLink}
          detail={detail ? t(detail) : undefined}
          failed={Boolean(error || failed)}
        >
          {!error && failed && <p>{t('Demo reference: {{id}}', { id: demo.id })}</p>}
          {!error &&
            demo &&
            (demo.owned || demo.guest_owned) &&
            ['queued', 'failed'].includes(demo.status) && (
              <button className="button" onClick={() => setManage(true)}>
                {t(demo.guest_owned ? 'Delete demo' : 'Manage demo')}
              </button>
            )}
          {!error && manage && demo && (
            <ManageDemo demo={demo} onChange={setDemo} close={() => setManage(false)} />
          )}
        </ViewerLoading>
      </div>
    );
  }
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
  const momentActions: MenuAction[] = [
    {
      id: 'scoreboard',
      label: t('Scoreboard'),
      onSelect: () => openScoreboard(eventMenuTrigger.current),
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
  const selectedPosition = frame.players.find((player) => player.id === selected);
  const sampledFlash = selectedPosition?.alive ? selectedPosition.flash : undefined;
  const showPovEffects = mode === 'pov' && !using2D && !acquisitionNotice;
  const recordedFlash =
    showPovEffects &&
    !buffering &&
    settings.flashFeedback !== 'off' &&
    sampledFlash !== undefined &&
    Number.isFinite(sampledFlash) &&
    sampledFlash > 0
      ? settings.flashFeedback === 'indicator'
        ? 0
        : flashFeedbackAt(data, selected, tick)
      : undefined;
  const livePov =
    showPovEffects &&
    !buffering &&
    selectedPosition?.alive &&
    !watchedDeath(data, spectatorEvents?.deaths.get(selected), selected, tick, 3, frame);
  const scopeFov = livePov ? scopedVerticalFov(selectedPosition) : undefined;
  const playerCrosshairCode =
    !buffering && selectedPosition
      ? recordedCrosshairAt(crosshairTimeline, selected, tick)
      : undefined;
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
    ...(demo?.owned || demo?.guest_owned
      ? [
          {
            id: 'manage',
            label: t(demo.guest_owned ? 'Delete demo' : 'Manage demo'),
            onSelect: () => setManage(true),
            separatorBefore: true,
          },
        ]
      : []),
    ...(demo?.owned
      ? [
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
  const nextRound = data.rounds.find((round) => round.number > reviewRound.number);
  const previousRound = data.rounds.filter((round) => round.number < reviewRound.number).at(-1);
  const radarInterval = Math.max(1, Math.floor((rate * speed) / 12));
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
        message={controlsVisible && objective && !panel ? objectiveDescription(objective) : ''}
      />
      <header
        className="viewer-titlebar"
        role="banner"
        data-viewer-chrome
        inert={!controlsVisible || (Boolean(panel) && compactPanels)}
        aria-hidden={!controlsVisible}
      >
        <div className="viewer-identity">
          <Link
            className="icon-button viewer-back"
            to={backTo}
            state={backState}
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
              {data.sample ? t('Training courtyard') : mapName(data.map)}
            </h1>
            <div className="viewer-context">
              {data.sample && <span>{t('Interactive sample')}</span>}
              {!settings.matchScore && (
                <span>
                  {t('Round')} {reviewRound.number}
                </span>
              )}
              {!data.sample && (
                <span
                  className="viewer-map-status"
                  data-status={mapNoticeStatus}
                  data-fallback={fallbackCamera || undefined}
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
              {!settings.matchScore &&
                data.deadTimes?.some((period) => tick >= period.start && tick < period.end) && (
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
          <ViewerCameraControls
            activeCamera={activeCamera}
            has3DMap={has3DMap}
            cameraNotice={cameraNotice}
            changeCamera={changeCamera}
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
      <div className="viewer-surface" inert={mapLoading}>
        {settings.matchScore && !buffering && (
          <MatchScore
            data={data}
            frame={frame}
            tick={tick}
            objective={
              objective && !panel ? <ObjectiveHud value={objective} variant="score" /> : undefined
            }
            objectiveCaption={
              objective && !panel ? <ObjectiveContext value={objective} /> : undefined
            }
            objectiveDescription={objective && !panel ? objectiveDescription(objective) : undefined}
            chromeVisible={controlsVisible && !(panel && compactPanels)}
            onOpenScoreboard={openScoreFromHeader}
          />
        )}
        {showReviewFeed && (
          <ReviewFeed
            kills={feedKills}
            utilities={feedUtilities}
            activeTab={feedTab}
            onTabChange={setFeedTab}
            chromeVisible={controlsVisible}
            modal={compactPanels}
            focusOnOpen={compactPanels}
            onClose={closeReviewFeed}
            {...reviewFeedActions}
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
          inert={mapLoading || (Boolean(panel) && compactPanels)}
        >
          <Suspense fallback={<div className="scene-fallback">{t('Starting renderer…')}</div>}>
            <ReplayFrameContext.Provider value={replayFrames}>
              <Scene
                key={sceneKey}
                data={data}
                tick={tick}
                mobile={mobile}
                playing={playing}
                buffering={buffering}
                mode={mode}
                selected={selected}
                settings={settings}
                mapAssets={mapAssets}
                assetScope={user?.id || 'public'}
                onMapStatus={reportMap}
                focus={grenadeFocus}
                onAudioListener={cameraAudio}
                overlayLayout={overlayLayout}
              />
            </ReplayFrameContext.Provider>
          </Suspense>
          {recordedFlash !== undefined && settings.flashFeedback !== 'off' && (
            <FlashFeedback presentation={settings.flashFeedback} opacity={recordedFlash} />
          )}
          {settings.damageFeedback && showPovEffects && !buffering && spectatorEvents && (
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
          {!buffering && !using2D && settings.utilities && mapRender?.smokeUnavailable && (
            <div className="smoke-unavailable" role="status">
              {t('Smoke rendering is unavailable.')}
            </div>
          )}
          {scopeFov !== undefined && (
            <div className="viewer-scope" aria-hidden="true" data-scope-fov={scopeFov}>
              {settings.crosshair && <span />}
            </div>
          )}
          {scopeFov === undefined &&
            settings.crosshair &&
            selectedPosition?.alive &&
            showPovEffects &&
            (settings.crosshairSource === 'player' ? (
              <RecordedCrosshair code={playerCrosshairCode} />
            ) : (
              <Crosshair value={settings.crosshairStyle} />
            ))}
          <div
            className="viewer-game-hud"
            data-viewer-chrome
            inert={!controlsVisible}
            aria-hidden={!controlsVisible}
          >
            {settings.killfeed && spectatorEvents && (
              <div className="killfeed">
                {killfeedAt(spectatorEvents, tick, rate).map((e, i) => (
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
                tick={
                  playing && !buffering
                    ? Math.max(first, Math.floor(tick / radarInterval) * radarInterval)
                    : tick
                }
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
          chromeVisible={controlsVisible}
          onSelect={selectPlayer}
        />
        <div
          className="viewer-objective-layer"
          data-viewer-chrome
          inert={!controlsVisible}
          aria-hidden={!controlsVisible}
        >
          {!settings.matchScore && objective && !panel && <ObjectiveHud value={objective} />}
        </div>
        <div
          ref={playbackDock}
          inert={!controlsVisible || (Boolean(panel) && compactPanels)}
          data-viewer-chrome
          aria-hidden={!controlsVisible}
          className="viewer-dock"
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
              <ViewerTimelineScope
                timelineScope={timelineScope}
                hasRounds={!!data.rounds.length}
                setTimelineScope={setTimelineScope}
              />
            </div>
            <ViewerSpeedControls speed={speed} changeSpeed={changeSpeed} />
            <div className="viewer-transport">
              <button
                className="icon-button transport-round"
                aria-label={t('Previous round')}
                title={t('Previous round')}
                disabled={!previousRound}
                onClick={() => previousRound && seek(previousRound.liveTick ?? previousRound.tick)}
              >
                <SkipBack size={18} />
              </button>
              <button
                className="icon-button transport-long"
                aria-label={t('Rewind fifteen seconds')}
                title={t('Rewind fifteen seconds')}
                onClick={() => seek(tick - rate * 15)}
              >
                <RotateCcw size={18} />
                <small>15</small>
              </button>
              <button
                className="icon-button transport-step transport-back"
                aria-label={t('Rewind five seconds')}
                title={t('Rewind five seconds')}
                onClick={() => seek(tick - rate * 5)}
              >
                <RotateCcw size={18} />
                <small>5</small>
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
                className="icon-button transport-step transport-forward"
                aria-label={t('Forward five seconds')}
                title={t('Forward five seconds')}
                onClick={() => seek(tick + rate * 5)}
              >
                <RotateCw size={18} />
                <small>5</small>
              </button>
              <button
                className="icon-button transport-long"
                aria-label={t('Forward fifteen seconds')}
                title={t('Forward fifteen seconds')}
                onClick={() => seek(tick + rate * 15)}
              >
                <RotateCw size={18} />
                <small>15</small>
              </button>
              <button
                className="icon-button transport-round"
                aria-label={t('Next live round')}
                title={t('Next live round')}
                disabled={!nextRound}
                onClick={() => nextRound && seek(nextRound.liveTick ?? nextRound.tick)}
              >
                <SkipForward size={18} />
              </button>
              <ViewerSpeedControls speed={speed} changeSpeed={changeSpeed} dropdown />
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
                label={t('Replay tools')}
                onOpenChange={(open) => {
                  if (open) eventMenuTrigger.current = mobileMoreTrigger.current;
                }}
                trigger={
                  <button
                    ref={mobileMoreTrigger}
                    className="icon-button mobile-viewer-menu"
                    aria-label={t('Replay tools')}
                    title={t('Replay tools')}
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
                    id: 'round-events',
                    label: t('Kills and utility'),
                    onSelect: () => {
                      reviewFeedTrigger.current = mobileMoreTrigger.current;
                      if (compactPanels) setCompactFeedOpen(true);
                      else setSettings((value) => ({ ...value, reviewFeed: true }));
                    },
                  },
                  {
                    id: 'timeline-options',
                    label: t('Timeline options'),
                    icon: <SlidersHorizontal size={16} />,
                    onSelect: () => setTimelineOptionsOpen(true),
                  },
                  {
                    id: 'previous-round',
                    label: t('Previous round'),
                    icon: <SkipBack size={16} />,
                    separatorBefore: true,
                    disabled: !previousRound,
                    onSelect: () =>
                      previousRound && seek(previousRound.liveTick ?? previousRound.tick),
                  },
                  {
                    id: 'next-live-round',
                    label: t('Next live round'),
                    icon: <SkipForward size={16} />,
                    disabled: !nextRound,
                    onSelect: () => nextRound && seek(nextRound.liveTick ?? nextRound.tick),
                  },
                  {
                    id: 'rewind-fifteen',
                    label: t('Rewind fifteen seconds'),
                    onSelect: () => seek(tick - rate * 15),
                  },
                  {
                    id: 'forward-fifteen',
                    label: t('Forward fifteen seconds'),
                    onSelect: () => seek(tick + rate * 15),
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
            </div>
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
          compactProfile={mobile || mapRender?.compactTracerProfile}
          settings={settings}
          playerCrosshairCode={playerCrosshairCode}
          equipment={mapRender?.map === data.map ? mapRender.equipment : undefined}
          renderResolution={mapRender?.map === data.map ? mapRender.resolution : undefined}
          shadowsPaused={mapRender?.map === data.map && mapRender.shadowsPaused}
          mapAcquisition={mapAssets.acquisition}
          recordedMapIdentity={data.mapIdentity}
          audio={audio}
          gameAudio={gameAudio}
          onChange={(value) => {
            if (value.reviewFeed !== settings.reviewFeed) {
              reviewFeedTrigger.current = optionsTrigger.current;
              setCompactFeedOpen(value.reviewFeed);
            }
            setSettings(value);
          }}
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
      {mapLoading && (
        <ViewerLoading
          key="opening"
          back={returnLink}
          label={
            preparation?.title ??
            (mapAssets.status === 'pending'
              ? 'Loading map assets…'
              : using2D
                ? 'Loading map overview…'
                : 'Loading 3D map…')
          }
          detail={
            <>
              <span className="match-map">{mapName(data.map)}</span>
              {preparation && t(preparation.description)}
            </>
          }
          model={preparation || using2D ? undefined : mapRender?.modelProgress}
        >
          {preparation && (
            <button
              className="button"
              onClick={() => {
                setEarlyReviewScene(sceneKey);
                chrome.show();
                requestAnimationFrame(() =>
                  playbackDock.current
                    ?.querySelector<HTMLInputElement>('.timeline-slider')
                    ?.focus({ preventScroll: true }),
                );
              }}
            >
              {t('Open timeline')}
            </button>
          )}
        </ViewerLoading>
      )}
    </div>
  );
}
