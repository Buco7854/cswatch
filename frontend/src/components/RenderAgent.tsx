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
  AlwaysStencilFunc,
  NotEqualStencilFunc,
  ReplaceStencilOp,
  type Object3D,
} from 'three';
import { useEquipmentGLTF, useEquipmentScope } from '../equipment-loader';
import type { ModelScope } from '../model-cache';
import { prepareAgentModel } from '../agent-model';
import { agentAnimation } from '../agent-animation';
import { disposeEquipmentInstance } from '../equipment-model';
import { assertMapBaseColorTextures } from '../map-model';
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
            opacity={0.27}
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
  duck: number;
  xrayColor?: string;
  registerWeaponAnchor?: (bone: Object3D) => () => void;
};
function LoadedAgent({
  url,
  tick,
  rate,
  speed,
  duck,
  scope,
  ready,
  registerWeaponAnchor,
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
  const xray = useMemo(() => agentXray(prepared.instance), [prepared]);
  useLayoutEffect(() => xray.acquire(), [xray]);
  const animation = useMemo(
    () => agentAnimation(mixer, gltf.animations, gltf.parser.json.animations),
    [mixer, gltf],
  );
  useLayoutEffect(() => {
    animation.sample(tick / rate, speed, duck);
    xray.sample(xrayColor);
    invalidate();
  }, [animation, tick, rate, speed, duck, invalidate, xray, xrayColor]);
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
    if (animation.native && bone instanceof Bone) return registerWeaponAnchor?.(bone);
  }, [animation, prepared, registerWeaponAnchor]);
  useFrame(() => {
    animation.sample(tick / rate, speed, duck);
    xray.sample(xrayColor);
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
