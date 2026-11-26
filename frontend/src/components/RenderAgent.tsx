import { ReplayFrameContext } from '../replay-frames';
import { captureAgent } from '../capture-hook';
import { registerAgentRoot } from '../agent-roots';
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
  MathUtils,
  Matrix4,
  AlwaysStencilFunc,
  ReplaceStencilOp,
  Vector3,
  Vector4,
  type Material,
  type Mesh,
} from 'three';
import { ActorSun, actorSunHeights, claimActorSunUpdate, sampleActorSun } from '../actor-sunlight';
import { actorSunUniforms } from '../world/actor-lighting';
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
import { agentXray, xrayHiddenMaterial, xrayOutlineMaterial } from '../agent-xray';
import { agentActionBank, bindAgentActions, type ActionBank } from '../agent-actions';
import {
  agentRagdoll,
  applyRagdollPose,
  createRagdollSimulation,
  type RagdollData,
  type RagdollSimulation,
  type RagdollWorld,
} from '../agent-ragdoll';
import type { RagdollRequest } from '../agent-evidence';
import { createAgentFootLock, type FootPoseAt } from '../agent-feet';
import { createCorpseFloor } from '../agent-corpse-floor';
import type { SceneTrace } from '../world/queries';

/** A stable reference: inline userData redraws a paused scene on every React update. */
const playerShadowCaster = { playerShadowCaster: true };

