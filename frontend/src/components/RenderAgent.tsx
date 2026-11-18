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
import { AnimationMixer } from 'three';
import { useEquipmentGLTF, useEquipmentScope } from '../equipment-loader';
import type { ModelScope } from '../model-cache';
import { prepareAgentModel, genericAgentClip } from '../agent-model';
import { disposeEquipmentInstance } from '../equipment-model';
import { assertMapBaseColorTextures } from '../map-model';

export type AgentInstanceStatus = 'pending' | 'ready' | 'error';
export const AgentModels = createContext<{
  identity: object;
  report: (id: string, status: AgentInstanceStatus | null) => void;
} | null>(null);
export function GenericAgentBody({ team, id }: { team: number; id: string }) {
  return (
    <group name={'generic-agent:' + id}>
      <mesh position={[0, 0.91, 0]} castShadow>
        <capsuleGeometry args={[0.23, 0.65, 4, 8]} />
        <meshStandardMaterial color={team === 3 ? '#43535a' : '#81705c'} />
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
  moving: boolean;
  crouched: boolean;
};
function LoadedAgent({
  url,
  tick,
  rate,
  moving,
  crouched,
  scope,
  ready,
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
  const animation = useMemo(
    () => genericAgentClip(gltf.animations, moving, crouched),
    [gltf.animations, moving, crouched],
  );
  useLayoutEffect(() => {
    mixer.stopAllAction();
    if (animation) mixer.clipAction(animation).play();
    invalidate();
    return () => {
      mixer.stopAllAction();
    };
  }, [mixer, animation, invalidate]);
  useEffect(
    () => () => {
      mixer.uncacheRoot(prepared.instance);
      disposeEquipmentInstance(prepared.root);
    },
    [mixer, prepared],
  );
  useLayoutEffect(() => {
    if (scope.isCurrent()) {
      ready();
      invalidate();
    }
  }, [scope, ready, invalidate]);
  useFrame(() => mixer.setTime(tick / rate));
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
