import { t } from '../i18n';
import { Component, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import type { Playback, Position } from '../types';
import { api } from '../api';
import TacticalPlot from './TacticalPlot';
import { frameAt, playbackBounds, defaultSettings, type ViewerSettings } from '../playback';
import { Line } from '@react-three/drei';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';

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
function Model({ url }: { url: string }) {
  const { scene } = useGLTF(url);
  const copy = useMemo(() => scene.clone(), [scene]);
  useEffect(() => {
    copy.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
  }, [copy]);
  return <primitive object={copy} rotation={[0, Math.PI / 2, 0]} />;
}
function Agent({
  position,
  next,
  alpha,
  selected,
  xray,
  model,
  tick,
  rate,
}: {
  position: Position;
  next?: Position;
  alpha: number;
  selected: boolean;
  xray: boolean;
  model: string | null;
  tick: number;
  rate: number;
}) {
  const ref = useRef<THREE.Group>(null);
  useFrame(() => {
    if (!ref.current) return;
    const from = vector(position);
    const to = next && next.alive === position.alive ? vector(next) : from;
    ref.current.position.copy(from.lerp(to, alpha));
    const yaw =
      position.yaw + ((((next?.yaw ?? position.yaw) - position.yaw + 540) % 360) - 180) * alpha;
    ref.current.rotation.y = THREE.MathUtils.degToRad(yaw);
  });
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
        <Suspense fallback={null}>
          <AnimatedAgent
            url={model}
            tick={tick}
            rate={rate}
            moving={!!next && Math.hypot(next.x - position.x, next.y - position.y) > 1}
            crouched={(position.duck ?? 0) > 0.5}
          />
        </Suspense>
      ) : (
        <group>
          <mesh position={[0, 0.91, 0]} castShadow>
            <capsuleGeometry args={[0.23, 0.65, 4, 8]} />
            <meshStandardMaterial color={position.team === 3 ? '#43535a' : '#81705c'} />
          </mesh>
          <mesh position={[0, 1.6, 0]} castShadow>
            <sphereGeometry args={[0.18, 12, 12]} />
            <meshStandardMaterial color="#b1a28a" />
          </mesh>
          {[-0.14, 0.14].map((x) => (
            <mesh key={x} position={[x, 0.32, 0]} castShadow>
              <capsuleGeometry args={[0.095, 0.45, 4, 8]} />
              <meshStandardMaterial color="#434645" />
            </mesh>
          ))}
          <mesh position={[0.3, 1.15, 0]} rotation={[0, 0, Math.PI / 2]}>
            <boxGeometry args={[0.1, 0.9, 0.1]} />
            <meshStandardMaterial color="#272b2a" />
          </mesh>
        </group>
      )}
      <mesh position={[0, 2, 0]}>
        <sphereGeometry args={[selected ? 0.15 : 0.09, 8, 8]} />
        <meshBasicMaterial color={selected ? '#ffffff' : color} />
      </mesh>
      {selected && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.04, 0]}>
          <ringGeometry args={[0.5, 0.58, 32]} />
          <meshBasicMaterial color="#ffffff" />
        </mesh>
      )}
    </group>
  );
}
function AnimatedAgent({
  url,
  tick,
  rate,
  moving,
  crouched,
}: {
  url: string;
  tick: number;
  rate: number;
  moving: boolean;
  crouched: boolean;
}) {
  const gltf = useGLTF(url);
  const instance = useMemo(() => clone(gltf.scene), [gltf.scene]);
  const mixer = useMemo(() => new THREE.AnimationMixer(instance), [instance]);
  const animation = useMemo(() => {
    const clips = gltf.animations;
    return (
      clips.find((a) =>
        (crouched ? /crouch/i : moving ? /run|walk|move/i : /idle/i).test(a.name),
      ) ?? clips[0]
    );
  }, [gltf.animations, moving, crouched]);
  useEffect(() => {
    mixer.stopAllAction();
    if (animation) mixer.clipAction(animation).play();
    return () => {
      mixer.stopAllAction();
    };
  }, [mixer, animation]);
  useEffect(
    () => () => {
      mixer.uncacheRoot(instance);
    },
    [mixer, instance],
  );
  useFrame(() => {
    mixer.setTime(tick / rate);
  });
  return <primitive object={instance} rotation={[0, Math.PI / 2, 0]} />;
}
function World({
  data,
  tick,
  mode,
  selected,
  model,
  preview,
  settings,
  agents,
}: {
  data: Playback;
  tick: number;
  mode: string;
  selected: string;
  model: string | null;
  preview: boolean;
  settings: ViewerSettings;
  agents: { ct: string | null; t: string | null };
}) {
  const { camera } = useThree();
  const orbit = useRef<React.ComponentRef<typeof OrbitControls>>(null);
  const { frame, next, alpha } = frameAt(data, tick);
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
    if (mode === 'orbit') {
      camera.position
        .copy(bounds.center)
        .add(new THREE.Vector3(bounds.extent * 0.57, bounds.extent * 0.65, bounds.extent * 0.62));
      camera.lookAt(bounds.center);
      orbit.current?.target.copy(bounds.center);
      orbit.current?.update();
    }
  }, [mode, bounds, camera]);
  useFrame(() => {
    if (mode === 'orbit') return;
    const p = frame.players.find((p) => p.id === selected) ?? frame.players[0];
    if (!p) return;
    const n = next.players.find((n) => n.id === p.id);
    const pos = vector(p).lerp(n ? vector(n) : vector(p), alpha);
    if (mode === 'tactical') {
      camera.position.copy(bounds.center).add(new THREE.Vector3(0, bounds.extent * 1.15, 0.01));
      camera.lookAt(bounds.center);
    } else {
      const yaw = THREE.MathUtils.degToRad(p.yaw),
        pitch = THREE.MathUtils.degToRad(p.pitch);
      camera.position.copy(pos).add(new THREE.Vector3(0, 1.65 - (p.duck ?? 0) * 0.7, 0));
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
  return (
    <>
      <color attach="background" args={[data.sample ? '#aeb6b0' : '#171a19']} />
      <ambientLight intensity={data.sample ? 0.9 : 1.5} />
      <hemisphereLight args={['#e1ecf0', '#7c694b', 2]} />
      <directionalLight
        position={[-25, 40, 12]}
        intensity={3.5}
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
      ) : model ? (
        <Suspense fallback={null}>
          <Model url={model} />
        </Suspense>
      ) : (
        <group>
          <mesh
            rotation={[-Math.PI / 2, 0, 0]}
            position={[bounds.center.x, bounds.center.y - 0.5, bounds.center.z]}
            receiveShadow
          >
            <planeGeometry args={[bounds.extent * 1.5, bounds.extent * 1.5]} />
            <meshStandardMaterial color="#333b37" />
          </mesh>
          <gridHelper
            args={[bounds.extent * 1.5, 30, '#626e63', '#424d44']}
            position={[bounds.center.x, bounds.center.y - 0.48, bounds.center.z]}
          />
        </group>
      )}
      {frame.players
        .filter((p) => !(mode === 'pov' && p.id === selected))
        .map((p) => (
          <Agent
            key={p.id}
            position={p}
            next={next.players.find((n) => n.id === p.id)}
            alpha={alpha}
            selected={p.id === selected && !preview}
            xray={settings.xray && !preview}
            model={!preview ? (p.team === 3 ? agents.ct : agents.t) : null}
            tick={tick}
            rate={data.tickRate}
          />
        ))}
      {!preview && <UtilityLayer data={data} tick={tick} selected={selected} settings={settings} />}
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
}: {
  data: Playback;
  tick: number;
  selected: string;
  settings: ViewerSettings;
}) {
  const paths = useMemo(() => data.grenades ?? [], [data]);
  const utility = data.events.filter(
    (e) =>
      settings.utilities &&
      typeof e.x === 'number' &&
      typeof e.y === 'number' &&
      typeof e.z === 'number' &&
      tick >= e.tick &&
      tick <
        e.tick +
          data.tickRate *
            (e.type === 'smokegrenade_detonate' ? 18 : e.type === 'inferno_startburn' ? 7 : 0) &&
      ['smokegrenade_detonate', 'inferno_startburn'].includes(e.type),
  );
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
      {utility.map((e, i) => (
        <mesh
          key={e.type + String(e.tick) + i}
          position={[
            Number(e.x) * UNIT,
            Number(e.z) * UNIT + (e.type === 'smokegrenade_detonate' ? 1.7 : 0.08),
            -Number(e.y) * UNIT,
          ]}
          rotation={e.type === 'inferno_startburn' ? [-Math.PI / 2, 0, 0] : [0, 0, 0]}
        >
          {e.type === 'smokegrenade_detonate' ? (
            <sphereGeometry args={[3.7, 16, 12]} />
          ) : (
            <circleGeometry args={[3.2, 24]} />
          )}
          <meshStandardMaterial
            color={e.type === 'smokegrenade_detonate' ? '#b5b8ad' : '#e4a661'}
            transparent
            opacity={e.type === 'smokegrenade_detonate' ? 0.45 : 0.6}
            depthWrite={false}
          />
        </mesh>
      ))}
      {settings.trajectories &&
        paths.map((g) => {
          if (!g.points.length || tick < g.points[0].tick || tick > g.points.at(-1)!.tick)
            return null;
          const points = g.points.filter(
            (p) => p.tick <= tick && p.tick > tick - data.tickRate * 2,
          );
          if (points.length < 2) return null;
          const last = points.at(-1)!;
          return (
            <group key={g.id}>
              <Line
                points={points.map((p) => new THREE.Vector3(p.x * UNIT, p.z * UNIT, -p.y * UNIT))}
                color="#e4b575"
                lineWidth={1.5}
              />
              <mesh position={[last.x * UNIT, last.z * UNIT, -last.y * UNIT]}>
                <sphereGeometry args={[0.13, 8, 8]} />
                <meshBasicMaterial color="#e4b575" />
              </mesh>
            </group>
          );
        })}
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
export default function Scene({
  data,
  tick = 400,
  mode = 'orbit',
  selected = '0',
  preview = false,
  settings = defaultSettings,
}: {
  data: Playback;
  tick?: number;
  mode?: string;
  selected?: string;
  preview?: boolean;
  settings?: ViewerSettings;
}) {
  const low =
    settings.quality === 'low' ||
    (settings.quality === 'auto' &&
      (window.matchMedia('(max-width:780px)').matches || navigator.hardwareConcurrency <= 4));
  const [model, setModel] = useState<string | null>(null);
  const [agents, setAgents] = useState<{ ct: string | null; t: string | null }>({
    ct: null,
    t: null,
  });
  useEffect(() => {
    const controller = new AbortController();
    setAgents({ ct: null, t: null });
    if (!data.sample)
      api<{ ct: string | null; t: string | null }>('/api/assets/agents')
        .then((agents) => {
          if (!controller.signal.aborted) setAgents(agents);
        })
        .catch(() => {});
    return () => controller.abort();
  }, [data.sample]);
  useEffect(() => {
    const controller = new AbortController();
    setModel(null);
    if (!data.sample)
      api<{ model: string | null; mobile?: string | null }>(
        '/api/maps/' + encodeURIComponent(data.map),
        { signal: controller.signal },
      )
        .then((r) => {
          if (!controller.signal.aborted) setModel(low ? r.mobile || r.model : r.model);
        })
        .catch(() => {});
    return () => controller.abort();
  }, [data.map, data.sample, low]);
  if (mode === '2d') return <TacticalPlot data={data} tick={tick} selected={selected} />;
  return (
    <div
      className="scene"
      role="img"
      aria-label={
        data.sample
          ? t('An original 3D training courtyard with ten players')
          : `3D player positions on ${data.map}`
      }
    >
      <SceneBoundary
        key={data.map}
        fallback={<TacticalPlot data={data} tick={tick} selected={selected} />}
      >
        <Canvas
          shadows={!low}
          dpr={low ? 1 : [1, 1.75]}
          camera={{ position: [32, 36, 34], fov: 48, near: 0.05, far: 3000 }}
          gl={{ antialias: true, powerPreference: 'high-performance' }}
          fallback={<TacticalPlot data={data} tick={tick} selected={selected} />}
        >
          <World
            data={data}
            tick={tick}
            mode={mode}
            selected={selected}
            model={model}
            preview={preview}
            settings={settings}
            agents={agents}
          />
        </Canvas>
      </SceneBoundary>
      {!data.sample && !model && (
        <div className="map-notice">{t('Position view · map model not installed')}</div>
      )}
    </div>
  );
}
