import { entityPlayback } from '../world/entity-playback';
import { ReplayFrameContext } from '../replay-frames';
import { NativePasses } from '../world/frame-context';
import { NativeWorld, type LoadedWorld } from '../world/NativeWorld';
import { deviceTextureTier } from '../world/textures';
import type { FramePasses } from '../world/compositor';
import type { WeaponAnchor } from '../agent-attachment';
import { recordedFootPose, type FootPoseAt } from '../agent-feet';
import { recordedAirWeight } from '../agent-vertical';
import { deathCameraEvidence, deathCameraView, watchedDeath } from '../spectator-state';
import { playerShadows } from '../player-shadows';
import { PlayerContactShadow, PlayerSunPass } from './PlayerShadow';
import { t } from '../i18n';
import {
  Component,
  useContext,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { ReactNode } from 'react';
import type { ListenerPose } from '../viewer-audio';
import type { WallTrace } from '../shot-wall-audio';
import {
  AdaptiveResolution,
  adaptiveDetailDpr,
  mapDetailDpr,
  type RenderQuality,
} from '../adaptive-resolution';
import { Canvas, useFrame, useThree, type RootState } from '@react-three/fiber';
import { renderDevice, type RenderDevice } from '../render-device';
import { OrbitControls } from '@react-three/drei';
import ActorOverlays, {
  createActorOverlay,
  useActorOverlayFrame,
  type ActorOverlay,
} from './ActorOverlays';
import type { ActorOverlayLayout } from '../actor-overlay';
import * as THREE from 'three';
import type { Playback, Position } from '../types';
import TacticalPlot from './TacticalPlot';
import GrenadePaths from './GrenadePaths';
import ShotTracers from './ShotTracers';
import {
  buildUtilityZoneIndex,
  projectilesAt,
  type ProjectileState,
  type UtilityZone,
} from '../utility-state';
type UtilityPresentation = {
  projectiles: ProjectileState[];
  zones: UtilityZone[];
  bombWave?: BombShockwaveSample;
};
export type SceneFocus = {
  id: string;
  target: { x: number; y: number; z: number };
  origin?: { x: number; y: number; z: number };
  fromTick?: number;
  untilTick?: number;
};
import {
  frameAt,
  playbackBounds,
  defaultSettings,
  shotTracersEnabled,
  type ViewerSettings,
} from '../playback';
import { Line } from '@react-three/drei';
import { freeCameraAction, typingOrDialog } from '../free-camera';
import { installFreeCameraLook } from '../free-camera-look';
import { thirdPersonFollow } from '../follow-camera';
import type { SceneTrace } from '../world/queries';
import {
  firstPersonView,
  overheadDistance,
  recordedEyePosition,
  scopedVerticalFov,
} from '../pov-camera';
import type { SmokeSample } from '../smoke-field';
import Smoke from './Smoke';
import { mapSurface, type MapUnavailableReason } from '../map-availability';
import MapUnavailable from './MapUnavailable';
import { mapAcquisitionMessage, type DemoMapState } from '../demo-map-assets';
import type { AssetStatus } from '../map-assets';
import { useEquipmentAssets, type EquipmentRenderState } from '../equipment-assets';
import { equipmentIconKey } from '../equipment-icons';
import { projectileEquipment } from '../projectile-equipment';
import { useAgentAssets } from '../agent-assets';
import { useModelLeases } from '../equipment-loader';
import { playerPose, type PoseTiming } from '../player-pose';
import {
  agentActionAt,
  agentRoundAt,
  deadAgentsAt,
  indexAgentDraws,
  indexAgentEvents,
  povActionAt,
} from '../agent-replay';
import { encodeGaitHistory, type GaitHistory } from '../../../shared/agent-gait-history.mjs';
import { streamedReplayViews } from '../replay-cache';
import type { DirectionalSample } from '../directional-agent';
import { indexRecordedTravel, recordedMotion, type PreviousPose } from '../recorded-motion';
import './spectator-hud.css';
import RenderAgent, {
  GenericAgentBody,
  RecordedAgentBody,
  AgentModels,
  type AgentInstanceStatus,
} from './RenderAgent';
import { indexItems, itemsAt, hasRecordedProjectiles, type PresentItem } from '../item-state';
import {
  EquipmentModels,
  EquipmentModelInstance,
  HeldEquipment,
  RecordedEquipment,
  ProjectileFallback,
  type EquipmentInstanceStatus,
} from './RenderEquipment';
import EquipmentFire from './EquipmentFire';
import PovEquipmentPass from './PovEquipmentPass';
import SampleLighting from './SampleLighting';
import PovViewmodel from './PovViewmodel';
import { type MapSun } from '../actor-sun';
import { indexBombShockwaves, type BombShockwaveSample } from '../bomb-shockwave';
import GrenadeBurst from './GrenadeBurst';
import InfernoEffects from './InfernoEffects';
import BombShockwave from './BombShockwave';
import { useReducedMotion } from '../reduced-motion';
export type MapRenderState = {
  map: string;
  model: AssetStatus;
  compactTracerProfile?: boolean;
  renderer: '3d' | '2d';
  failure?: 'webgl' | 'textures' | 'model' | 'assets';
  resolution?: number;
  shadowsPaused?: boolean;
  smokeUnavailable?: boolean;
  equipment?: EquipmentRenderState;
};
type MapResources = DemoMapState & {
  reportOverview: (image: string, version: string, status: 'ready' | 'error') => void;
  retryAcquisition?: () => void;
};

const UNIT = 0.0254;
const devicePixelRatio = () => window.devicePixelRatio || 1;
const cssPixelRatio = () => 1;
const mobileDetailDpr = () =>
  mapDetailDpr(devicePixelRatio(), window.innerWidth * window.innerHeight, 'mobile');
const highDetailDpr = () =>
  mapDetailDpr(devicePixelRatio(), window.innerWidth * window.innerHeight, 'desktop');
const autoDesktopDpr = () => Math.max(Math.min(1.75, devicePixelRatio()), mobileDetailDpr());

function subscribeToDevicePixelRatio(update: () => void) {
  let media: MediaQueryList;
  const track = () => {
    media?.removeEventListener('change', track);
    media = window.matchMedia(`(resolution: ${devicePixelRatio()}dppx)`);
    media.addEventListener('change', track);
    update();
  };
  track();
  window.addEventListener('resize', update);
  return () => {
    media.removeEventListener('change', track);
    window.removeEventListener('resize', update);
  };
}
const vector = (p: Position) => new THREE.Vector3(p.x * UNIT, p.z * UNIT, -p.y * UNIT);
function Box({
  position,
  size,
  color = '#c4ac8e',
}: {
  position: [number, number, number];
  size: [number, number, number];
  color?: string;
}) {
  return (
    <mesh position={position} castShadow receiveShadow>
      <boxGeometry args={size} />
      <meshStandardMaterial color={color} roughness={0.94} />
    </mesh>
  );
}
function Courtyard() {
  const buildings = useMemo(
    () => [
      { p: [-22, 5, -8], s: [9, 10, 24], c: '#c6b294' },
      { p: [22, 6, -5], s: [10, 12, 28], c: '#d8c6a6' },
      { p: [-9, 4, -23], s: [18, 8, 8], c: '#d8c6a6' },
      { p: [12, 6, -24], s: [12, 12, 8], c: '#ad9984' },
      { p: [-23, 3, 15], s: [8, 6, 14], c: '#a78a6d' },
      { p: [23, 4, 18], s: [8, 8, 12], c: '#c6b294' },
      { p: [-9, 2.4, 22], s: [18, 4.8, 5], c: '#d8c6a6' },
      { p: [12, 2.4, 22], s: [12, 4.8, 5], c: '#c6b294' },
    ],
    [],
  );
  return (
    <group>
      <Box position={[0, -0.25, 0]} size={[70, 0.5, 70]} color="#c4b092" />
      <Box position={[0, -0.02, 0]} size={[21, 0.04, 35]} color="#d2c0a1" />
      {buildings.map((b, i) => (
        <group key={i}>
          <Box
            position={b.p as [number, number, number]}
            size={b.s as [number, number, number]}
            color={b.c}
          />
          <Box
            position={[b.p[0], b.p[1] + b.s[1] / 2, b.p[2]]}
            size={[b.s[0] + 0.6, 0.4, b.s[2] + 0.6]}
            color="#9c8a73"
          />
          {Array.from({ length: 4 }, (_, j) => (
            <Box
              key={j}
              position={[b.p[0] + (j - 1.5) * 1.6, b.p[1] + 1, b.p[2] + b.s[2] / 2 + 0.04]}
              size={[0.8, 1.4, 0.1]}
              color="#4f605b"
            />
          ))}
        </group>
      ))}
      {[-14, 14].map((x) => (
        <group key={x} position={[x, 0, 0]}>
          <Box position={[0, 1.7, 0]} size={[2, 3.4, 6]} color="#bfa789" />
          <Box position={[0, 3.5, 0]} size={[2.4, 0.3, 6.4]} color="#d5c2a4" />
        </group>
      ))}
      <group position={[6, 0, -5]}>
        <Box position={[0, 1, 0]} size={[2, 2, 2]} color="#8a795e" />
        <Box position={[2.1, 1, 0]} size={[2, 2, 2]} color="#998668" />
        <Box position={[1, 3, 0]} size={[2, 2, 2]} color="#9c8764" />
        {[0, 2.1].map((x) => (
          <Box key={x} position={[x, 1, 1.02]} size={[0.1, 2, 0.05]} color="#494e48" />
        ))}
      </group>
      <group position={[-7, 0, 7]}>
        <Box position={[0, 0.6, 0]} size={[3, 1.2, 2]} color="#8c806a" />
        <Box position={[0, 1.25, 0]} size={[3.2, 0.15, 2.2]} color="#a29780" />
      </group>
      {[-1, 1].map((x) => (
        <group key={x} position={[x * 17, 0, -17]}>
          <mesh position={[0, 3.5, 0]} castShadow>
            <cylinderGeometry args={[0.22, 0.4, 7, 8]} />
            <meshStandardMaterial color="#766c54" />
          </mesh>
          {Array.from({ length: 7 }, (_, i) => (
            <mesh
              key={i}
              position={[Math.cos(i * 0.9) * 1.8, 7.1, Math.sin(i * 0.9) * 1.8]}
              rotation={[0.3, i * 0.9, 0.15]}
              castShadow
            >
              <sphereGeometry args={[1, 8, 5]} />
              <meshStandardMaterial color="#59664a" />
            </mesh>
          ))}
        </group>
      ))}
      <mesh position={[0, 0.015, -5]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[2.1, 2.18, 48]} />
        <meshBasicMaterial color="#9d6750" />
      </mesh>
    </group>
  );
}
function Agent({
  data,
  position,
  next,
  alpha,
  xray,
  labels,
  overlays,
  hideNearCamera,
  contactTrace,
  contactShadow,
  footPoseAt,
  airborne,
  shadowPose,
  sample,
  model,
  tick,
  timing,
  previous,
  gaitHistory,
  travelMeters,
  action,
}: {
  data: Playback;
  position: Position;
  next?: Position;
  alpha: number;
  xray: boolean;
  labels: boolean;
  overlays?: ActorOverlay;
  hideNearCamera: boolean;
  contactTrace: ReturnType<SceneTrace['fork']> | null;
  contactShadow: boolean;
  footPoseAt?: FootPoseAt;
  airborne?: number;
  shadowPose: boolean;
  sample: boolean;
  model: string | null;
  tick: number;
  timing: PoseTiming;
  previous?: PreviousPose;
  gaitHistory?: GaitHistory;
  travelMeters?: number;
  action?: DirectionalSample['action'];
}) {
  const replayFrames = useContext(ReplayFrameContext);
  const pose = playerPose(position, next, alpha, timing);
  const motion = recordedMotion(position, next, alpha, timing, previous);
  const weaponAnchor = useRef<WeaponAnchor | null>(null);
  const registerWeaponAnchor = useCallback((bone: WeaponAnchor) => {
    weaponAnchor.current = bone;
    return () => {
      if (weaponAnchor.current === bone) {
        weaponAnchor.current = null;
      }
    };
  }, []);
  const ref = useRef<THREE.Group>(null);
  const headAnchor = useRef<THREE.Bone | null>(null);
  const overlayAnchor = useMemo(() => ({ body: ref, head: headAnchor, height: 0, yaw: 0 }), []);
  useLayoutEffect(() => {
    if (!overlays) return;
    overlays.anchors.set(position.id, overlayAnchor);
    return () => {
      overlays.anchors.delete(position.id);
    };
  }, [overlays, position.id, overlayAnchor]);
  const registerHeadAnchor = useCallback((bone: THREE.Bone) => {
    headAnchor.current = bone;
    return () => {
      if (headAnchor.current === bone) headAnchor.current = null;
    };
  }, []);
  const { camera } = useThree();
  const eye = useRef(new THREE.Vector3());
  useFrame(() => {
    if (!ref.current) return;
    const current = frameAt(data, replayFrames?.tick ?? tick);
    const from = current.frame.players.find((p) => p.id === position.id) ?? position;
    const to = current.next.players.find((p) => p.id === position.id);
    const pose = playerPose(from, to, current.alpha, {
      fromTick: current.frame.tick,
      nextTick: current.next.tick,
      tickRate: data.tickRate,
      roundBoundary: data.rounds.some(
        (r) => r.tick > current.frame.tick && r.tick <= current.next.tick,
      ),
    });
    if (overlays) {
      overlayAnchor.height = 2.08 - (pose.duck ?? 0) * 0.65;
      overlayAnchor.yaw = pose.yaw;
    }
    ref.current.position.set(pose.x * UNIT, pose.z * UNIT, -pose.y * UNIT);
    ref.current.rotation.y = THREE.MathUtils.degToRad(pose.yaw);
    const near =
      hideNearCamera &&
      camera.position.distanceToSquared(eye.current.fromArray(recordedEyePosition(pose))) < 0.25;
    ref.current.visible = !near;
  }, -3);
  const color = position.team === 3 ? '#9ec7da' : '#e7ba73';
  if (!position.alive) return null;
  return (
    <group ref={ref}>
      {model ? (
        <RenderAgent
          url={model}
          id={position.id}
          tick={tick}
          rate={timing.tickRate}
          speed={motion.speed}
          gaitHistory={gaitHistory}
          travelMeters={travelMeters}
          footPoseAt={footPoseAt}
          floor={contactTrace ?? undefined}
          airborne={airborne}
          shadowPose={shadowPose}
          directional={{
            yaw: pose.yaw,
            pitch: pose.pitch,
            weapon: pose.weapon,
            velocityX: motion.velocityX,
            velocityY: motion.velocityY,
            action,
            defusing: pose.defusing,
          }}
          duck={pose.duck ?? 0}
          xrayColor={xray ? color : undefined}
          registerWeaponAnchor={registerWeaponAnchor}
          registerHeadAnchor={labels ? registerHeadAnchor : undefined}
          fallback={
            <GenericAgentBody
              team={position.team}
              id={position.id}
              xray={xray}
              castStatic={sample}
            />
          }
        />
      ) : (
        <GenericAgentBody team={position.team} id={position.id} xray={xray} castStatic={sample} />
      )}
      <HeldEquipment position={pose} anchor={weaponAnchor} released={action?.released} />
      {contactShadow && contactTrace && <PlayerContactShadow body={ref} trace={contactTrace} />}
    </group>
  );
}
// The synthetic courtyard has no native world, so it renders the scene directly.
function SampleFrame({ active }: { active: boolean }) {
  useFrame(({ gl, scene, camera }) => {
    if (active) gl.render(scene, camera);
  }, 1);
  return null;
}
function World({
  data,
  low,
  tick,
  shadows,
  mode,
  selected,
  model,
  modelReady,
  reportModel,
  sun,
  preview,
  settings,
  tracers,
  agents,
  focus,
  utilityState,
  items,
  onAudioListener,
  onSmokeUnavailable,
  overlays,
  overlayLayout,
}: {
  data: Playback;
  low: boolean;
  tick: number;
  shadows: boolean;
  mode: string;
  selected: string;
  model: string | null;
  modelReady: boolean;
  reportModel: (url: string, status: 'pending' | 'ready' | 'error', sun?: MapSun | null) => void;
  sun: MapSun | null;
  preview: boolean;
  settings: ViewerSettings;
  tracers: boolean;
  agents: { ct: string | null; t: string | null };
  focus?: SceneFocus;
  utilityState: UtilityPresentation;
  items: PresentItem[];
  onSmokeUnavailable: (unavailable: boolean) => void;
  onAudioListener?: (pose: ListenerPose | null, wallTrace?: WallTrace) => void;
  overlays?: ActorOverlay;
  overlayLayout?: ActorOverlayLayout;
}) {
  const { camera, gl, invalidate } = useThree();
  const replayFrames = useContext(ReplayFrameContext);
  useLayoutEffect(() => replayFrames?.attach(invalidate), [replayFrames, invalidate]);
  useFrame(() => replayFrames?.sample(performance.now()), -100);
  const isNative = !!model?.endsWith('/map.json') && !data.sample;
  const nativePasses = useMemo<FramePasses>(() => ({}), [model]);
  const [nativeWorld, registerNative] = useState<LoadedWorld | null>(null);
  const labelSmoke = useRef<SmokeSample[]>([]);
  const seekNative = useMemo(
    () =>
      nativeWorld &&
      entityPlayback(
        nativeWorld.manifest.entities,
        data.mapBreakables,
        data.mapDoors,
        data.mapVisibility,
        nativeWorld.native.updateEntity,
        nativeWorld.queries.updateEntity,
      ),
    [nativeWorld, data.mapBreakables, data.mapDoors, data.mapVisibility],
  );
  useFrame(() => seekNative?.(replayFrames?.tick ?? tick), -90);
  useActorOverlayFrame(
    overlays,
    overlayLayout,
    selected,
    settings.xray,
    labelSmoke,
    nativeWorld?.queries,
  );
  const [contextRevision, setContextRevision] = useState(0);
  useLayoutEffect(() => {
    const restored = () => {
      // The filtered sky and static shadows were rendered into the lost context.
      gl.shadowMap.needsUpdate = true;
      setContextRevision((revision) => revision + 1);
      invalidate();
    };
    gl.domElement.addEventListener('webglcontextrestored', restored);
    return () => gl.domElement.removeEventListener('webglcontextrestored', restored);
  }, [gl, invalidate]);
  const actors = useRef<THREE.Group>(null);
  const playerLighting = useMemo(playerShadows, [contextRevision]);
  useLayoutEffect(() => () => playerLighting.dispose(), [playerLighting]);
  const traceWallAudio =
    Boolean(data.gameplaySounds && data.gameplaySounds.coverage.weapon !== 'unavailable') &&
    !preview &&
    Boolean(onAudioListener) &&
    settings.gameSounds &&
    settings.soundWeapons &&
    !settings.audioMuted;
  const traceMap =
    traceWallAudio ||
    !shadows ||
    Boolean(agents.ct || agents.t) ||
    mode === 'follow' ||
    mode === 'pov' ||
    Boolean(focus) ||
    tracers ||
    items.some(({ kind }) => kind !== 'projectile');
  const followTrace = useMemo(
    () => (traceMap && nativeWorld?.queries.trace) || null,
    [traceMap, nativeWorld],
  );
  const wallAudioTrace = useMemo(
    () => (traceWallAudio ? followTrace?.fork(0) : undefined),
    [followTrace, traceWallAudio],
  );
  const tracerTrace = useMemo(
    () => (tracers ? followTrace?.fork() : undefined),
    [followTrace, tracers],
  );
  const smokeSunTrace = useMemo(() => followTrace?.fork(), [followTrace]);
  // Separate per-actor floor queries keep their paused-ray caches independent.
  const floorTraces = useMemo(
    () => new Map(followTrace ? data.players.map(({ id }) => [id, followTrace.fork(0)]) : []),
    [data.players, followTrace],
  );
  const footPoseAt = useMemo(
    () => recordedFootPose(data),
    [data.frames, data.rounds, data.tickRate],
  );
  const movement = useRef(new Set<string>());
  const fastMovement = useRef(false);
  useLayoutEffect(
    () => invalidate(),
    [
      invalidate,
      data,
      tick,
      mode,
      selected,
      model,
      modelReady,
      followTrace,
      settings,
      focus,
      utilityState,
      items,
    ],
  );
  const orbit = useRef<React.ComponentRef<typeof OrbitControls>>(null);
  useEffect(() => {
    if (mode !== 'orbit' || preview || data.sample || !(camera instanceof THREE.PerspectiveCamera))
      return;
    return installFreeCameraLook(
      gl.domElement,
      camera,
      invalidate,
      settings.lookSensitivity,
      settings.invertLook,
    );
  }, [
    mode,
    preview,
    data.sample,
    camera,
    gl,
    invalidate,
    settings.lookSensitivity,
    settings.invertLook,
  ]);
  useEffect(() => {
    if (mode !== 'orbit' || preview) return;
    const root = gl.domElement.closest('.viewer-frame');
    if (!root) return;
    const heldKeys = new Map<string, string>();
    const down = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.ctrlKey ||
        event.altKey ||
        event.metaKey ||
        typingOrDialog(event.target) ||
        document.querySelector('dialog[open],[aria-modal="true"],[role="menu"],[role="listbox"]')
      )
        return;
      if (
        event.target instanceof Node &&
        event.target !== document.body &&
        !root.contains(event.target)
      )
        return;
      const action = freeCameraAction(event);
      if (!action) {
        if (movement.current.size && fastMovement.current !== event.shiftKey) {
          fastMovement.current = event.shiftKey;
          invalidate();
        }
        return;
      }
      fastMovement.current = event.shiftKey;
      event.preventDefault();
      heldKeys.set(event.code || event.key.toLowerCase(), action);
      movement.current.add(action);
      invalidate();
    };
    const up = (event: KeyboardEvent) => {
      const wasFast = fastMovement.current;
      fastMovement.current = event.shiftKey;
      const key = event.code || event.key.toLowerCase();
      const action = heldKeys.get(key);
      heldKeys.delete(key);
      if (action && ![...heldKeys.values()].includes(action)) movement.current.delete(action);
      if (action || (movement.current.size && wasFast !== fastMovement.current)) invalidate();
    };
    const clear = () => {
      const moving = heldKeys.size || movement.current.size || fastMovement.current;
      heldKeys.clear();
      movement.current.clear();
      fastMovement.current = false;
      if (moving) invalidate();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', clear);
    document.addEventListener('focusin', clear);
    return () => {
      clear();
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', clear);
      document.removeEventListener('focusin', clear);
    };
  }, [mode, preview, gl, invalidate]);
  const { index, previous, frame, next, alpha } = frameAt(data, tick);
  const airWeights = useMemo(() => {
    const weights = new Map<string, [number, number]>();
    if (!preview && !data.sample)
      for (const p of frame.players) {
        if (!p.alive) continue;
        const from = recordedAirWeight(data, p.id, index);
        const to = next === frame ? from : recordedAirWeight(data, p.id, index + 1);
        if (from || to) weights.set(p.id, [from, to]);
      }
    return weights;
  }, [preview, data.frames, data.rounds, data.tickRate, data.sample, frame, index, next]);
  const airAt = (id: string) => {
    const weights = airWeights.get(id);
    return weights
      ? THREE.MathUtils.lerp(weights[0], weights[1], THREE.MathUtils.smoothstep(alpha, 0, 1))
      : 0;
  };
  const recordedTravel = useMemo(
    () => indexRecordedTravel(data.frames, data.strideAnchor, data.rounds, data.tickRate),
    [data.frames, data.strideAnchor, data.rounds, data.tickRate],
  );
  const nextPlayers = useMemo(() => new Map(next.players.map((p) => [p.id, p])), [next]);
  const previousPlayers = useMemo(() => {
    if (!previous) return;
    const crossedRound = data.rounds.some(
      (round) => round.tick > previous.tick && round.tick <= frame.tick,
    );
    return new Map(
      previous.players.map((position): [string, PreviousPose] => [
        position.id,
        { position: crossedRound ? undefined : position, tick: previous.tick },
      ]),
    );
  }, [previous, frame.tick, data.rounds]);
  const gaitHistory = useMemo(
    () => data.gaitHistory ?? (streamedReplayViews.has(data) ? undefined : encodeGaitHistory(data)),
    [data],
  );
  const agentEvents = useMemo(
    () => indexAgentEvents(data),
    [data.events, data.players, data.sample, data.agentDeaths, data.throwInputs, data.tickRate],
  );
  const draws = useMemo(() => indexAgentDraws(data), [data.frames, data.rounds, data.tickRate]);
  const reduceAgentMotion = useReducedMotion();
  const round = agentRoundAt(data.rounds, tick);
  const bodies = preview ? [] : deadAgentsAt(data, agentEvents, tick, round, frame);
  const viewedPlayer = frame.players.find((player) => player.id === selected);
  const death =
    mode === 'pov' && !preview
      ? watchedDeath(data, agentEvents.deaths.get(selected), selected, tick, 3, frame)
      : undefined;
  const deathView = useMemo(
    () => death && deathCameraEvidence(data, death, selected),
    [data, death, selected],
  );
  const scopeFov = mode === 'pov' && !death ? scopedVerticalFov(viewedPlayer) : undefined;
  const fov = scopeFov ?? settings.cameraFov;
  useLayoutEffect(() => {
    if (!(camera instanceof THREE.PerspectiveCamera) || camera.fov === fov) return;
    camera.fov = fov;
    camera.updateProjectionMatrix();
    invalidate();
  }, [camera, fov, invalidate]);
  const poseTiming: PoseTiming = {
    fromTick: frame.tick,
    nextTick: next.tick,
    tickRate: data.tickRate,
    roundBoundary: data.rounds.some((round) => round.tick > frame.tick && round.tick <= next.tick),
  };
  const bounds = useMemo(() => {
    if (data.sample) return { center: new THREE.Vector3(0, 0, 0), extent: 52, height: 0 };
    const b = playbackBounds(data);
    const box = new THREE.Box3(
      new THREE.Vector3(b.minX * UNIT, b.minZ * UNIT, -b.maxY * UNIT),
      new THREE.Vector3(b.maxX * UNIT, b.maxZ * UNIT, -b.minY * UNIT),
    );
    if (box.isEmpty()) return { center: new THREE.Vector3(), extent: 80, height: 0 };
    const size = box.getSize(new THREE.Vector3());
    return {
      center: box.getCenter(new THREE.Vector3()),
      extent: Math.max(size.x, size.z, 20),
      height: size.y,
    };
  }, [data.sample, data.worldBounds, data.worldBounds ? null : data.frames]);
  const focusTrace = focus ? followTrace : null;
  const freeView = useRef<{ position: THREE.Vector3; target: THREE.Vector3 }>(undefined);
  useLayoutEffect(() => {
    if (mode !== 'orbit') return;
    const observed =
      (viewedPlayer?.alive ? viewedPlayer : undefined) ??
      frame.players.find((player) => player.alive);
    const eye = observed && !data.sample ? firstPersonView(observed) : undefined;
    const overview = bounds.center
      .clone()
      .add(
        data.sample
          ? new THREE.Vector3(bounds.extent * 0.57, bounds.extent * 0.65, bounds.extent * 0.62)
          : new THREE.Vector3(0, bounds.extent * 1.3, 0.01),
      );
    const saved = focus ? undefined : freeView.current;
    const target =
      saved?.target ?? (eye ? new THREE.Vector3(...eye.target) : bounds.center.clone());
    camera.position.copy(saved?.position ?? (eye ? new THREE.Vector3(...eye.position) : overview));
    if (focus) {
      target.set(focus.target.x * UNIT, focus.target.z * UNIT, -focus.target.y * UNIT);
      if (eye && focusTrace) {
        const origin =
          focus.origin &&
          new THREE.Vector3(focus.origin.x * UNIT, focus.origin.z * UNIT, -focus.origin.y * UNIT);
        const extent = origin ? THREE.MathUtils.clamp(origin.distanceTo(target) * 0.7, 10, 32) : 16;
        const overview = target
          .clone()
          .add(new THREE.Vector3(extent * 0.65, extent * 0.9, extent * 0.65));
        camera.position.fromArray(
          focusTrace({ target: eye.position, position: overview.toArray() }),
        );
      }
    }
    camera.lookAt(target);
    orbit.current?.target.copy(target);
    orbit.current?.update();
    invalidate();
    return () => {
      if (focus) return;
      freeView.current = {
        position: camera.position.clone(),
        target:
          (data.sample && orbit.current?.target.clone()) ||
          camera.position
            .clone()
            .add(camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(8)),
      };
    };
  }, [mode, bounds, camera, focus?.id, focusTrace, invalidate]);
  const currentBoundary = poseTiming.roundBoundary;
  const overheadTarget = useMemo(() => new THREE.Vector3(), []);
  useFrame(({ size }, delta) => {
    if (mode === 'orbit') {
      if (
        !movement.current.size ||
        document.querySelector('dialog[open],[aria-modal="true"],[role="menu"],[role="listbox"]')
      )
        return;
      const forward = camera.getWorldDirection(new THREE.Vector3());
      const right = forward.clone().cross(camera.up).normalize();
      const shift = new THREE.Vector3();
      for (const action of movement.current) {
        if (action === 'forward') shift.add(forward);
        if (action === 'back') shift.sub(forward);
        if (action === 'left') shift.sub(right);
        if (action === 'right') shift.add(right);
        if (action === 'up') shift.y += 1;
        if (action === 'down') shift.y -= 1;
      }
      if (shift.lengthSq())
        shift
          .normalize()
          .multiplyScalar(
            Math.min(delta, 0.05) * settings.freeCameraSpeed * (fastMovement.current ? 3 : 1),
          );
      camera.position.add(shift);
      orbit.current?.target.add(shift);
      orbit.current?.update();
      if (movement.current.size) invalidate();
      return;
    }
    if (mode === 'tactical') {
      overheadTarget.copy(bounds.center);
      let distance = bounds.extent * 1.15;
      if (camera instanceof THREE.PerspectiveCamera) {
        const top = overlayLayout?.titleBottom ?? 0;
        const bottom =
          overlayLayout?.dockTop === undefined ? size.height : overlayLayout.dockTop - 14;
        const usable = size.height > 0 ? (bottom - top) / size.height : 1;
        const framed = usable >= 0.35 && usable <= 1;
        const aspect = framed ? Math.min(camera.aspect, usable) : camera.aspect;
        const groundDistance = overheadDistance(bounds.extent, camera.fov, aspect);
        distance = groundDistance + bounds.height / 2;
        if (framed) {
          const visibleCenter = (top + bottom) / (2 * size.height);
          overheadTarget.z +=
            (0.5 - visibleCenter) *
            2 *
            groundDistance *
            Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
        }
      }
      camera.position.set(overheadTarget.x, overheadTarget.y + distance, overheadTarget.z + 0.01);
      camera.lookAt(overheadTarget);
      return;
    }
    if (deathView && death) {
      const view = deathCameraView(
        deathView,
        (tick - death.tick) / data.tickRate,
        reduceAgentMotion,
      );
      camera.position.fromArray(view.position);
      camera.lookAt(...view.target);
      return;
    }
    const current = frameAt(data, replayFrames?.tick ?? tick);
    const alpha = current.alpha;
    const poseTiming = {
      fromTick: current.frame.tick,
      nextTick: current.next.tick,
      tickRate: data.tickRate,
      roundBoundary:
        current.frame.tick !== frame.tick
          ? data.rounds.some((r) => r.tick > current.frame.tick && r.tick <= current.next.tick)
          : currentBoundary,
    };
    const p = current.frame.players.find((p) => p.id === selected);
    if (!p) return;
    const n = current.next.players.find((next) => next.id === p.id);
    if (mode === 'follow') {
      const follow = thirdPersonFollow(p, n, alpha, poseTiming);
      if (!follow) return;
      let position = followTrace?.(follow) ?? follow.position;
      const [x, y, z] = follow.target;
      if (followTrace && Math.hypot(position[0] - x, position[2] - z) < 1.05) {
        const yaw = THREE.MathUtils.degToRad(playerPose(p, n, alpha, poseTiming).yaw);
        const across: [number, number, number] = [
          follow.position[0] - Math.sin(yaw) * 3.2,
          follow.position[1],
          follow.position[2] - Math.cos(yaw) * 3.2,
        ];
        const alternate = followTrace({ position: across, target: follow.target });
        if (
          Math.hypot(alternate[0] - x, alternate[2] - z) >
          Math.hypot(position[0] - x, position[2] - z)
        )
          position = alternate;
      }
      // At a fully retracted boom the camera would look through the selected model.
      if (Math.hypot(position[0] - x, position[1] - y, position[2] - z) >= 0.65) {
        camera.position.fromArray(position);
        camera.lookAt(...follow.target);
        return;
      }
    }
    const view = firstPersonView(playerPose(p, n, alpha, poseTiming));
    camera.position.fromArray(view.position);
    camera.lookAt(...view.target);
  }, -4);
  const audioForward = useRef(new THREE.Vector3());
  const audioUp = useRef(new THREE.Vector3());
  useFrame(() => {
    if (!onAudioListener) return;
    camera.getWorldDirection(audioForward.current);
    audioUp.current.set(0, 1, 0).applyQuaternion(camera.quaternion);
    onAudioListener(
      {
        position: camera.position.toArray(),
        forward: audioForward.current.toArray(),
        up: audioUp.current.toArray(),
      },
      wallAudioTrace,
    );
  });
  useEffect(() => () => onAudioListener?.(null), [onAudioListener]);
  const showPovEquipment =
    !preview &&
    mode === 'pov' &&
    scopeFov === undefined &&
    viewedPlayer?.alive &&
    !death &&
    (data.sample || modelReady);

  return (
    <NativePasses.Provider value={isNative ? nativePasses : null}>
      <>
        {data.sample && (
          <>
            <SampleLighting />
            <SampleFrame active={!showPovEquipment} />
          </>
        )}
        {isNative && (
          <NativeWorld
            url={model!}
            passes={nativePasses}
            register={registerNative}
            shadows={playerLighting}
            tactical={mode === 'tactical'}
            loaded={reportModel}
          />
        )}
        {data.sample && <Courtyard />}
        <PlayerSunPass
          root={actors}
          pipeline={playerLighting}
          sun={shadows && !preview ? sun : null}
        />
        <group visible={Boolean(data.sample) || modelReady}>
          <group ref={actors} visible={Boolean(data.sample) || modelReady}>
            {frame.players
              .filter(
                (p) =>
                  p.alive &&
                  !(mode === 'pov' && p.id === viewedPlayer?.id) &&
                  !bodies.some((body) => body.position.id === p.id),
              )
              .map((p) => (
                <Agent
                  data={data}
                  key={p.id}
                  position={p}
                  next={nextPlayers.get(p.id)}
                  alpha={alpha}
                  xray={settings.xray && !preview}
                  labels={settings.playerLabels && !preview && (Boolean(data.sample) || modelReady)}
                  overlays={overlays}
                  hideNearCamera={
                    !preview &&
                    !data.sample &&
                    (mode === 'orbit' || (mode === 'follow' && p.id === selected))
                  }
                  contactTrace={floorTraces.get(p.id) ?? null}
                  contactShadow={!shadows}
                  footPoseAt={preview || data.sample ? undefined : footPoseAt}
                  airborne={airAt(p.id)}
                  shadowPose={shadows && Boolean(sun)}
                  sample={Boolean(data.sample)}
                  model={!preview ? (p.team === 3 ? agents.ct : agents.t) : null}
                  tick={tick}
                  timing={poseTiming}
                  previous={previousPlayers?.get(p.id)}
                  gaitHistory={gaitHistory}
                  travelMeters={recordedTravel?.(frame, next, p.id, alpha)}
                  action={agentActionAt(
                    agentEvents,
                    draws,
                    p,
                    tick,
                    data.tickRate,
                    round?.tick ?? 0,
                    !preview && !reduceAgentMotion,
                    settings.shotEffects,
                  )}
                />
              ))}
            {bodies.map((body) => (
              <RecordedAgentBody
                key={body.position.id + ':' + body.variant}
                body={body}
                url={body.position.team === 3 ? agents.ct : agents.t}
                tick={tick}
                rate={data.tickRate}
                reducedMotion={reduceAgentMotion}
                shadowPose={shadows && Boolean(sun)}
                floor={floorTraces.get(body.position.id)}
              />
            ))}
          </group>
          {showPovEquipment && (
            <PovEquipmentPass sample={Boolean(data.sample)} sun={sun} trace={followTrace}>
              <PovViewmodel
                agentModel={viewedPlayer.team === 3 ? agents.ct : agents.t}
                gaitHistory={gaitHistory}
                action={povActionAt(
                  agentEvents,
                  viewedPlayer,
                  tick,
                  data.tickRate,
                  round?.tick ?? 0,
                )}
                native={!data.sample}
                airborne={airAt(viewedPlayer.id)}
                history={data}
                tick={tick}
                position={viewedPlayer}
                next={nextPlayers.get(viewedPlayer.id)}
                previous={previousPlayers?.get(viewedPlayer.id)}
                travelMeters={recordedTravel?.(frame, next, viewedPlayer.id, alpha)}
                alpha={alpha}
                timing={poseTiming}
              />
            </PovEquipmentPass>
          )}
          {!preview && tracers && tracerTrace && (
            <ShotTracers
              data={data}
              tick={tick}
              pov={mode === 'pov' ? selected : undefined}
              trace={tracerTrace}
            />
          )}
          {!preview && <RecordedEquipment items={items} floor={followTrace} />}
          {!preview && settings.utilities && (
            <Smoke
              data={data}
              zones={utilityState.zones}
              tick={tick}
              modelReady={modelReady}
              onUnavailable={onSmokeUnavailable}
              sunTrace={smokeSunTrace}
              low={low}
              xray={settings.xray}
              sun={sun}
              labelSmoke={labelSmoke}
            />
          )}
          {!preview && (
            <UtilityLayer
              data={data}
              tick={tick}
              nativeVolume={modelReady}
              staticMap={nativeWorld?.queries ?? null}
              lightBursts={!low}
              selected={selected}
              settings={settings}
              utilityState={utilityState}
            />
          )}
          {mode === 'orbit' &&
            focus &&
            tick >= (focus.fromTick ?? -Infinity) &&
            tick <= (focus.untilTick ?? Infinity) && (
              <mesh
                name="review-impact-target"
                position={[
                  focus.target.x * UNIT,
                  focus.target.z * UNIT + 0.05,
                  -focus.target.y * UNIT,
                ]}
                rotation={[-Math.PI / 2, 0, 0]}
                renderOrder={11}
              >
                <ringGeometry args={[0.4, 0.47, 32]} />
                <meshBasicMaterial color="#e4b575" depthTest={false} transparent opacity={0.8} />
              </mesh>
            )}
        </group>
        {data.sample && (
          <OrbitControls
            ref={orbit}
            enabled={mode === 'orbit' && !preview}
            enableDamping
            minPolarAngle={0.02}
            maxPolarAngle={Math.PI - 0.02}
            minDistance={3}
            maxDistance={bounds.extent * 3}
          />
        )}
      </>
    </NativePasses.Provider>
  );
}
function UtilityLayer({
  data,
  tick,
  nativeVolume,
  staticMap,
  lightBursts,
  selected,
  settings,
  utilityState,
}: {
  data: Playback;
  tick: number;
  nativeVolume: boolean;
  staticMap: THREE.Group | import('../world/queries').WorldQueries | null;
  lightBursts: boolean;
  selected: string;
  settings: ViewerSettings;
  utilityState: UtilityPresentation;
}) {
  const { zones: utility, projectiles, bombWave } = utilityState;
  const reducedMotion = useReducedMotion();
  const trail = useMemo(() => {
    if (!settings.trails) return [];
    const frames = data.frames.filter((f) => f.tick <= tick && f.tick > tick - data.tickRate * 5);
    return frames
      .map((f) => f.players.find((p) => p.id === selected))
      .filter((p): p is Position => !!p && p.alive)
      .map((p) => vector(p).add(new THREE.Vector3(0, 0.1, 0)));
  }, [data, tick, selected, settings.trails]);
  return (
    <>
      {bombWave && <BombShockwave wave={bombWave} />}
      {settings.utilities && (
        <>
          <GrenadeBurst
            zones={utility}
            staticMap={staticMap}
            lighting={lightBursts}
            warm={nativeVolume || data.sample}
            tick={tick}
            rate={data.tickRate}
            reducedMotion={reducedMotion}
          />
          <InfernoEffects
            infernos={data.infernos}
            warm={nativeVolume || data.sample}
            lighting={lightBursts}
            events={data.events}
            tick={tick}
            rate={data.tickRate}
            reducedMotion={reducedMotion}
          />
        </>
      )}
      {settings.trajectories !== 'off' && (
        <GrenadePaths data={data} tick={tick} selected={selected} mode={settings.trajectories} />
      )}
      {projectiles.map((grenade) => (
        <group key={grenade.id} name={'recorded-projectile:' + grenade.id}>
          {!hasRecordedProjectiles(data) && (
            <group
              position={[grenade.point.x * UNIT, grenade.point.z * UNIT, -grenade.point.y * UNIT]}
            >
              <EquipmentModelInstance
                equipment={projectileEquipment(grenade.kind) || ''}
                instance={'trajectory-projectile:' + grenade.id}
                projectile
                fallback={<ProjectileFallback />}
              />
            </group>
          )}
        </group>
      ))}
      {trail.length > 1 && (
        <Line points={trail} color="#ffffff" lineWidth={1.5} transparent opacity={0.6} />
      )}
    </>
  );
}
class SceneBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { error: boolean }
> {
  state = { error: false };
  static getDerivedStateFromError() {
    return { error: true };
  }
  render() {
    return this.state.error ? this.props.fallback : this.props.children;
  }
}
function RendererFallback({ children, report }: { children: ReactNode; report: () => void }) {
  useLayoutEffect(report, [report]);
  return children;
}
function MeasureRenderCadence({
  active,
  resolution,
  ceiling,
  shadows,
  allowShadows,
  onChange,
}: {
  active: boolean;
  resolution: number;
  ceiling: number;
  shadows: boolean;
  allowShadows: boolean;
  onChange: (quality: RenderQuality) => void;
}) {
  const monitor = useMemo(() => new AdaptiveResolution(), [active, ceiling]);
  useEffect(() => {
    const reset = () => monitor.reset();
    document.addEventListener('visibilitychange', reset);
    return () => document.removeEventListener('visibilitychange', reset);
  }, [monitor]);
  useFrame(() => {
    if (!active || document.hidden) return;
    const current = { resolution, shadows };
    const next = monitor.sample(performance.now(), current, ceiling, allowShadows);
    if (next !== current) onChange(next);
  });
  return null;
}

