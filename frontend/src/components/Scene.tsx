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
} from 'react';
import type { ReactNode } from 'react';
import type { ListenerPose } from '../viewer-audio';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import type { Playback, Position } from '../types';
import TacticalPlot from './TacticalPlot';
import {
  buildUtilityZones,
  projectilesAt,
  type ProjectileState,
  type UtilityZone,
} from '../utility-state';
type UtilityPresentation = { projectiles: ProjectileState[]; zones: UtilityZone[] };
export type SceneFocus = {
  id: string;
  target: { x: number; y: number; z: number };
  origin?: { x: number; y: number; z: number };
  fromTick?: number;
  untilTick?: number;
};
import { frameAt, playbackBounds, defaultSettings, type ViewerSettings } from '../playback';
import { Line } from '@react-three/drei';
import { freeCameraAction, typingOrDialog } from '../free-camera';
import { thirdPersonFollow } from '../follow-camera';
import { mapSurface, type MapUnavailableReason } from '../map-availability';
import MapUnavailable from './MapUnavailable';
import { mapAcquisitionMessage, type DemoMapState } from '../demo-map-assets';
import type { AssetStatus } from '../map-assets';
import { assertMapBaseColorTextures, prepareMapModel } from '../map-model';
import { renderSkyBehindMap, skyCameraFor, updateSkyCamera } from '../sky-render';
import { useMapGLTF, useMapModelScope } from '../map-loader';
import type { ModelScope } from '../model-cache';
import { useEquipmentAssets, type EquipmentRenderState } from '../equipment-assets';
import { equipmentIconKey } from '../equipment-icons';
import { projectileEquipment } from '../projectile-equipment';
import { useAgentAssets } from '../agent-assets';
import { useModelLeases } from '../equipment-loader';
import { playerPose, type PoseTiming } from '../player-pose';
import { recordedLocomotion } from '../agent-locomotion';
import RenderAgent, {
  GenericAgentBody,
  AgentModels,
  type AgentInstanceStatus,
} from './RenderAgent';
import { indexItems, itemsAt, hasRecordedProjectiles, type PresentItem } from '../item-state';
import {
  EquipmentModels,
  EquipmentModelInstance,
  HeldEquipment,
  PovEquipment,
  RecordedEquipment,
  ProjectileFallback,
  type EquipmentInstanceStatus,
} from './RenderEquipment';
import { installSourceBlackMaterials, type SourceFogResources } from '../source-black-material';
type SourceFogReference = { current: SourceFogResources };
import type { MapEnvironment } from '../../../shared/map-assets';
import { daylightFallback, mapEnvironmentKey, useMapEnvironment } from '../map-environment';
export type MapRenderState = {
  map: string;
  model: AssetStatus;
  renderer: '3d' | '2d';
  failure?: 'webgl' | 'model' | 'assets';
  environment: AssetStatus;
  environmentVersion: string | null;
  landscape: AssetStatus;
  equipment?: EquipmentRenderState;
};
type MapResources = DemoMapState & {
  reportOverview: (image: string, version: string, status: 'ready' | 'error') => void;
  retryAcquisition?: () => void;
};