export type AgentInstanceStatus = 'pending' | 'ready' | 'error';
export const AgentModels = createContext<{
  identity: object;
  report: (id: string, status: AgentInstanceStatus | null) => void;
  /** The shared native action bank; agents keep their class poses without it. */
  actions?: string | null;
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
  const xrayShells = useMemo(
    () =>
      xray
        ? [
            xrayHiddenMaterial({}),
            xrayOutlineMaterial({ color: team === 3 ? '#9ec7da' : '#e7ba73' }),
          ]
        : undefined,
    [xray, team],
  );
  useEffect(() => () => xrayShells?.forEach((material) => material.dispose()), [xrayShells]);
  return (
    <group name={'generic-agent:' + id}>
      {xrayShells?.map((material, index) => (
        <mesh key={index} position={[0, 0.95, 0]} renderOrder={10 + index} material={material}>
          <capsuleGeometry args={[0.26, 1.1, 4, 8]} />
        </mesh>
      ))}
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
  /** The team model whose directional clips animate a recorded agent's skin. */
  clips?: string;
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
  /** A recorded death simulated as the model's own ragdoll against the world. */
  ragdoll?: { request: RagdollRequest; world: RagdollWorld; cache: Map<string, RagdollSimulation> };
  /** Recorded airborne, ladder and hit evidence at a fractional replay tick. */
  evidence?: (
    tick: number,
  ) => Pick<DirectionalSample, 'air' | 'ladder' | 'flinch' | 'twist' | 'turn'>;
};
function LoadedAgent({
  url,
  clips: clipsUrl,
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
  evidence,
  bank,
  ragdollData,
  ragdoll,
}: AgentProps & {
  scope: ModelScope;
  ready: () => void;
  bank?: ActionBank;
  ragdollData?: RagdollData;
}) {
  const gltf = useEquipmentGLTF(url),
    clipSource = useEquipmentGLTF(clipsUrl ?? url),
    { invalidate } = useThree();
  useLayoutEffect(() => scope.acquire(), [scope]);
  const { prepared, pose, strideProfile, footLock, corpseFloor } = useMemo(() => {
    const clips = clipsForModel(clipSource);
    const prepared = prepareAgentModel(gltf.scene);
    try {
      assertBaseColorTextures({ scene: gltf.scene, parser: gltf.parser });
      const pose = createDirectionalAgent(
        prepared.instance,
        clips,
        bank ? bindAgentActions(prepared.instance, bank) : undefined,
      );
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
  }, [gltf, clipSource, bank]);
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
  useLayoutEffect(() => captureAgent(id, prepared.root), [id, prepared]);
  useLayoutEffect(() => registerAgentRoot(id, prepared.instance), [id, prepared]);
  // Direct sun traced from the world at this body (actor-sunlight); the probe light otherwise.
  const sunProbe = useContext(ActorSun);
  const sunlight = useMemo(
    () => ({
      feet: new Vector3(),
      sampled: new Vector3(Infinity, Infinity, Infinity),
      samples: new Vector4(),
      slot: [...id].reduce((sum, c) => sum + c.charCodeAt(0), 0) % 3,
      tries: 0,
    }),
    [prepared, id],
  );
  /** The materials drawn now: x-ray and corpse states swap in their own clones. */
  const sunMaterials = (visit: (uniforms: ReturnType<typeof actorSunUniforms>) => void) =>
    prepared.instance.traverse((object) => {
      const material = (object as Mesh).material;
      if (material)
        for (const entry of Array.isArray(material) ? material : [material])
          visit(actorSunUniforms(entry as Material));
    });
  useLayoutEffect(() => {
    sunMaterials((uniforms) => (uniforms.actorSunTraced.value = 0));
    sunlight.sampled.set(Infinity, Infinity, Infinity);
    invalidate();
  }, [sunlight, sunProbe, invalidate]);
  useFrame(({ gl }) => {
    if (!sunProbe) return;
    const feet = prepared.root.getWorldPosition(sunlight.feet);
    if (!feet.equals(sunlight.sampled)) {
      const frame = gl.info.render.frame;
      // Each body re-traces every third of its frames; a pause keeps rendering until exact.
      if (++sunlight.tries % 3 === sunlight.slot && claimActorSunUpdate(frame)) {
        sampleActorSun(sunProbe, feet, sunlight.samples);
        sunlight.sampled.copy(feet);
      }
      invalidate();
    }
    if (!Number.isFinite(sunlight.sampled.x)) return;
    const base = (sunlight.sampled.y + actorSunHeights[0]) / 0.0254,
      span = (actorSunHeights[3] - actorSunHeights[0]) / 0.0254;
    sunMaterials((uniforms) => {
      uniforms.actorSunSamples.value.copy(sunlight.samples);
      uniforms.actorSunSpan.value.set(base, span);
      uniforms.actorSunTraced.value = 1;
    });
  }, -1);
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
  const ragdollBones = useMemo(
    () => ragdollData?.bodies.map((body) => prepared.instance.getObjectByName(body.bone)) ?? [],
    [ragdollData, prepared],
  );
  const ragdollWorlds = useMemo(() => ragdollBones.map(() => new Matrix4()), [ragdollBones]);
  /** The model's own ragdoll for a recorded death, built once from the last living stance. */
  function ragdollFor(death: NonNullable<DirectionalSample['death']>) {
    if (!ragdoll || !ragdollData || ragdollBones.some((bone) => !(bone instanceof Bone))) return;
    let simulation = ragdoll.cache.get(ragdoll.request.key);
    if (!simulation) {
      pose.sample(tick / rate - death.age, 0, ragdoll.request.duck, undefined, {
        ...directional,
        weapon: ragdoll.request.weapon,
        death: undefined,
      });
      prepared.root.updateWorldMatrix(true, true);
      const bones = new Map(
        ragdollData.bodies.map((body, index) => [
          body.bone,
          ragdollBones[index]!.matrixWorld.clone(),
        ]),
      );
      simulation = createRagdollSimulation(
        ragdollData,
        {
          bones,
          velocity: ragdoll.request.velocity,
          impulse: {
            body: ragdollData.bodies.findIndex((body) => body.bone === ragdoll.request.bone),
            direction: ragdoll.request.direction,
            speed: ragdoll.request.speed,
          },
        },
        ragdoll.world,
      );
      // Bounded: the oldest simulations leave first.
      if (ragdoll.cache.size >= 32) ragdoll.cache.delete(ragdoll.cache.keys().next().value!);
      ragdoll.cache.set(ragdoll.request.key, simulation);
    }
    return simulation;
  }
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
    const simulation = directional.death ? ragdollFor(directional.death) : undefined;
    if (simulation && directional.death) {
      // The React tick lags the frame clock during playback; advance with the replay tick.
      const age = Math.max(
        0,
        directional.death.age + ((replayTime?.tick ?? frameTick) - frameTick) / rate,
      );
      simulation.advanceTo(age);
      simulation.sample(age, ragdollWorlds);
      applyRagdollPose(prepared.instance, ragdollBones as Bone[], ragdollWorlds);
      xray?.sample(xrayColor);
      return;
    }
    const recorded = !directional.death && bank ? evidence?.(tick) : undefined;
    // The feet keep their own yaw while standing; the spine carries the rest of the aim.
    prepared.root.rotation.y = Math.PI / 2 - MathUtils.degToRad(recorded?.twist ?? 0);
    const input = motion ? { ...directional, ...motion } : directional;
    const deathTime = pose.sample(
      tick / rate,
      motion?.speed ?? speed,
      duck,
      phase,
      recorded ? { ...input, ...recorded } : input,
    );
    if (lock) footLock.apply();
    if (deathTime !== undefined) corpseFloor?.(deathTime, floor);
    xray?.sample(xrayColor);
  }, -2);
  return <primitive object={prepared.root} dispose={null} />;
}
/** Load the shared bank beside the model. A missing or invalid bank leaves the
 * agent on its class poses instead of failing the actor. */
class ActionBankBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
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
function WithActionBank({
  url,
  children,
}: {
  url: string;
  children: (bank: ActionBank | undefined, ragdoll: RagdollData | undefined) => ReactNode;
}) {
  const gltf = useEquipmentGLTF(url);
  return children(agentActionBank(gltf), agentRagdoll(gltf));
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
        {context.actions ? (
          <ActionBankBoundary
            fallback={<LoadedAgent {...props} scope={scope} ready={callbacks.ready} />}
          >
            <WithActionBank url={context.actions}>
              {(bank, ragdollData) => (
                <LoadedAgent
                  {...props}
                  scope={scope}
                  ready={callbacks.ready}
                  bank={bank}
                  ragdollData={ragdollData}
                />
              )}
            </WithActionBank>
          </ActionBankBoundary>
        ) : (
          <LoadedAgent {...props} scope={scope} ready={callbacks.ready} />
        )}
      </Suspense>
    </AgentBoundary>
  );
}

export function RecordedAgentBody({
  body: { position, variant, age },
  death,
  ragdoll,
  url,
  clips,
  tick,
  rate,
  reducedMotion,
  shadowPose,
  floor,
}: {
  body: AgentDeathSample;
  /** Valve's death clip for the recorded kill and the yaw that sends the fall along the shot. */
  death?: { role: string; yaw: number };
  ragdoll?: AgentProps['ragdoll'];
  url: string | null;
  clips?: string;
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
      // A ragdoll falls along the recorded shot by itself; an authored clip is turned instead.
      rotation={[0, MathUtils.degToRad(ragdoll ? position.yaw : (death?.yaw ?? position.yaw)), 0]}
    >
      <RenderAgent
        url={url}
        clips={clips}
        id={'death:' + position.id}
        tick={tick}
        rate={rate}
        speed={0}
        duck={0}
        fallback={null}
        shadowPose={shadowPose}
        floor={floor}
        ragdoll={ragdoll}
        directional={{
          yaw: position.yaw,
          pitch: 0,
          weapon: '',
          velocityX: 0,
          velocityY: 0,
          death: { age: reducedMotion ? Infinity : age, variant, role: death?.role },
        }}
      />
    </group>
  );
}