export default function Scene({
  data,
  tick = 400,
  mode = 'orbit',
  selected = '0',
  preview = false,
  mobile = false,
  playing = false,
  buffering = false,
  settings = defaultSettings,
  mapAssets,
  assetScope = 'public',
  onMapStatus,
  focus,
  onAudioListener,
  overlayLayout,
}: {
  data: Playback;
  tick?: number;
  mode?: string;
  selected?: string;
  preview?: boolean;
  mobile?: boolean;
  playing?: boolean;
  buffering?: boolean;
  settings?: ViewerSettings;
  mapAssets: MapResources;
  assetScope?: string;
  onMapStatus?: (state: MapRenderState) => void;
  focus?: SceneFocus;
  onAudioListener?: (pose: ListenerPose | null, wallTrace?: WallTrace) => void;
  overlayLayout?: ActorOverlayLayout;
}) {
  const actorOverlay = useMemo(createActorOverlay, []);
  const projectActors = !preview && (settings.playerLabels || mode === 'tactical');
  const listenerScope = useMemo(() => ({}), [assetScope, data.map, onAudioListener]);
  const currentListenerScope = useRef(listenerScope);
  currentListenerScope.current = listenerScope;
  const reportAudioListener = useCallback(
    (pose: ListenerPose | null, wallTrace?: WallTrace) => {
      if (currentListenerScope.current === listenerScope) onAudioListener?.(pose, wallTrace);
    },
    [listenerScope, onAudioListener],
  );
  const equipmentIdentity = useMemo(() => ({}), [data.map, assetScope]);
  const equipmentAssets = useEquipmentAssets(`${assetScope}:${data.map}`, !preview && !data.sample);
  const agentAssets = useAgentAssets(`${assetScope}:${data.map}`, !preview && !data.sample);
  const agents = agentAssets.assets;
  useModelLeases(
    [agents.ct, agents.t].filter((url): url is string => !!url),
    equipmentIdentity,
  );
  const [agentStatuses, setAgentStatuses] = useState<{
    identity: object;
    items: Record<string, AgentInstanceStatus>;
  }>({ identity: equipmentIdentity, items: {} });
  const currentAgentIdentity = useRef(equipmentIdentity);
  currentAgentIdentity.current = equipmentIdentity;
  const reportAgent = useMemo(
    () => (id: string, status: AgentInstanceStatus | null) => {
      if (currentAgentIdentity.current !== equipmentIdentity) return;
      setAgentStatuses((previous) => {
        const items = previous.identity === equipmentIdentity ? previous.items : {};
        if (items[id] === status || (status === null && !Object.hasOwn(items, id))) return previous;
        const next = { ...items };
        if (status === null) delete next[id];
        else next[id] = status;
        return { identity: equipmentIdentity, items: next };
      });
    },
    [equipmentIdentity],
  );
  const agentContext = useMemo(
    () => ({ identity: equipmentIdentity, report: reportAgent }),
    [equipmentIdentity, reportAgent],
  );
  const agentCounts = useMemo(() => {
    const counts = { ready: 0, pending: 0, error: 0 };
    if (agentStatuses.identity === equipmentIdentity)
      for (const [id, status] of Object.entries(agentStatuses.items)) {
        // Only living actors contribute to the live roster. Every mounted rig must finish loading.
        if (status !== 'ready' || !id.startsWith('death:')) counts[status]++;
      }
    return counts;
  }, [agentStatuses, equipmentIdentity]);
  const currentPlayers = frameAt(data, tick).frame.players;
  const viewedAgentId =
    currentPlayers.find((player) => player.id === selected)?.id || currentPlayers[0]?.id;
  const visibleAgentCount = currentPlayers.filter(
    (player) => player.alive && !(mode === 'pov' && player.id === viewedAgentId),
  ).length;
  const currentEquipmentIdentity = useRef(equipmentIdentity);
  currentEquipmentIdentity.current = equipmentIdentity;
  const [equipmentStatuses, setEquipmentStatuses] = useState<{
    identity: object;
    items: Record<string, EquipmentInstanceStatus>;
  }>({ identity: equipmentIdentity, items: {} });
  const reportEquipment = useMemo(
    () => (instance: string, status: EquipmentInstanceStatus | null) => {
      if (currentEquipmentIdentity.current !== equipmentIdentity) return;
      setEquipmentStatuses((previous) => {
        const items = previous.identity === equipmentIdentity ? previous.items : {};
        if (items[instance] === status || (status === null && !Object.hasOwn(items, instance)))
          return previous;
        const next = { ...items };
        if (status === null) delete next[instance];
        else next[instance] = status;
        return { identity: equipmentIdentity, items: next };
      });
    },
    [equipmentIdentity],
  );
  const equipmentContext = useMemo(
    () => ({
      identity: equipmentIdentity,
      catalog: equipmentAssets.catalog,
      report: reportEquipment,
    }),
    [equipmentIdentity, equipmentAssets.catalog, reportEquipment],
  );
  const itemIndex = useMemo(() => indexItems(data.itemSamples), [data.itemSamples]);
  const liveItems = useMemo(
    () =>
      itemsAt(itemIndex, tick).filter(
        (item) => item.kind !== 'projectile' || hasRecordedProjectiles(data),
      ),
    [itemIndex, tick, data.itemState],
  );
  const equipmentCounts = useMemo(() => {
    const counts = { ready: 0, pending: 0, error: 0 };
    const readyInstances: string[] = [];
    if (equipmentStatuses.identity === equipmentIdentity)
      for (const [id, status] of Object.entries(equipmentStatuses.items)) {
        counts[status]++;
        if (status === 'ready') readyInstances.push(id);
      }
    return { ...counts, readyInstances: readyInstances.sort().join(',') };
  }, [equipmentStatuses, equipmentIdentity]);
  const [fallbackLow, setFallbackLow] = useState(
    () =>
      window.matchMedia('(max-width:780px),(pointer:coarse)').matches ||
      navigator.hardwareConcurrency <= 4,
  );
  useEffect(() => {
    const media = window.matchMedia('(max-width:780px),(pointer:coarse)');
    const update = () => setFallbackLow(media.matches || navigator.hardwareConcurrency <= 4);
    media.addEventListener('change', update);
    update();
    return () => media.removeEventListener('change', update);
  }, []);
  const [gpu, setGpu] = useState<RenderDevice>();
  const auto = settings.quality === 'auto';
  const probingGpu = auto && gpu === undefined;
  const autoMobile = auto && (gpu === 'integrated' || (gpu === 'unknown' && fallbackLow));
  const prefersCompact = (auto && (gpu === 'software' || gpu === 'limited')) || autoMobile;
  const wantsLow = settings.quality === 'low' || prefersCompact || autoMobile;
  const model = mapAssets.assets.model;
  const low = wantsLow;
  const [adaptiveQuality, setAdaptiveQuality] = useState({
    resolution: settings.renderResolution,
    shadows: true,
  });
  useEffect(
    () => setAdaptiveQuality({ resolution: settings.renderResolution, shadows: true }),
    [assetScope, data.map, settings.quality, settings.renderResolution],
  );
  const adaptive = auto && !preview;
  const resolution =
    adaptive && playing
      ? Math.min(adaptiveQuality.resolution, settings.renderResolution)
      : settings.renderResolution;
  const shadows = !low && (!adaptive || adaptiveQuality.shadows);
  const detailedLow =
    low && !preview && (settings.quality === 'low' || (gpu !== 'software' && gpu !== 'limited'));
  const targetDpr = useSyncExternalStore(
    subscribeToDevicePixelRatio,
    low
      ? detailedLow
        ? mobileDetailDpr
        : cssPixelRatio
      : settings.quality === 'high' && !preview
        ? highDetailDpr
        : autoDesktopDpr,
  );
  const renderDpr =
    detailedLow && adaptive && playing
      ? adaptiveDetailDpr(targetDpr, resolution, settings.renderResolution)
      : targetDpr * (resolution / 100);
  const zonesAt = useMemo(
    () => buildUtilityZoneIndex(data.events, data.tickRate, true),
    [data.events, data.tickRate],
  );
  const bombWaveAt = useMemo(
    () => indexBombShockwaves(data.events, data.tickRate),
    [data.events, data.tickRate],
  );
  const reducedMotion = useReducedMotion();
  const compactTracerProfile = mobile || prefersCompact;
  const tracers = !preview && !reducedMotion && shotTracersEnabled(settings, compactTracerProfile);
  const utilityState = useMemo(
    () => ({
      projectiles: preview ? [] : projectilesAt(data.grenades || [], tick, data.tickRate, false),
      zones: preview || !settings.utilities ? [] : zonesAt(tick),
      bombWave:
        preview || !settings.utilities || reducedMotion ? undefined : bombWaveAt(tick, itemIndex),
    }),
    [
      data.grenades,
      data.tickRate,
      tick,
      zonesAt,
      bombWaveAt,
      itemIndex,
      reducedMotion,
      preview,
      settings.utilities,
    ],
  );
  const expectedEquipment =
    !preview && !data.sample
      ? [
          ...currentPlayers
            .filter((player) => player.alive && player.weapon)
            .map((player) => player.weapon),
          ...liveItems.map((item) => item.equipment),
          ...(!hasRecordedProjectiles(data)
            ? utilityState.projectiles.map(
                (projectile) => projectileEquipment(projectile.kind) || 'unknown-projectile',
              )
            : []),
        ]
      : [];
  const unavailableEquipment = expectedEquipment.filter((equipment) => {
    const id = equipmentIconKey(equipment);
    return !id || !equipmentAssets.catalog.items[id];
  }).length;
  const [modelLoad, setModelLoad] = useState<{
    url: string;
    status: 'pending' | 'ready' | 'error';
    sun: MapSun | null;
  }>();
  const currentModel = useRef(model);
  currentModel.current = model;
  const reportModel = useCallback(
    (url: string, status: 'pending' | 'ready' | 'error', sun: MapSun | null = null) => {
      if (currentModel.current === url)
        setModelLoad((previous) =>
          previous?.url === url && previous.status === status && previous.sun === sun
            ? previous
            : { url, status, sun },
        );
    },
    [],
  );
  const modelStatus: AssetStatus =
    mapAssets.status === 'pending'
      ? 'pending'
      : mapAssets.status === 'error'
        ? 'error'
        : model
          ? modelLoad?.url === model
            ? probingGpu
              ? 'pending'
              : modelLoad.status
            : 'pending'
          : 'missing';
  const [rendererFailure, setRendererFailure] = useState<string>();
  const rendererAttempt = useMemo(
    () => ({ map: data.map, failed: false }),
    [data.map, mode === '2d'],
  );
  const currentRendererAttempt = useRef(rendererAttempt);
  currentRendererAttempt.current = rendererAttempt;
  const reportRendererFallback = useCallback(() => {
    if (currentRendererAttempt.current !== rendererAttempt) return;
    rendererAttempt.failed = true;
    setRendererFailure(rendererAttempt.map);
  }, [rendererAttempt]);
  const reportRendererCreated = useCallback(
    ({ gl }: RootState) => {
      if (currentRendererAttempt.current !== rendererAttempt || rendererAttempt.failed) return;
      setGpu(renderDevice(gl.getContext()));
      setRendererFailure((previous) => (previous === rendererAttempt.map ? undefined : previous));
    },
    [rendererAttempt],
  );
  const equipmentReady = equipmentCounts.ready;
  const equipmentFailed =
    equipmentAssets.status === 'error' ? expectedEquipment.length : equipmentCounts.error;
  const equipmentUnavailable =
    equipmentAssets.status === 'pending' || equipmentAssets.status === 'error'
      ? 0
      : unavailableEquipment;
  const [smokeUnavailable, setSmokeUnavailable] = useState(false);
  const textureTier = useMemo(deviceTextureTier, []);
  const surface = mapSurface({
    sample: Boolean(data.sample),
    requested2D: mode === '2d',
    discovery: mapAssets.status,
    model,
    modelStatus,
    rendererFailed: rendererFailure === data.map && rendererAttempt.failed,
    textureSupport: data.sample || textureTier !== null,
  });
  const equipmentActive = surface === '3d';
  const equipmentPending =
    equipmentAssets.status === 'pending'
      ? expectedEquipment.length
      : equipmentActive
        ? equipmentCounts.pending
        : 0;
  const smokeEnabled = surface === '3d' && !preview && settings.utilities;
  const smokeFailed = smokeEnabled && smokeUnavailable;
  const equipmentReport = useMemo<EquipmentRenderState>(
    () => ({
      status: equipmentAssets.status,
      active: equipmentActive,
      expected: expectedEquipment.length,
      ready: equipmentReady,
      pending: equipmentPending,
      unavailable: equipmentUnavailable,
      failed: equipmentFailed,
    }),
    [
      equipmentAssets.status,
      equipmentActive,
      expectedEquipment.length,
      equipmentReady,
      equipmentPending,
      equipmentUnavailable,
      equipmentFailed,
    ],
  );
  useLayoutEffect(
    () =>
      onMapStatus?.({
        map: data.map,
        model: data.sample ? 'ready' : modelStatus,
        compactTracerProfile,
        renderer: surface === 'plot' ? '2d' : '3d',
        failure:
          !data.sample && textureTier === null
            ? 'textures'
            : rendererFailure === data.map
              ? 'webgl'
              : mapAssets.status === 'error'
                ? 'assets'
                : modelStatus === 'error'
                  ? 'model'
                  : undefined,
        resolution: surface === '3d' ? resolution : undefined,
        shadowsPaused: surface === '3d' && adaptive && !low && !shadows,
        smokeUnavailable: smokeFailed,
        equipment: equipmentReport,
      }),
    [
      data.map,
      data.sample,
      modelStatus,
      compactTracerProfile,
      mode,
      rendererFailure,
      resolution,
      adaptive,
      low,
      shadows,
      onMapStatus,
      surface,
      mapAssets.status,
      equipmentReport,
      smokeFailed,
    ],
  );
  const unavailableReason: MapUnavailableReason =
    mapAssets.status === 'pending'
      ? 'loading'
      : rendererFailure === data.map
        ? 'renderer-error'
        : mapAssets.status === 'error'
          ? 'discovery-error'
          : modelStatus === 'error'
            ? 'model-error'
            : mode === '2d' && model
              ? 'overview'
              : 'missing';
  const unavailableAction =
    mapAssets.acquisition?.acquisition === 'failed' &&
    mapAssets.acquisition.canAcquire &&
    mapAssets.retryAcquisition
      ? {
          label: mapAssets.requesting ? 'Requesting map preparation' : 'Retry map preparation',
          onClick: mapAssets.retryAcquisition,
          disabled: mapAssets.requesting,
        }
      : undefined;
  const plot = (
    <TacticalPlot
      data={data}
      tick={tick}
      selected={selected}
      settings={settings}
      overview={mapAssets.assets.overview}
      overviewStatus={mapAssets.overviewStatus}
      onOverviewState={mapAssets.reportOverview}
      unavailableReason={unavailableReason}
      unavailableNotice={mapAcquisitionMessage(mapAssets)}
      unavailableAction={unavailableAction}
      focus={
        focus && tick >= (focus.fromTick ?? -Infinity) && tick <= (focus.untilTick ?? Infinity)
          ? focus.target
          : undefined
      }
    />
  );
  return (
    <div
      className="scene"
      data-quality={probingGpu ? 'probing' : low ? 'low' : 'high'}
      data-render-device={gpu}
      data-map-tier={probingGpu || !model ? undefined : (textureTier ?? undefined)}
      data-render-resolution={resolution}
      data-live-shadows={shadows}
      data-agent-model-state={agentAssets.status}
      data-agent-ready-count={agentCounts.ready}
      data-agent-pending-count={agentCounts.pending}
      data-agent-fallback-count={Math.max(0, visibleAgentCount - agentCounts.ready)}
      data-agent-error-count={agentCounts.error}
      data-equipment-model-state={equipmentAssets.status}
      data-equipment-expected-count={expectedEquipment.length}
      data-equipment-pending-count={equipmentPending}
      data-equipment-unavailable-count={unavailableEquipment}
      data-equipment-ready-count={equipmentReady}
      data-equipment-error-count={equipmentCounts.error}
      data-equipment-ready-instances={equipmentCounts.readyInstances}
      data-recorded-world-item-count={liveItems.length}
      data-recorded-item-rotation-count={
        liveItems.filter((item) => item.pitch !== undefined).length
      }
      data-smoke-state={smokeEnabled ? (smokeFailed ? 'unavailable' : 'ready') : undefined}
      data-camera-mode={mode}
      data-camera-fov={settings.cameraFov}
      data-map-model-state={data.sample ? 'ready' : modelStatus}
      data-focus-x={focus?.target.x}
      data-focus-y={focus?.target.y}
      data-focus-z={focus?.target.z}
      data-projectile-count={utilityState.projectiles.length}
      data-utility-zone-count={utilityState.zones.length}
      role={surface === '3d' ? 'img' : undefined}
      aria-label={
        surface !== '3d'
          ? undefined
          : data.sample
            ? t('An original 3D training courtyard with ten players')
            : t(
                modelStatus === 'ready'
                  ? '3D map {{map}} with recorded player positions'
                  : 'Loading 3D map…',
                { map: data.map },
              )
      }
    >
      {surface === 'plot' ? (
        plot
      ) : surface === 'loading' ? (
        <MapUnavailable reason="loading" notice={mapAcquisitionMessage(mapAssets)} />
      ) : (
        <>
          <SceneBoundary
            key={data.map}
            fallback={<RendererFallback report={reportRendererFallback}>{plot}</RendererFallback>}
          >
            <Canvas
              frameloop={preview ? 'always' : 'demand'}
              onCreated={reportRendererCreated}
              shadows={shadows}
              dpr={renderDpr}
              camera={{ position: [32, 36, 34], fov: settings.cameraFov, near: 0.05, far: 3000 }}
              gl={{ antialias: true, stencil: true, powerPreference: 'high-performance' }}
              fallback={<span>{t('3D rendering is unavailable.')}</span>}
            >
              {!probingGpu && adaptive && (
                <MeasureRenderCadence
                  key={`${data.map}:${model}:${mode}`}
                  active={
                    playing && !buffering && (Boolean(data.sample) || modelStatus === 'ready')
                  }
                  resolution={resolution}
                  ceiling={settings.renderResolution}
                  shadows={shadows}
                  allowShadows={!low}
                  onChange={setAdaptiveQuality}
                />
              )}
              {!probingGpu && (
                <EquipmentFire
                  data={data}
                  tick={tick}
                  low={low}
                  enabled={settings.shotEffects}
                  tracers={tracers}
                >
                  <EquipmentModels.Provider value={equipmentContext}>
                    <AgentModels.Provider value={agentContext}>
                      <World
                        data={data}
                        low={low}
                        tick={tick}
                        shadows={shadows}
                        mode={mode}
                        selected={selected}
                        model={model}
                        modelReady={modelStatus === 'ready'}
                        reportModel={reportModel}
                        sun={
                          modelLoad?.url === model && modelLoad.status === 'ready'
                            ? modelLoad.sun
                            : null
                        }
                        preview={preview}
                        settings={settings}
                        tracers={tracers}
                        agents={agents}
                        focus={focus}
                        overlays={projectActors ? actorOverlay : undefined}
                        overlayLayout={overlayLayout}
                        utilityState={utilityState}
                        items={liveItems}
                        onAudioListener={reportAudioListener}
                        onSmokeUnavailable={setSmokeUnavailable}
                      />
                    </AgentModels.Provider>
                  </EquipmentModels.Provider>
                </EquipmentFire>
              )}
            </Canvas>
            {projectActors && (data.sample || modelStatus === 'ready') && (
              <ActorOverlays
                overlay={actorOverlay}
                players={data.players}
                positions={currentPlayers}
                selected={mode === 'pov' ? (viewedAgentId ?? '') : selected}
                labels={settings.playerLabels}
                mode={mode}
              />
            )}
          </SceneBoundary>
        </>
      )}
    </div>
  );
}
