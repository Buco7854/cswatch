import { ReplayFrameContext } from '../replay-frames';
import {
  Component,
  Suspense,
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  type ReactNode,
} from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import {
  Bone,
  GreaterDepth,
  MathUtils,
  AlwaysStencilFunc,
  NotEqualStencilFunc,
  ReplaceStencilOp,
} from 'three';
import { useEquipmentGLTF, useEquipmentScope } from '../equipment-loader';
import type { ModelScope } from '../model-cache';
import { prepareAgentModel } from '../agent-model';
import {
  createDirectionalAgent,
  agentStrideProfile,
  agentModelClips,
  type DirectionalSample,
} from '../directional-agent';
import type { GaitHistory } from '../../../shared/agent-gait-history.mjs';
import { agentPoseVisibility } from '../agent-culling';
import { agentCenteredMotionAt, agentPhaseAt } from '../agent-phase';
import { disposeEquipmentInstance } from '../equipment-model';
import { assertBaseColorTextures } from '../model-textures';
import type { AgentDeathSample } from '../agent-replay';
import { weaponAnchor, type WeaponAnchor } from '../agent-attachment';
import { agentXray } from '../agent-xray';
import { createAgentFootLock, type FootPoseAt } from '../agent-feet';
import { createCorpseFloor } from '../agent-corpse-floor';
import type { SceneTrace } from '../world/queries';

/** A stable reference: inline userData redraws a paused scene on every React update. */
const playerShadowCaster = { playerShadowCaster: true };

export type AgentInstanceStatus = 'pending' | 'ready' | 'error';
export const AgentModels = createContext<{
  identity: object;
  report: (id: string, status: AgentInstanceStatus | null) => void;
} | null>(null);
export function GenericAgentBody({
  team,
  id,
  xray,
  castStatic = false,
}: {
  team: number;
  id: string;
  xray?: boolean;
  castStatic?: boolean;
}) {
  const mask = {
    stencilWrite: Boolean(xray),
    stencilRef: 1,
    stencilFunc: AlwaysStencilFunc,
    stencilZPass: ReplaceStencilOp,
  };
  const renderOrder = xray ? 5 : 0;
  return (
    <group name={'generic-agent:' + id}>
      {xray && (
        <mesh position={[0, 0.95, 0]} renderOrder={10}>
          <capsuleGeometry args={[0.26, 1.1, 4, 8]} />
          <meshBasicMaterial
            color={team === 3 ? '#9ec7da' : '#e7ba73'}
            transparent
            opacity={0.42}
            depthTest
            depthFunc={GreaterDepth}
            depthWrite={false}
            stencilWrite
            stencilRef={1}
            stencilFunc={NotEqualStencilFunc}
            stencilWriteMask={0}
          />
        </mesh>
      )}
      <mesh
        position={[0, 0.91, 0]}
        castShadow={castStatic}
        userData={playerShadowCaster}
        renderOrder={renderOrder}
      >
        <capsuleGeometry args={[0.23, 0.65, 4, 8]} />
        <meshStandardMaterial color={team === 3 ? '#43535a' : '#81705c'} {...mask} />
      </mesh>
      <mesh
        position={[0, 1.6, 0]}
        castShadow={castStatic}
        userData={playerShadowCaster}
        renderOrder={renderOrder}
      >
        <sphereGeometry args={[0.18, 12, 12]} />
        <meshStandardMaterial color="#b1a28a" {...mask} />
      </mesh>
      {[-0.14, 0.14].map((x) => (
        <mesh
          key={x}
          position={[x, 0.32, 0]}
          castShadow={castStatic}
          userData={playerShadowCaster}
          renderOrder={renderOrder}
        >
          <capsuleGeometry args={[0.095, 0.45, 4, 8]} />
          <meshStandardMaterial color="#434645" {...mask} />
        </mesh>
      ))}
    </group>
  );
}
class AgentBoundary extends Component<
  { scope: ModelScope; failed: () => void; fallback: ReactNode; children: ReactNode },
  { error: boolean }
