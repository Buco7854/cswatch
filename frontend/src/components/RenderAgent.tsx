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
  AnimationMixer,
  Bone,
  GreaterDepth,
  MathUtils,
  AlwaysStencilFunc,
  NotEqualStencilFunc,
  ReplaceStencilOp,
  type Object3D,
} from 'three';
import { useEquipmentGLTF, useEquipmentScope } from '../equipment-loader';
import type { ModelScope } from '../model-cache';
import { prepareAgentModel } from '../agent-model';
import {
  createDirectionalAgent,
  agentStrideProfile,
  directionalClips,
  reservedDirectionalClip,
  type DirectionalSample,
} from '../directional-agent';
import type { GaitHistory } from '../../../shared/agent-gait-history.mjs';
import { agentPoseVisibility } from '../agent-culling';
import { agentCenteredMotionAt, agentPhaseAt } from '../agent-phase';
import { agentAnimation } from '../agent-animation';
import { disposeEquipmentInstance } from '../equipment-model';
import { assertMapBaseColorTextures } from '../map-model';
import type { AgentDeathSample } from '../agent-replay';
import { agentXray } from '../agent-xray';

export type AgentInstanceStatus = 'pending' | 'ready' | 'error';
export const AgentModels = createContext<{
  identity: object;
  report: (id: string, status: AgentInstanceStatus | null) => void;
} | null>(null);
export function GenericAgentBody({ team, id, xray }: { team: number; id: string; xray?: boolean }) {
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
      <mesh position={[0, 0.91, 0]} castShadow renderOrder={renderOrder}>
        <capsuleGeometry args={[0.23, 0.65, 4, 8]} />
        <meshStandardMaterial color={team === 3 ? '#43535a' : '#81705c'} {...mask} />
      </mesh>
      <mesh position={[0, 1.6, 0]} castShadow renderOrder={renderOrder}>
        <sphereGeometry args={[0.18, 12, 12]} />
        <meshStandardMaterial color="#b1a28a" {...mask} />
      </mesh>
      {[-0.14, 0.14].map((x) => (
        <mesh key={x} position={[x, 0.32, 0]} castShadow renderOrder={renderOrder}>
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
type AgentProps = {
  url: string;
  id: string;
  tick: number;
  rate: number;
  speed: number;
  travelMeters?: number;
  gaitHistory?: GaitHistory;
  directional?: DirectionalSample;
  duck: number;
  xrayColor?: string;
  registerWeaponAnchor?: (bone: Object3D, directional: boolean) => () => void;
  registerHeadAnchor?: (bone: Bone) => () => void;
};
function LoadedAgent({
  url,
  id,
  gaitHistory,
  tick,
  rate,
  speed,
  duck,
  travelMeters,
  directional,
  scope,
  ready,
  registerWeaponAnchor,
  registerHeadAnchor,
  xrayColor,
}: AgentProps & { scope: ModelScope; ready: () => void }) {
  const gltf = useEquipmentGLTF(url),
    { invalidate } = useThree();
  useLayoutEffect(() => scope.acquire(), [scope]);
  const prepared = useMemo(() => {
    const value = prepareAgentModel(gltf.scene);
    assertMapBaseColorTextures({ scene: value.instance, parser: gltf.parser });
    return value;
  }, [gltf]);
  const mixer = useMemo(() => new AnimationMixer(prepared.instance), [prepared]);
  const xrayEnabled = xrayColor !== undefined;
  const xray = useMemo(
    () => (xrayEnabled ? agentXray(prepared.instance) : undefined),
    [prepared, xrayEnabled],
  );
  useLayoutEffect(() => xray?.acquire(), [xray]);
  const clips = useMemo(
    () => directionalClips(gltf.animations, gltf.parser.json.animations),
    [gltf],
  );
  const directionalPose = useMemo(
    () => clips && createDirectionalAgent(prepared.instance, clips),
    [clips, prepared],
  );
  const strideProfile = useMemo(() => clips && agentStrideProfile(clips), [clips]);
  const phaseAt = useMemo(
    () => gaitHistory && strideProfile && agentPhaseAt(gaitHistory, id, rate, strideProfile),
    [gaitHistory, id, rate, strideProfile],
  );
  const motionAt = useMemo(
    () => strideProfile && gaitHistory && agentCenteredMotionAt(gaitHistory, id, rate),
    [strideProfile, gaitHistory, id, rate],
  );
  const poseVisible = useMemo(agentPoseVisibility, []);
  const animation = useMemo(
    () =>
      agentAnimation(
        mixer,
        gltf.animations.filter((clip) => !reservedDirectionalClip(clip.name)),
        gltf.parser.json.animations,
      ),
    [mixer, gltf],
  );
  useLayoutEffect(() => {
    invalidate();
  }, [
    animation,
    directional,
    phaseAt,
    tick,
    rate,
    speed,
    duck,
    travelMeters,
    invalidate,
    xrayColor,
  ]);
  useEffect(
    () => () => {
      animation.stop();
      mixer.uncacheRoot(prepared.instance);
      disposeEquipmentInstance(prepared.root);
    },
    [mixer, prepared, animation],
  );
  useLayoutEffect(() => {
    if (scope.isCurrent()) {
      ready();
      invalidate();
    }
  }, [scope, ready, invalidate]);
  useLayoutEffect(() => {
    const bone = prepared.instance.getObjectByName('wpn');
    if ((directionalPose || animation.native) && bone instanceof Bone)
      return registerWeaponAnchor?.(bone, Boolean(directionalPose));
  }, [animation, directionalPose, prepared, registerWeaponAnchor]);
  useLayoutEffect(() => {
    if (!registerHeadAnchor) return;
    const bone = prepared.instance.getObjectByName('head_0');
    if (bone instanceof Bone) return registerHeadAnchor(bone);
  }, [prepared, registerHeadAnchor]);
  useFrame(({ camera }) => {
    if (!poseVisible(camera, prepared.root, xrayEnabled)) return;
    if (directionalPose && directional) {
      const motion = directional.death ? undefined : motionAt?.(tick);
      prepared.root.visible = directionalPose.sample(
        tick / rate,
        motion?.speed ?? speed,
        duck,
        phaseAt
          ? phaseAt(tick)
          : travelMeters === undefined
            ? (tick / rate) * 1.4
            : travelMeters / 3.1,
        motion ? { ...directional, ...motion } : directional,
      );
    } else if (!directional?.death) animation.sample(tick / rate, speed, duck, travelMeters);
    xray?.sample(xrayColor);
  }, -2);
  return directional?.death && !directionalPose ? null : (
    <primitive object={prepared.root} dispose={null} />
  );
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
}: {
  body: AgentDeathSample;
  url: string | null;
  tick: number;
  rate: number;
  reducedMotion: boolean;
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