const UNIT = 0.0254;
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
}: {
  url: string;
  fogResources: SourceFogReference;
  scope: ModelScope;
  loaded: (
    url: string,
    status: 'ready' | 'error',
    sky?: THREE.Scene | null,
    landscape?: AssetStatus,
  ) => void;
}) {
  // Prepared map URLs are fixed. Operator pack installs require reloading open
  // tabs to clear this positive loader cache, as documented in tools/assets.
  const gltf = useMapGLTF(url);
  useLayoutEffect(() => scope.acquire(), [scope]);
  const prepared = useMemo(() => {
    const result = prepareMapModel(gltf.scene);
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
    return { ...result, landscape, compatibility };
  }, [gltf, fogResources]);
  useEffect(() => () => prepared.compatibility.dispose(), [prepared]);
  useLayoutEffect(() => {
    if (scope.isCurrent()) loaded(url, 'ready', prepared.sky, prepared.landscape);
  }, [url, loaded, prepared, scope]);
  return <primitive object={prepared.main} />;
}
function SkyPass({ sky }: { sky: THREE.Scene }) {
  const camera = useMemo(() => skyCameraFor(sky), [sky]);
  useFrame(({ gl, scene, camera: main }) => {
    const backgroundCamera =
      main instanceof THREE.PerspectiveCamera ? updateSkyCamera(main, camera) : main;
    renderSkyBehindMap(gl, scene, sky, main, backgroundCamera);
  }, 1);
  return null;
}
function EnvironmentBackground({
  environment,
  sample,
  report,
  resources,
}: {
  environment: MapEnvironment | null;
  sample: boolean;
  report: (identity: string | null, status: AssetStatus) => void;
  resources: SourceFogReference;
}) {
  const { scene, invalidate } = useThree();
  const state = useMapEnvironment(sample ? null : environment);
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
    report(state.identity, state.status);
    return () => report(state.identity, 'pending');
  }, [state.identity, state.status, report]);
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
  showMarkers,
  model,
  tick,
  rate,
  frameTick,
  nextTick,
  roundBoundary,
}: {
  position: Position;
  next?: Position;
  alpha: number;
  selected: boolean;
  xray: boolean;
  showMarkers: boolean;
  model: string | null;
  tick: number;
  rate: number;
  frameTick: number;
  nextTick: number;
  roundBoundary: boolean;
}) {
  const pose = playerPose(position, next, alpha, {
    fromTick: frameTick,
    nextTick,
    tickRate: rate,
    roundBoundary,
  });
  const motion = recordedLocomotion(position, next, frameTick, nextTick, rate, alpha);
  const weaponAnchor = useRef<THREE.Object3D | null>(null);
  const registerWeaponAnchor = useCallback((bone: THREE.Object3D) => {
    weaponAnchor.current = bone;
    return () => {
      if (weaponAnchor.current === bone) weaponAnchor.current = null;
    };
  }, []);
  const ref = useRef<THREE.Group>(null);
  useFrame(() => {
    if (!ref.current) return;
    ref.current.position.set(pose.x * UNIT, pose.z * UNIT, -pose.y * UNIT);
    ref.current.rotation.y = THREE.MathUtils.degToRad(pose.yaw);
  }, -3);
  const color = position.team === 3 ? '#9ec7da' : '#e7ba73';
  if (!position.alive) return null;
  return (
    <group ref={ref}>
      {xray && (
        <mesh position={[0, 0.95, 0]} renderOrder={10}>
          <capsuleGeometry args={[0.26, 1.1, 4, 8]} />
          <meshBasicMaterial
            color={color}
            transparent
            opacity={0.27}
            depthTest={false}
            depthWrite={false}
          />
        </mesh>
      )}
      {model ? (
        <RenderAgent
          url={model}
          id={position.id}
          tick={tick}
          rate={rate}
          speed={roundBoundary ? 0 : motion.speed}
          duck={pose.duck ?? 0}
          registerWeaponAnchor={registerWeaponAnchor}
          fallback={<GenericAgentBody team={position.team} id={position.id} />}
        />
      ) : (
        <GenericAgentBody team={position.team} id={position.id} />
      )}
      <HeldEquipment position={pose} anchor={weaponAnchor} />
      {showMarkers && (
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
  tick,
  mode,
  selected,
  model,
  modelReady,
  reportModel,
  modelScope,
  sky,
  environment,
  reportEnvironment,
  preview,
  settings,
  agents,
  focus,
  utilityState,
  items,
  onAudioListener,
}: {
  data: Playback;
  tick: number;
  mode: string;
  selected: string;
  model: string | null;
  modelReady: boolean;
  reportModel: (
    url: string,
    status: 'ready' | 'error',
    sky?: THREE.Scene | null,
    landscape?: AssetStatus,
  ) => void;
  sky: THREE.Scene | null;
  modelScope: ModelScope | null;
  environment: MapEnvironment | null;
  reportEnvironment: (identity: string | null, status: AssetStatus) => void;
  preview: boolean;
  settings: ViewerSettings;
  agents: { ct: string | null; t: string | null };
  focus?: SceneFocus;
  utilityState: UtilityPresentation;
  items: PresentItem[];
  onAudioListener?: (pose: ListenerPose | null) => void;
}) {
  const { camera, gl, invalidate } = useThree();
  const fogResources = useRef<SourceFogResources>({ fog: null, cube: null });
  const movement = useRef(new Set<string>());
  const fastMovement = useRef(false);
  useEffect(() => {
    if (camera instanceof THREE.PerspectiveCamera) {
      camera.fov = settings.cameraFov;
      camera.updateProjectionMatrix();
      invalidate();
    }
  }, [camera, settings.cameraFov, invalidate]);
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
      settings,
      focus,
      utilityState,
      sky,
      items,
    ],
  );
  const orbit = useRef<React.ComponentRef<typeof OrbitControls>>(null);
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
  const { frame, next, alpha } = frameAt(data, tick);
  const viewedPlayer = frame.players.find((player) => player.id === selected);
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
      camera.position.copy(
        freeView.current?.position ||
          bounds.center
            .clone()
            .add(
              new THREE.Vector3(bounds.extent * 0.57, bounds.extent * 0.65, bounds.extent * 0.62),
            ),
      );
      const target = freeView.current?.target || bounds.center;
      camera.lookAt(target);
      orbit.current?.target.copy(target);
      orbit.current?.update();
    }
    invalidate();
    return () => {
      if (mode === 'orbit')
        freeView.current = {
          position: camera.position.clone(),
          target: orbit.current?.target.clone() || bounds.center.clone(),
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
        shift.normalize().multiplyScalar(Math.min(delta, 0.05) * (fastMovement.current ? 24 : 8));
      camera.position.add(shift);
      orbit.current?.target.add(shift);
      orbit.current?.update();
      if (movement.current.size) invalidate();
      return;
    }
    if (mode === 'tactical') {
      camera.position.copy(bounds.center).add(new THREE.Vector3(0, bounds.extent * 1.15, 0.01));
      camera.lookAt(bounds.center);
      return;
    }
    const p = viewedPlayer;
    if (!p) return;
    const n = next.players.find((n) => n.id === p.id),
      pose = playerPose(p, n, alpha, poseTiming);
    const pos = vector(pose);
    if (mode === 'follow') {
      const follow = thirdPersonFollow(p, n, alpha, poseTiming);
      if (follow) {
        camera.position.set(...follow.position);
        camera.lookAt(...follow.target);
      }
    } else {
      const yaw = THREE.MathUtils.degToRad(pose.yaw),
        pitch = THREE.MathUtils.degToRad(pose.pitch);
      camera.position.copy(pos).add(new THREE.Vector3(0, 1.65 - (pose.duck ?? 0) * 0.7, 0));
      camera.lookAt(
        camera.position
          .clone()
          .add(
            new THREE.Vector3(
              Math.cos(yaw) * Math.cos(pitch),
              -Math.sin(pitch),
              -Math.sin(yaw) * Math.cos(pitch),
            ),
          ),
      );
    }
  });
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
  return (
    <>
      <EnvironmentBackground
        environment={environment}
        sample={Boolean(data.sample)}
        report={reportEnvironment}
        resources={fogResources}
      />
      {sky && <SkyPass sky={sky} />}
      <ambientLight intensity={data.sample ? 0.9 : 0.35} />
      <hemisphereLight args={['#e1ecf0', '#7c694b', data.sample ? 2 : 0.6]} />
      <directionalLight
        position={[-25, 40, 12]}
        intensity={data.sample ? 3.5 : 1.8}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-45}
        shadow-camera-right={45}
        shadow-camera-top={45}
        shadow-camera-bottom={-45}
        shadow-normalBias={0.04}
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
                />
              </Suspense>
            </MapModelBoundary>
          )}
        </>
      )}
      <group visible={Boolean(data.sample) || modelReady}>
        {frame.players
          .filter((p) => !(mode === 'pov' && p.id === viewedPlayer?.id))
          .map((p) => (
            <Agent
              key={p.id}
              position={p}
              next={next.players.find((n) => n.id === p.id)}
              alpha={alpha}
              selected={p.id === selected && !preview}
              xray={settings.xray && !preview}
              showMarkers={!(mode === 'follow' && p.id === selected)}
              model={!preview ? (p.team === 3 ? agents.ct : agents.t) : null}
              tick={tick}
              rate={data.tickRate}
              frameTick={frame.tick}
              nextTick={next.tick}
              roundBoundary={Boolean(poseTiming.roundBoundary)}
            />
          ))}
        {!preview && mode === 'pov' && viewedPlayer && (
          <PovEquipment
            position={viewedPlayer}
            next={next.players.find((player) => player.id === viewedPlayer.id)}
            alpha={alpha}
            timing={poseTiming}
          />
        )}
        {!preview && <RecordedEquipment items={items} />}
        {!preview && (
          <UtilityLayer
            data={data}
            tick={tick}
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
      <OrbitControls
        ref={orbit}
        enabled={mode === 'orbit' && !preview}
        enableDamping
        maxPolarAngle={Math.PI / 2 - 0.05}
        minDistance={3}
        maxDistance={bounds.extent * 3}
      />
    </>
  );
}
function UtilityLayer({
  data,
  tick,
  selected,
  settings,
  utilityState,
}: {
  data: Playback;
  tick: number;
  selected: string;
  settings: ViewerSettings;
  utilityState: UtilityPresentation;
}) {
  const { zones: utility, projectiles } = utilityState;
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
      {utility.map((zone) => (
        <mesh
          key={zone.id}
          name={'utility-zone:' + zone.kind}
          position={[
            zone.x * UNIT,
            zone.z * UNIT + (zone.kind === 'smoke' ? 1.7 : zone.kind === 'fire' ? 0.08 : 0.4),
            -zone.y * UNIT,
          ]}
          rotation={zone.kind === 'fire' ? [-Math.PI / 2, 0, 0] : [0, 0, 0]}
        >
          {zone.kind === 'fire' ? (
            <circleGeometry args={[3.2, 24]} />
          ) : (
            <sphereGeometry args={[zone.kind === 'smoke' ? 3.7 : 0.9, 16, 12]} />
          )}
          <meshStandardMaterial
            color={
              zone.kind === 'smoke' ? '#b5b8ad' : zone.kind === 'flash' ? '#f5f0d8' : '#e4a661'
            }
            transparent
            opacity={zone.kind === 'smoke' ? 0.45 : 0.6}
            depthWrite={false}
          />
        </mesh>
      ))}
      {projectiles.map((grenade) => (
        <group key={grenade.id} name={'recorded-projectile:' + grenade.id}>
          {settings.trajectories && grenade.trail.length > 1 && (
            <Line
              points={grenade.trail.map(
                (point) => new THREE.Vector3(point.x * UNIT, point.z * UNIT, -point.y * UNIT),
              )}
              color="#e4b575"
              lineWidth={1.5}
            />
          )}
          {!hasRecordedProjectiles(data) && (
            <group
              position={[grenade.point.x * UNIT, grenade.point.z * UNIT, -grenade.point.y * UNIT]}
            >
              <EquipmentModelInstance
                equipment={projectileEquipment(grenade.kind) || ''}
                instance={'legacy-projectile:' + grenade.id}
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
export default function Scene({
  data,
  tick = 400,
  mode = 'orbit',
  selected = '0',
  preview = false,
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
  const agentCounts = Object.values(
    agentStatuses.identity === equipmentIdentity ? agentStatuses.items : {},
  );
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
  const low = settings.quality === 'low' || (settings.quality === 'auto' && autoLow);
  const zones = useMemo(
    () => buildUtilityZones(data.events, data.tickRate),
    [data.events, data.tickRate],
  );
  const utilityState = useMemo(
    () => ({
      projectiles: preview ? [] : projectilesAt(data.grenades || [], tick, data.tickRate),
      zones:
        preview || !settings.utilities
          ? []
          : zones.filter((zone) => tick >= zone.start && tick < zone.end),
    }),
    [data.grenades, data.tickRate, tick, zones, preview, settings.utilities],
  );
  const expectedEquipment =
    !preview && !data.sample
      ? [
          ...frameAt(data, tick)
            .frame.players.filter((player) => player.alive && player.weapon)
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
  const model = low
    ? mapAssets.assets.mobile || mapAssets.assets.model
    : mapAssets.assets.model || mapAssets.assets.mobile;
  const [modelLoad, setModelLoad] = useState<{
    url: string;
    status: 'ready' | 'error';
    sky: THREE.Scene | null;
    landscape: AssetStatus;
  }>();
  const currentModel = useRef(model);
  currentModel.current = model;
  const reportModel = useCallback(
    (
      url: string,
      status: 'ready' | 'error',
      sky: THREE.Scene | null = null,
      landscape: AssetStatus = 'missing',
    ) => {
      if (currentModel.current === url)
        setModelLoad((previous) =>
          previous?.url === url &&
          previous.status === status &&
          previous.sky === sky &&
          previous.landscape === landscape
            ? previous
            : { url, status, sky, landscape },
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
  const environment = mapAssets.assets.environment || null,
    environmentIdentity = mapEnvironmentKey(environment);
  const [environmentLoad, setEnvironmentLoad] = useState<{
    identity: string | null;
    status: AssetStatus;
  }>();
  const currentEnvironment = useRef(environmentIdentity);
  currentEnvironment.current = environmentIdentity;
  const reportEnvironment = useCallback((identity: string | null, status: AssetStatus) => {
    if (currentEnvironment.current === identity)
      setEnvironmentLoad((previous) =>
        previous?.identity === identity && previous.status === status
          ? previous
          : { identity, status },
      );
  }, []);
  const environmentStatus: AssetStatus = environment
    ? environmentLoad?.identity === environmentIdentity
      ? environmentLoad.status
      : 'pending'
    : 'missing';
  const landscapeStatus: AssetStatus = modelLoad?.url === model ? modelLoad.landscape : 'missing';
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
        equipment: equipmentReport,
      }),
    [
      data.map,
      data.sample,
      modelStatus,
      mode,
      rendererFailure,
      environmentStatus,
      landscapeStatus,
      environment?.assetVersion,
      onMapStatus,
      surface,
      mapAssets.status,
      equipmentReport,
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
      data-camera-mode={mode}
      data-map-model-state={data.sample ? 'ready' : modelStatus}
      data-environment-state={environmentStatus}
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
              shadows={!low}
              dpr={low ? 1 : [1, 1.75]}
              camera={{ position: [32, 36, 34], fov: settings.cameraFov, near: 0.05, far: 3000 }}
              gl={{ antialias: true, powerPreference: 'high-performance' }}
              fallback={<span>{t('3D rendering is unavailable.')}</span>}
            >
              <EquipmentModels.Provider value={equipmentContext}>
                <AgentModels.Provider value={agentContext}>
                  <World
                    data={data}
                    tick={tick}
                    mode={mode}
                    selected={selected}
                    model={model}
                    modelReady={modelStatus === 'ready'}
                    reportModel={reportModel}
                    modelScope={modelScope}
                    sky={
                      modelLoad?.url === model && modelLoad.status === 'ready'
                        ? modelLoad.sky
                        : null
                    }
                    environment={environment}
                    reportEnvironment={reportEnvironment}
                    preview={preview}
                    settings={settings}
                    agents={agents}
                    focus={focus}
                    utilityState={utilityState}
                    items={liveItems}
                    onAudioListener={reportAudioListener}
                  />
                </AgentModels.Provider>
              </EquipmentModels.Provider>
            </Canvas>
          </SceneBoundary>
          {!data.sample && modelStatus === 'pending' && (
            <div className="map-loading-overlay">
              <span>{t('Loading 3D map…')}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