> {
  state = { error: false };
  static getDerivedStateFromError() {
    return { error: true };
  }
  componentDidCatch() {
    this.props.failed();
    this.props.scope.invalidate();
  }
  render() {
    return this.state.error ? this.props.fallback : this.props.children;
  }
}
function clipsForModel(gltf: ReturnType<typeof useEquipmentGLTF>) {
  const clips = agentModelClips(gltf);
  if (!clips) throw Error('Agent model requires the complete directional animation set.');
  return clips;
}

type AgentProps = {
  url: string;
  id: string;
  tick: number;
  rate: number;
  speed: number;
  gaitHistory?: GaitHistory;
  travelMeters?: number;
  directional: DirectionalSample;
  duck: number;
  xrayColor?: string;
  shadowPose?: boolean;
  registerWeaponAnchor?: (anchor: WeaponAnchor) => () => void;
  registerHeadAnchor?: (bone: Bone) => () => void;
  footPoseAt?: FootPoseAt;
  floor?: ReturnType<SceneTrace['fork']>;
  airborne?: number;
};
function LoadedAgent({
  url,
  id,
  gaitHistory,
  travelMeters,
  tick,
  rate,
  speed,
  duck,
  directional,
  scope,
  ready,
  registerWeaponAnchor,
  registerHeadAnchor,
  xrayColor,
  shadowPose,
  footPoseAt,
  floor,
  airborne,
}: AgentProps & { scope: ModelScope; ready: () => void }) {
  const gltf = useEquipmentGLTF(url),
    { invalidate } = useThree();
  useLayoutEffect(() => scope.acquire(), [scope]);
  const { prepared, pose, strideProfile, footLock, corpseFloor } = useMemo(() => {
    const clips = clipsForModel(gltf);
    const prepared = prepareAgentModel(gltf.scene);
    try {
      assertBaseColorTextures({ scene: gltf.scene, parser: gltf.parser });
      const pose = createDirectionalAgent(prepared.instance, clips);
      if (!pose) throw Error('Agent model has unsupported directional tracks.');
      return {
        prepared,
        pose,
        strideProfile: agentStrideProfile(clips),
        footLock: createAgentFootLock(prepared.instance),
        corpseFloor: createCorpseFloor(prepared.root),
      };
    } catch (error) {
      disposeEquipmentInstance(prepared.root);
      prepared.disposeMaterials();
      throw error;
    }
  }, [gltf]);
  const xrayEnabled = xrayColor !== undefined;
  const xray = useMemo(
    () => (xrayEnabled ? agentXray(prepared.instance) : undefined),
    [prepared, xrayEnabled],
  );
  useLayoutEffect(() => xray?.acquire(), [xray]);
  const phaseAt = useMemo(
    () => gaitHistory && agentPhaseAt(gaitHistory, id, rate, strideProfile),
    [gaitHistory, id, rate, strideProfile],
  );
  const motionAt = useMemo(
    () => gaitHistory && agentCenteredMotionAt(gaitHistory, id, rate),
    [gaitHistory, id, rate],
  );
  const poseVisible = useMemo(agentPoseVisibility, []);
  useLayoutEffect(() => {
    invalidate();
  }, [
    pose,
    directional,
    phaseAt,
    motionAt,
    travelMeters,
    tick,
    rate,
    speed,
    duck,
    invalidate,
    xrayColor,
  ]);
  useEffect(
    () => () => {
      disposeEquipmentInstance(prepared.root);
      prepared.disposeMaterials();
    },
    [prepared],
  );
  useLayoutEffect(() => {
    if (scope.isCurrent()) {
      ready();
      invalidate();
    }
  }, [scope, ready, invalidate]);
  useLayoutEffect(() => {
    const anchor = weaponAnchor(prepared.instance);
    if (anchor) return registerWeaponAnchor?.(anchor);
  }, [prepared, registerWeaponAnchor]);
  useLayoutEffect(() => {
    if (!registerHeadAnchor) return;
    const bone = prepared.instance.getObjectByName('head_0');
    if (bone instanceof Bone) return registerHeadAnchor(bone);
  }, [prepared, registerHeadAnchor]);
  const replayTime = useContext(ReplayFrameContext);
  const frameTick = tick;
  useFrame(({ camera }) => {
    const tick = directional.death ? frameTick : (replayTime?.tick ?? frameTick);
    if (!poseVisible(camera, prepared.root, xrayEnabled || Boolean(shadowPose))) return;
    const motion = directional.death ? undefined : motionAt?.(tick);
    const phase =
      phaseAt?.(tick) ??
      (travelMeters === undefined ? undefined : travelMeters / strideProfile.referenceStride);
    const actor = prepared.root.parent;
    const lock =
      footLock && actor && motion && motionAt && phaseAt && footPoseAt && phase !== undefined;
    if (lock)
      footLock.prepare(
        actor,
        tick,
        rate,
        phase,
        motion.speed,
        duck,
        phaseAt,
        (at) => footPoseAt(id, at),
        (at, contactPhase, contact) => {
          const movement = motionAt(at);
          if (movement.speed < 0.38) return false;
          pose.sample(at / rate, movement.speed, motionAt.duckAt(at), contactPhase, {
            ...movement,
            weapon: contact.weapon,
            yaw: MathUtils.radToDeg(contact.yaw),
            pitch: 0,
          });
          return true;
        },
        floor,
        airborne,
      );
    const deathTime = pose.sample(
      tick / rate,
      motion?.speed ?? speed,
      duck,
      phase,
      motion ? { ...directional, ...motion } : directional,
    );
    if (lock) footLock.apply();
    if (deathTime !== undefined) corpseFloor?.(deathTime, floor);
    xray?.sample(xrayColor);
  }, -2);
  return <primitive object={prepared.root} dispose={null} />;
}
function PendingAgent({ id, children }: { id: string; children: ReactNode }) {
  const context = useContext(AgentModels)!;
  useLayoutEffect(() => context.report(id, 'pending'), [context.report, id]);
  return children;
}
export default function RenderAgent(props: AgentProps & { fallback: ReactNode }) {
  const context = useContext(AgentModels)!,
    scope = useEquipmentScope(props.url, context.identity),
    { invalidate } = useThree();
  const callbacks = useMemo(
    () => ({
      ready: () => {
        if (scope.isCurrent()) context.report(props.id, 'ready');
      },
      failed: () => {
        if (scope.isCurrent()) context.report(props.id, 'error');
        invalidate();
      },
    }),
    [context.report, scope, props.id, invalidate],
  );
  useLayoutEffect(() => () => context.report(props.id, null), [context.report, props.id]);
  return (
    <AgentBoundary
      key={props.url}
      scope={scope}
      failed={callbacks.failed}
      fallback={props.fallback}
    >
      <Suspense fallback={<PendingAgent id={props.id}>{props.fallback}</PendingAgent>}>
        <LoadedAgent {...props} scope={scope} ready={callbacks.ready} />
      </Suspense>
    </AgentBoundary>
  );
}

export function RecordedAgentBody({
  body: { position, variant, age },
  url,
  tick,
  rate,
  reducedMotion,
  shadowPose,
  floor,
}: {
  body: AgentDeathSample;
  url: string | null;
  tick: number;
  rate: number;
  reducedMotion: boolean;
  shadowPose: boolean;
  floor?: AgentProps['floor'];
}) {
  if (!url) return null;
  const inchesToMeters = 0.0254;
  return (
    <group
      position={[
        position.x * inchesToMeters,
        position.z * inchesToMeters,
        -position.y * inchesToMeters,
      ]}
      rotation={[0, MathUtils.degToRad(position.yaw), 0]}
    >
      <RenderAgent
        url={url}
        id={'death:' + position.id}
        tick={tick}
        rate={rate}
        speed={0}
        duck={0}
        fallback={null}
        shadowPose={shadowPose}
        floor={floor}
        directional={{
          yaw: position.yaw,
          pitch: 0,
          weapon: '',
          velocityX: 0,
          velocityY: 0,
          death: { age: reducedMotion ? Infinity : age, variant },
        }}
      />
    </group>
  );
}
