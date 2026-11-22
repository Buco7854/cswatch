import { t } from '../i18n';
import {
  Component,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { ReactNode, RefObject } from 'react';
import type { ListenerPose } from '../viewer-audio';
import { AdaptiveResolution, type RenderQuality } from '../adaptive-resolution';
import { Canvas, createPortal, useFrame, useThree } from '@react-three/fiber';
import { Html, OrbitControls } from '@react-three/drei';
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
import { followObstruction } from '../follow-obstruction';
import {
  firstPersonView,
  overheadDistance,
  recordedEyePosition,
  scopedVerticalFov,
} from '../pov-camera';
import { smokeHidesLabel } from '../smoke-render-state';
import type { SmokeSample } from '../smoke-field';
import Smoke from './Smoke';
import { mapSurface, type MapUnavailableReason } from '../map-availability';
import MapUnavailable from './MapUnavailable';
import { mapAcquisitionMessage, type DemoMapState } from '../demo-map-assets';
import type { AssetStatus } from '../map-assets';
import { assertMapBaseColorTextures, prepareMapModel } from '../map-model';
import { renderSkyBehindMap, skyCameraFor, updateSkyCamera } from '../sky-render';
import { useMapGLTF, useMapModelScope } from '../map-loader';
import type { ModelProgressSource, ModelScope } from '../model-cache';
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
import { installSourceBlackMaterials, type SourceFogResources } from '../source-black-material';
type SourceFogReference = { current: SourceFogResources };
import type { MapEnvironment } from '../../../shared/map-assets';
import { daylightFallback, mapEnvironmentKey, useMapEnvironment } from '../map-environment';
import EquipmentFire from './EquipmentFire';
import PovEquipmentPass from './PovEquipmentPass';
import PovViewmodel from './PovViewmodel';
import { useMapShadowCache } from '../useMapShadowCache';
import SceneGrade from './SceneGrade';
import SceneLighting from './SceneLighting';
import { mapSun, type MapSun } from '../map-sun';
import { useMapSkyLighting } from '../useMapSkyLighting';
import { indexBombShockwaves, type BombShockwaveSample } from '../bomb-shockwave';
import GrenadeBurst from './GrenadeBurst';
import InfernoEffects from './InfernoEffects';
import BombShockwave from './BombShockwave';
import { useReducedMotion } from '../reduced-motion';
export type MapRenderState = {
  map: string;
  model: AssetStatus;
  compact?: boolean;
  compactTracerProfile?: boolean;
  modelProgress?: ModelProgressSource;
  renderer: '3d' | '2d';
  failure?: 'webgl' | 'model' | 'assets';
  environment: AssetStatus;
  environmentVersion: string | null;
  landscape: AssetStatus;
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
const MAX_DESKTOP_DPR = 1.75;
const devicePixelRatio = () => window.devicePixelRatio || 1;

function subscribeToDevicePixelRatio(update: () => void) {
  let media: MediaQueryList;
  const track = () => {
    media?.removeEventListener('change', track);
    media = window.matchMedia(`(resolution: ${devicePixelRatio()}dppx)`);
    media.addEventListener('change', track);
    update();
  };
  track();
  return () => media.removeEventListener('change', track);
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
function Model({
  url,
  loaded,
  fogResources,
  scope,
  registerFollowModel,
}: {
  url: string;
  fogResources: SourceFogReference;
  scope: ModelScope;
  registerFollowModel: (model: THREE.Group) => () => void;
  loaded: (
    url: string,
    status: 'ready' | 'error',
    sky?: THREE.Scene | null,
    landscape?: AssetStatus,
    sun?: MapSun | null,
  ) => void;
}) {
  // Prepared map URLs are fixed. Operator pack installs require reloading open
  // tabs to clear this positive loader cache, as documented in tools/assets.
  const gltf = useMapGLTF(url);
  useLayoutEffect(() => scope.acquire(), [scope]);
  const prepared = useMemo(() => {
    const result = prepareMapModel(gltf.scene, gltf.animations);
    assertMapBaseColorTextures({ scene: result.main, parser: gltf.parser });
    let landscape: AssetStatus = result.sky ? 'ready' : 'missing';
    if (result.sky) {
      try {
        assertMapBaseColorTextures({ scene: result.sky, parser: gltf.parser });
      } catch {
        result.sky = null;
        landscape = 'error';
      }
    }
    const compatibility = installSourceBlackMaterials(
      [result.main, ...(result.sky ? [result.sky] : [])],
      () => fogResources.current,
    );
    const sun = mapSun(result.sun, new THREE.Box3().setFromObject(result.main));
    return { ...result, sun, landscape, compatibility };
  }, [gltf, fogResources]);
  useEffect(() => () => prepared.compatibility.dispose(), [prepared]);
  useLayoutEffect(() => {
    if (!gltf.animations.length && scope.isCurrent()) return registerFollowModel(prepared.main);
  }, [gltf, prepared, registerFollowModel, scope]);
  useLayoutEffect(() => {
    if (scope.isCurrent()) loaded(url, 'ready', prepared.sky, prepared.landscape, prepared.sun);
  }, [url, loaded, prepared, scope]);
  return <primitive object={prepared.main} />;
}
function SkyPass({
  sky,
  sun,
  skylight,
}: {
  sky: THREE.Scene;
  sun: MapSun | null;
  skylight: boolean;
}) {
  const camera = useMemo(() => skyCameraFor(sky), [sky]);
  useFrame(({ gl, scene, camera: main }) => {
    const backgroundCamera =
      main instanceof THREE.PerspectiveCamera ? updateSkyCamera(main, camera) : main;
    renderSkyBehindMap(gl, scene, sky, main, backgroundCamera);
  }, 1);
  return createPortal(<SceneLighting sample={false} sun={sun} skylight={skylight} />, sky);
}
function EnvironmentBackground({
  environment,
  sample,
  report,
  resources,
  low,
}: {
  environment: MapEnvironment | null;
  sample: boolean;
  report: (identity: string | null, status: AssetStatus, skylight?: boolean) => void;
  resources: SourceFogReference;
  low: boolean;
}) {
  const { scene, invalidate } = useThree();
  const state = useMapEnvironment(sample ? null : environment);
  const lighting = useMapSkyLighting(state.texture, low);
  useLayoutEffect(() => {
    const previous = scene.environment,
      intensity = scene.environmentIntensity,
      rotation = scene.environmentRotation.clone();
    scene.environment = lighting;
    // The exported backdrop is clamped LDR artwork, not measured HDR radiance.
    // Keep its broad reflected fill below the normalized directional sunlight.
    scene.environmentIntensity = lighting ? environment!.sky.brightness * 0.35 : 1;
    scene.environmentRotation.copy(scene.backgroundRotation);
    invalidate();
    return () => {
      scene.environment = previous;
      scene.environmentIntensity = intensity;
      scene.environmentRotation.copy(rotation);
    };
  }, [scene, lighting, environment?.sky.brightness, invalidate]);
  useLayoutEffect(() => {
    resources.current = { fog: environment?.fog || null, cube: state.texture };
    invalidate();
    return () => {
      resources.current = { fog: null, cube: null };
    };
  }, [resources, environment?.fog, state.texture, invalidate]);
  useLayoutEffect(() => {
    const previous = scene.background,
      intensity = scene.backgroundIntensity;
    scene.background = state.texture || new THREE.Color(sample ? '#aeb6b0' : daylightFallback);
    scene.backgroundIntensity = state.texture ? environment!.sky.brightness : 1;
    invalidate();
    return () => {
      scene.background = previous;
      scene.backgroundIntensity = intensity;
    };
  }, [scene, state.texture, sample, environment?.sky.brightness, invalidate]);
  useLayoutEffect(() => {
    report(state.identity, state.status, Boolean(lighting));
    return () => report(state.identity, 'pending');
  }, [state.identity, state.status, lighting, report]);
  return null;
}
class MapModelBoundary extends Component<
  {
    url: string;
    scope: ModelScope;
    report: (url: string, status: 'ready' | 'error') => void;
    children: ReactNode;
  },
  { error: boolean }
> {
  state = { error: false };
  static getDerivedStateFromError() {
    return { error: true };
  }
  componentDidCatch() {
    // Clear the rejected loader entry immediately. R3F canvas teardown is
    // deferred, and a new viewer must not inherit that rejected promise.
    if (this.props.scope.isCurrent()) this.props.report(this.props.url, 'error');
    this.props.scope.invalidate();
  }
  render() {
    return this.state.error ? null : this.props.children;
  }
}
function Agent({
  position,
  next,
  alpha,
  selected,
  xray,
  name,
  labels,
  labelSmoke,
  hideNearCamera,
  showMarkers,
  model,
  tick,
  timing,
  previous,
  gaitHistory,
  action,
}: {
  position: Position;
  next?: Position;
  alpha: number;
  selected: boolean;
  xray: boolean;
  name?: string;
  labels: boolean;
  labelSmoke: RefObject<SmokeSample[]>;
  hideNearCamera: boolean;
  showMarkers: boolean;
  model: string | null;
  tick: number;
  timing: PoseTiming;
  previous?: PreviousPose;
  gaitHistory?: GaitHistory;
  action?: DirectionalSample['action'];
}) {
  const pose = playerPose(position, next, alpha, timing);
  const motion = recordedMotion(position, next, alpha, timing, previous);
  const weaponAnchor = useRef<THREE.Object3D | null>(null);
  const registerWeaponAnchor = useCallback((bone: THREE.Object3D) => {
    weaponAnchor.current = bone;
    return () => {
      if (weaponAnchor.current === bone) {
        weaponAnchor.current = null;
      }
    };
  }, []);
  const ref = useRef<THREE.Group>(null);
  const labelAnchor = useRef<THREE.Group>(null);
  const labelElement = useRef<HTMLDivElement>(null);
  const headAnchor = useRef<THREE.Bone | null>(null);
  const headPosition = useMemo(() => new THREE.Vector3(), []);
  const registerHeadAnchor = useCallback((bone: THREE.Bone) => {
    headAnchor.current = bone;
    return () => {
      if (headAnchor.current === bone) headAnchor.current = null;
    };
  }, []);
  const { camera } = useThree();
  const eye = useRef(new THREE.Vector3());
  const [nearCamera, setNearCamera] = useState(false);
  const priorNearCamera = useRef(false);
  useFrame(() => {
    if (!ref.current) return;
    ref.current.position.set(pose.x * UNIT, pose.z * UNIT, -pose.y * UNIT);
    ref.current.rotation.y = THREE.MathUtils.degToRad(pose.yaw);
    const near =
      hideNearCamera &&
      camera.position.distanceToSquared(eye.current.fromArray(recordedEyePosition(pose))) < 0.25;
    ref.current.visible = !near;
    if (near !== priorNearCamera.current) {
      priorNearCamera.current = near;
      setNearCamera(near);
    }
  }, -3);
  const fallbackLabelHeight = 2.08 - (pose.duck ?? 0) * 0.65;
  useFrame(() => {
    const group = ref.current;
    const anchor = labelAnchor.current;
    if (!group || !anchor) return;
    anchor.position.set(0, fallbackLabelHeight, 0);
    if (headAnchor.current) {
      // The native locomotion pose is sampled at priority -2. Project the head from that pose.
      const head = group.worldToLocal(headAnchor.current.getWorldPosition(headPosition));
      if (head.y >= 0.25 && head.y <= 2.3 && Math.hypot(head.x, head.z) <= 0.8)
        anchor.position.set(head.x, head.y + 0.24, head.z);
    }
    const label = labelElement.current;
    if (label)
      label.style.visibility =
        !xray &&
        labelSmoke.current.length &&
        smokeHidesLabel(
          labelSmoke.current,
          camera.position.toArray(),
          anchor.getWorldPosition(headPosition).toArray(),
        )
          ? 'hidden'
          : '';
  }, -1);
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
          directional={{
            yaw: pose.yaw,
            pitch: pose.pitch,
            weapon: pose.weapon,
            velocityX: motion.velocityX,
            velocityY: motion.velocityY,
            action,
          }}
          duck={pose.duck ?? 0}
          xrayColor={xray ? color : undefined}
          registerWeaponAnchor={registerWeaponAnchor}
          registerHeadAnchor={labels && showMarkers && name ? registerHeadAnchor : undefined}
          fallback={<GenericAgentBody team={position.team} id={position.id} xray={xray} />}
        />
      ) : (
        <GenericAgentBody team={position.team} id={position.id} xray={xray} />
      )}
      <HeldEquipment position={pose} anchor={weaponAnchor} />
      {showMarkers && labels && name && !nearCamera && (
        <group ref={labelAnchor} position={[0, fallbackLabelHeight, 0]}>
          <Html
            key={xray ? 'through-walls' : 'visible-only'}
            center
            occlude={!xray}
            zIndexRange={[2, 0]}
            style={{ pointerEvents: 'none' }}
          >
            <div
              ref={labelElement}
              className="actor-label"
              data-team={position.team}
              data-player={position.id}
              role="img"
              aria-label={t('{{name}}, {{health}} health', { name, health: position.health })}
            >
              <span className="actor-label-name">{name}</span>
              {Number.isFinite(position.health) && position.health >= 0 && (
                <span className="actor-label-health">
                  <span className="actor-label-track" aria-hidden="true">
                    <span style={{ width: Math.min(100, position.health) + '%' }} />
                  </span>
                  <span>{position.health}</span>
                </span>
              )}
            </div>
          </Html>
        </group>
      )}
      {showMarkers && !labels && (
        <mesh position={[0, 2, 0]}>
          <sphereGeometry args={[selected ? 0.15 : 0.09, 8, 8]} />
          <meshBasicMaterial color={selected ? '#ffffff' : color} />
        </mesh>
      )}
      {showMarkers && selected && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.04, 0]}>
          <ringGeometry args={[0.5, 0.58, 32]} />
          <meshBasicMaterial color="#ffffff" />
        </mesh>
      )}
    </group>
  );
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
  modelScope,
  sky,
  sun,
  skylight,
  environment,
  gradeEnvironment,
  reportEnvironment,
  preview,
  settings,
  tracers,
  agents,
  focus,
  utilityState,
  items,
  onAudioListener,
  onSmokeUnavailable,
}: {
  data: Playback;
  low: boolean;
  tick: number;
  shadows: boolean;
  mode: string;
  selected: string;
  model: string | null;
  modelReady: boolean;
  reportModel: (
    url: string,
    status: 'ready' | 'error',
    sky?: THREE.Scene | null,
    landscape?: AssetStatus,
    sun?: MapSun | null,
  ) => void;
  sky: THREE.Scene | null;
  sun: MapSun | null;
  skylight: boolean;
  modelScope: ModelScope | null;
  environment: MapEnvironment | null;
  gradeEnvironment: MapEnvironment | null;
  reportEnvironment: (identity: string | null, status: AssetStatus, skylight?: boolean) => void;
  preview: boolean;
  settings: ViewerSettings;
  tracers: boolean;
  agents: { ct: string | null; t: string | null };
  focus?: SceneFocus;
  utilityState: UtilityPresentation;
  items: PresentItem[];
  onSmokeUnavailable: (unavailable: boolean) => void;
  onAudioListener?: (pose: ListenerPose | null) => void;
}) {
  const { camera, gl, invalidate } = useThree();
  const labelSmoke = useRef<SmokeSample[]>([]);
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
  useMapShadowCache(!data.sample && shadows);
  const [followModel, setFollowModel] = useState<THREE.Group | null>(null);
  const registerFollowModel = useCallback((map: THREE.Group) => {
    setFollowModel(map);
    return () => setFollowModel((current) => (current === map ? null : current));
  }, []);
  const traceMap = mode === 'follow' || mode === 'pov' || tracers;
  const followTrace = useMemo(
    () => (traceMap && followModel ? followObstruction(followModel) : null),
    [traceMap, followModel],
  );
  const tracerTrace = useMemo(
    () => (tracers ? followTrace?.fork() : undefined),
    [followTrace, tracers],
  );
  const smokeSunTrace = useMemo(() => followTrace?.fork(), [followTrace]);
  const fogResources = useRef<SourceFogResources>({ fog: null, cube: null });
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
      sky,
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
        document.querySelector(
          'dialog[open]:not(.review-feed-inline),[aria-modal="true"],[role="menu"],[role="listbox"]',
        )
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
  const freeView = useRef<{ position: THREE.Vector3; target: THREE.Vector3 } | null>(null);
  const previousMode = useRef<string | undefined>(undefined);
  const { previous, frame, next, alpha } = frameAt(data, tick);
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
    [data.events, data.players, data.sample, data.agentDeaths],
  );
  const draws = useMemo(() => indexAgentDraws(data), [data.frames, data.rounds, data.tickRate]);
  const reduceAgentMotion = useReducedMotion();
  const round = agentRoundAt(data.rounds, tick);
  const bodies = preview ? [] : deadAgentsAt(data, agentEvents, tick, round, frame);
  const viewedPlayer = frame.players.find((player) => player.id === selected);
  const scopeFov = mode === 'pov' ? scopedVerticalFov(viewedPlayer) : undefined;
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
    if (data.sample) return { center: new THREE.Vector3(0, 0, 0), extent: 52 };
    const b = playbackBounds(data);
    const box = new THREE.Box3(
      new THREE.Vector3(b.minX * UNIT, b.minZ * UNIT, -b.maxY * UNIT),
      new THREE.Vector3(b.maxX * UNIT, b.maxZ * UNIT, -b.minY * UNIT),
    );
    if (box.isEmpty()) return { center: new THREE.Vector3(), extent: 80 };
    const size = box.getSize(new THREE.Vector3());
    return { center: box.getCenter(new THREE.Vector3()), extent: Math.max(size.x, size.z, 20) };
  }, [data.sample, data.worldBounds, data.worldBounds ? null : data.frames]);
  useEffect(() => {
    const priorMode = previousMode.current;
    previousMode.current = mode;
    if (mode === 'orbit' && focus) {
      const target = new THREE.Vector3(
        focus.target.x * UNIT,
        focus.target.z * UNIT,
        -focus.target.y * UNIT,
      );
      const origin =
        focus.origin &&
        new THREE.Vector3(focus.origin.x * UNIT, focus.origin.z * UNIT, -focus.origin.y * UNIT);
      const extent = origin ? THREE.MathUtils.clamp(origin.distanceTo(target) * 0.7, 10, 32) : 16;
      camera.position
        .copy(target)
        .add(new THREE.Vector3(extent * 0.65, extent * 0.9, extent * 0.65));
      camera.lookAt(target);
      orbit.current?.target.copy(target);
      orbit.current?.update();
    } else if (mode === 'orbit') {
      let initial = freeView.current;
      if (!initial && !data.sample) {
        if (priorMode === 'pov' || priorMode === 'follow') {
          initial = {
            position: camera.position.clone(),
            target: camera.position
              .clone()
              .add(camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(8)),
          };
        } else {
          const observed = viewedPlayer || frame.players.find((player) => player.alive);
          if (observed) {
            const view = firstPersonView(observed);
            initial = {
              position: new THREE.Vector3(...view.position),
              target: new THREE.Vector3(...view.target),
            };
          }
        }
      }
      camera.position.copy(
        initial?.position ||
          bounds.center
            .clone()
            .add(
              new THREE.Vector3(bounds.extent * 0.57, bounds.extent * 0.65, bounds.extent * 0.62),
            ),
      );
      const target = initial?.target || bounds.center;
      camera.lookAt(target);
      orbit.current?.target.copy(target);
      orbit.current?.update();
    }
    invalidate();
    return () => {
      if (mode === 'orbit')
        freeView.current = {
          position: camera.position.clone(),
          target: data.sample
            ? orbit.current?.target.clone() || bounds.center.clone()
            : camera.position
                .clone()
                .add(camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(8)),
        };
    };
  }, [mode, bounds, camera, focus?.id, invalidate]);
  useFrame((_, delta) => {
    if (mode === 'orbit') {
      if (
        !movement.current.size ||
        document.querySelector(
          'dialog[open]:not(.review-feed-inline),[aria-modal="true"],[role="menu"],[role="listbox"]',
        )
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
      const distance =
        camera instanceof THREE.PerspectiveCamera
          ? overheadDistance(bounds.extent, camera.fov, camera.aspect)
          : bounds.extent * 1.15;
      camera.position.copy(bounds.center).add(new THREE.Vector3(0, distance, 0.01));
      camera.lookAt(bounds.center);
      return;
    }
    const p = viewedPlayer;
    if (!p) return;
    const n = nextPlayers.get(p.id);
    if (mode === 'follow') {
      const follow = thirdPersonFollow(p, n, alpha, poseTiming);
      if (!follow) return;
      const position = followTrace?.(follow) ?? follow.position;
      const [x, y, z] = follow.target;
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
    onAudioListener({
      position: camera.position.toArray(),
      forward: audioForward.current.toArray(),
      up: audioUp.current.toArray(),
    });
  });
  useEffect(() => () => onAudioListener?.(null), [onAudioListener]);
  const showPovEquipment =
    !preview &&
    mode === 'pov' &&
    scopeFov === undefined &&
    viewedPlayer &&
    (data.sample || modelReady);

  return (
    <SceneGrade
      environment={data.sample ? null : gradeEnvironment}
      low={low}
      revision={contextRevision}
      manualWorld={!sky && !showPovEquipment}
    >
      <EnvironmentBackground
        key={contextRevision}
        environment={environment}
        sample={Boolean(data.sample)}
        report={reportEnvironment}
        resources={fogResources}
        low={low}
      />
      {sky && <SkyPass sky={sky} sun={sun} skylight={skylight} />}
      <SceneLighting
        sample={Boolean(data.sample)}
        sun={sun}
        skylight={skylight}
        shadows={shadows}
      />
      {data.sample ? (
        <Courtyard />
      ) : (
        <>
          {model && modelScope && (
            <MapModelBoundary key={model} url={model} scope={modelScope} report={reportModel}>
              <Suspense fallback={null}>
                <Model
                  url={model}
                  scope={modelScope}
                  loaded={reportModel}
                  fogResources={fogResources}
                  registerFollowModel={registerFollowModel}
                />
              </Suspense>
            </MapModelBoundary>
          )}
        </>
      )}
      <group visible={Boolean(data.sample) || modelReady}>
        {frame.players
          .filter(
            (p) =>
              p.alive &&
              !(mode === 'pov' && p.id === viewedPlayer?.id) &&
              !bodies.some((body) => body.position.id === p.id),
          )
          .map((p) => (
            <Agent
              key={p.id}
              position={p}
              next={nextPlayers.get(p.id)}
              alpha={alpha}
              selected={p.id === selected && !preview}
              xray={settings.xray && !preview}
              name={data.players.find((player) => player.id === p.id)?.name}
              labels={settings.playerLabels && !preview && (Boolean(data.sample) || modelReady)}
              labelSmoke={labelSmoke}
              hideNearCamera={
                !preview &&
                !data.sample &&
                (mode === 'orbit' || (mode === 'follow' && p.id === selected))
              }
              showMarkers={!(mode === 'follow' && p.id === selected)}
              model={!preview ? (p.team === 3 ? agents.ct : agents.t) : null}
              tick={tick}
              timing={poseTiming}
              previous={previousPlayers?.get(p.id)}
              gaitHistory={gaitHistory}
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
            key={body.position.id}
            body={body}
            url={body.position.team === 3 ? agents.ct : agents.t}
            tick={tick}
            rate={data.tickRate}
            reducedMotion={reduceAgentMotion}
          />
        ))}
        {showPovEquipment && (
          <PovEquipmentPass
            hasSky={Boolean(sky)}
            sample={Boolean(data.sample)}
            sun={sun}
            skylight={skylight}
            trace={followTrace}
          >
            <PovViewmodel
              native={!data.sample}
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
        {!preview && <RecordedEquipment items={items} />}
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
            staticMap={followModel}
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
    </SceneGrade>
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
  staticMap: THREE.Group | null;
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
  settings = defaultSettings,
  mapAssets,
  assetScope = 'public',
  onMapStatus,
  focus,
  onAudioListener,
}: {
  data: Playback;
  tick?: number;
  mode?: string;
  selected?: string;
  preview?: boolean;
  mobile?: boolean;
  playing?: boolean;
  settings?: ViewerSettings;
  mapAssets: MapResources;
  assetScope?: string;
  onMapStatus?: (state: MapRenderState) => void;
  focus?: SceneFocus;
  onAudioListener?: (pose: ListenerPose | null) => void;
}) {
  const listenerScope = useMemo(() => ({}), [assetScope, data.map, onAudioListener]);
  const currentListenerScope = useRef(listenerScope);
  currentListenerScope.current = listenerScope;
  const reportAudioListener = useCallback(
    (pose: ListenerPose | null) => {
      if (currentListenerScope.current === listenerScope) onAudioListener?.(pose);
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
  const agentCounts = Object.entries(
    agentStatuses.identity === equipmentIdentity ? agentStatuses.items : {},
  )
    .filter(([id]) => !id.startsWith('death:'))
    .map(([, status]) => status);
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
  const equipmentCounts = Object.values(
    equipmentStatuses.identity === equipmentIdentity ? equipmentStatuses.items : {},
  );
  const [autoLow, setAutoLow] = useState(
    () =>
      window.matchMedia('(max-width:780px),(pointer:coarse)').matches ||
      navigator.hardwareConcurrency <= 4,
  );
  useEffect(() => {
    const media = window.matchMedia('(max-width:780px),(pointer:coarse)');
    const update = () => setAutoLow(media.matches || navigator.hardwareConcurrency <= 4);
    media.addEventListener('change', update);
    update();
    return () => media.removeEventListener('change', update);
  }, []);
  const prefersCompact = settings.quality === 'compact' || (settings.quality === 'auto' && autoLow);
  const wantsLow = settings.quality === 'low' || prefersCompact;
  const detailedModel = wantsLow
    ? mapAssets.assets.mobile || mapAssets.assets.model
    : mapAssets.assets.model || mapAssets.assets.mobile;
  const compactModel = mapAssets.assets.compact;
  const [failedCompact, setFailedCompact] = useState<string>();
  const compact = Boolean(
    compactModel && (!detailedModel || (prefersCompact && failedCompact !== compactModel)),
  );
  const model = compact ? compactModel! : detailedModel;
  const low = wantsLow || compact;
  const [adaptiveQuality, setAdaptiveQuality] = useState({
    resolution: settings.renderResolution,
    shadows: true,
  });
  useEffect(
    () => setAdaptiveQuality({ resolution: settings.renderResolution, shadows: true }),
    [assetScope, data.map, settings.quality, settings.renderResolution],
  );
  const adaptive = settings.quality === 'auto' && !preview;
  const resolution = adaptive
    ? Math.min(adaptiveQuality.resolution, settings.renderResolution)
    : settings.renderResolution;
  const shadows = !low && (!adaptive || adaptiveQuality.shadows);
  const displayDpr = useSyncExternalStore(subscribeToDevicePixelRatio, devicePixelRatio);
  const renderDpr =
    (low ? 1 : Math.min(MAX_DESKTOP_DPR, Math.max(1, displayDpr))) * (resolution / 100);
  const zonesAt = useMemo(
    () => buildUtilityZoneIndex(data.events, data.tickRate, true),
    [data.events, data.tickRate],
  );
  const bombWaveAt = useMemo(
    () => indexBombShockwaves(data.events, data.tickRate),
    [data.events, data.tickRate],
  );
  const reducedMotion = useReducedMotion();
  const compactTracerProfile =
    mobile || compact || (model !== null && model === mapAssets.assets.mobile);
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
    status: 'ready' | 'error';
    sky: THREE.Scene | null;
    landscape: AssetStatus;
    sun: MapSun | null;
  }>();
  const currentModel = useRef(model);
  currentModel.current = model;
  const reportModel = useCallback(
    (
      url: string,
      status: 'ready' | 'error',
      sky: THREE.Scene | null = null,
      landscape: AssetStatus = 'missing',
      sun: MapSun | null = null,
    ) => {
      if (currentModel.current === url) {
        if (status === 'error' && url === compactModel && detailedModel) setFailedCompact(url);
        setModelLoad((previous) =>
          previous?.url === url &&
          previous.status === status &&
          previous.sky === sky &&
          previous.landscape === landscape &&
          previous.sun === sun
            ? previous
            : { url, status, sky, landscape, sun },
        );
      }
    },
    [compactModel, detailedModel],
  );
  const modelStatus: AssetStatus =
    mapAssets.status === 'pending'
      ? 'pending'
      : mapAssets.status === 'error'
        ? 'error'
        : model
          ? modelLoad?.url === model
            ? modelLoad.status
            : 'pending'
          : 'missing';
  const [rendererFailure, setRendererFailure] = useState<string>();
  const rendererAttempt = useMemo(
    () => ({ map: data.map, failed: false }),
    [data.map, mode === '2d'],
  );
  const currentRendererAttempt = useRef(rendererAttempt);
  currentRendererAttempt.current = rendererAttempt;
  const modelScope = useMapModelScope(data.sample ? null : model, rendererAttempt);
  const gradeEnvironment = mapAssets.assets.environment ?? null,
    environment = compact ? null : gradeEnvironment,
    environmentIdentity = mapEnvironmentKey(environment);
  const [environmentLoad, setEnvironmentLoad] = useState<{
    identity: string | null;
    status: AssetStatus;
    skylight: boolean;
  }>();
  const currentEnvironment = useRef(environmentIdentity);
  currentEnvironment.current = environmentIdentity;
  const reportEnvironment = useCallback(
    (identity: string | null, status: AssetStatus, skylight = false) => {
      if (currentEnvironment.current === identity)
        setEnvironmentLoad((previous) =>
          previous?.identity === identity &&
          previous.status === status &&
          previous.skylight === skylight
            ? previous
            : { identity, status, skylight },
        );
    },
    [],
  );
  const environmentStatus: AssetStatus = environment
    ? environmentLoad?.identity === environmentIdentity
      ? environmentLoad.status
      : 'pending'
    : 'missing';
  const landscapeStatus: AssetStatus = modelLoad?.url === model ? modelLoad.landscape : 'missing';
  const skylight = environmentLoad?.identity === environmentIdentity && environmentLoad.skylight;
  const reportRendererFallback = useCallback(() => {
    if (currentRendererAttempt.current !== rendererAttempt) return;
    rendererAttempt.failed = true;
    setRendererFailure(rendererAttempt.map);
  }, [rendererAttempt]);
  const reportRendererCreated = useCallback(() => {
    if (currentRendererAttempt.current !== rendererAttempt || rendererAttempt.failed) return;
    setRendererFailure((previous) => (previous === rendererAttempt.map ? undefined : previous));
  }, [rendererAttempt]);
  const equipmentReady = equipmentCounts.filter((status) => status === 'ready').length;
  const equipmentFailed =
    equipmentAssets.status === 'error'
      ? expectedEquipment.length
      : equipmentCounts.filter((status) => status === 'error').length;
  const equipmentUnavailable =
    equipmentAssets.status === 'pending' || equipmentAssets.status === 'error'
      ? 0
      : unavailableEquipment;
  const [smokeUnavailable, setSmokeUnavailable] = useState(false);
  const surface = mapSurface({
    sample: Boolean(data.sample),
    requested2D: mode === '2d',
    discovery: mapAssets.status,
    model,
    modelStatus,
    rendererFailed: rendererFailure === data.map && rendererAttempt.failed,
  });
  const equipmentActive = surface === '3d';
  const equipmentPending =
    equipmentAssets.status === 'pending'
      ? expectedEquipment.length
      : equipmentActive
        ? Math.max(
            0,
            expectedEquipment.length - equipmentReady - equipmentFailed - equipmentUnavailable,
          )
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
        compact,
        compactTracerProfile,
        modelProgress:
          surface === '3d' && modelStatus === 'pending' ? modelScope?.progress : undefined,
        renderer: surface === 'plot' ? '2d' : '3d',
        failure:
          rendererFailure === data.map
            ? 'webgl'
            : mapAssets.status === 'error'
              ? 'assets'
              : modelStatus === 'error'
                ? 'model'
                : undefined,
        environment: environmentStatus,
        environmentVersion: environment?.assetVersion || null,
        landscape: landscapeStatus,
        resolution: surface === '3d' ? resolution : undefined,
        shadowsPaused: surface === '3d' && adaptive && !low && !shadows,
        smokeUnavailable: smokeFailed,
        equipment: equipmentReport,
      }),
    [
      data.map,
      data.sample,
      modelStatus,
      compact,
      compactTracerProfile,
      modelScope,
      mode,
      rendererFailure,
      environmentStatus,
      landscapeStatus,
      resolution,
      adaptive,
      low,
      shadows,
      environment?.assetVersion,
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
      data-quality={low ? 'low' : 'high'}
      data-map-tier={compact ? 'compact' : model === mapAssets.assets.mobile ? 'mobile' : 'desktop'}
      data-render-resolution={resolution}
      data-live-shadows={shadows}
      data-agent-model-state={agentAssets.status}
      data-agent-ready-count={agentCounts.filter((status) => status === 'ready').length}
      data-agent-fallback-count={Math.max(
        0,
        visibleAgentCount - agentCounts.filter((status) => status === 'ready').length,
      )}
      data-agent-error-count={agentCounts.filter((status) => status === 'error').length}
      data-equipment-model-state={equipmentAssets.status}
      data-equipment-expected-count={expectedEquipment.length}
      data-equipment-unavailable-count={unavailableEquipment}
      data-equipment-ready-count={equipmentCounts.filter((status) => status === 'ready').length}
      data-equipment-error-count={equipmentCounts.filter((status) => status === 'error').length}
      data-equipment-ready-instances={Object.entries(
        equipmentStatuses.identity === equipmentIdentity ? equipmentStatuses.items : {},
      )
        .filter(([, status]) => status === 'ready')
        .map(([id]) => id)
        .sort()
        .join(',')}
      data-recorded-world-item-count={liveItems.length}
      data-recorded-item-rotation-count={
        liveItems.filter((item) => item.pitch !== undefined).length
      }
      data-smoke-state={smokeEnabled ? (smokeFailed ? 'unavailable' : 'ready') : undefined}
      data-camera-mode={mode}
      data-map-model-state={data.sample ? 'ready' : modelStatus}
      data-environment-state={environmentStatus}
      data-skylight-state={skylight ? 'ready' : 'fallback'}
      data-environment-version={environment?.assetVersion}
      data-landscape-state={landscapeStatus}
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
              {adaptive && (
                <MeasureRenderCadence
                  key={`${data.map}:${model}:${mode}`}
                  active={playing && (Boolean(data.sample) || modelStatus === 'ready')}
                  resolution={resolution}
                  ceiling={settings.renderResolution}
                  shadows={shadows}
                  allowShadows={!low}
                  onChange={setAdaptiveQuality}
                />
              )}
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
                      modelScope={modelScope}
                      sun={
                        modelLoad?.url === model && modelLoad.status === 'ready'
                          ? modelLoad.sun
                          : null
                      }
                      skylight={Boolean(skylight)}
                      sky={
                        modelLoad?.url === model && modelLoad.status === 'ready'
                          ? modelLoad.sky
                          : null
                      }
                      environment={environment}
                      gradeEnvironment={gradeEnvironment}
                      reportEnvironment={reportEnvironment}
                      preview={preview}
                      settings={settings}
                      tracers={tracers}
                      agents={agents}
                      focus={focus}
                      utilityState={utilityState}
                      items={liveItems}
                      onAudioListener={reportAudioListener}
                      onSmokeUnavailable={setSmokeUnavailable}
                    />
                  </AgentModels.Provider>
                </EquipmentModels.Provider>
              </EquipmentFire>
            </Canvas>
          </SceneBoundary>
        </>
      )}
    </div>
  );
}
