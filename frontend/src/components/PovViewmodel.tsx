import { reusePackedMaterialSamples } from '../packed-material';
import {
  Component,
  Suspense,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import {
  AnimationClip,
  AnimationMixer,
  Bone,
  Group,
  LoopOnce,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
  type AnimationAction,
  type Material,
  type Object3D,
} from 'three';
import type { ViewmodelAsset } from '../../../shared/viewmodel-assets';
import type { EquipmentCatalog } from '../equipment-assets';
import { canonicalEquipmentKey } from '../equipment-key';
import { loadedEquipmentModel, usePovGLTF, usePovScope } from '../equipment-loader';
import { agentModelClips, agentStrideProfile } from '../directional-agent';
import { agentPhaseAt } from '../agent-phase';
import type { GaitHistory } from '../../../shared/agent-gait-history.mjs';
import type { ModelScope } from '../model-cache';
import { assertMapBaseColorTextures } from '../map-model';
import { disposeEquipmentInstance, prepareEquipmentModel } from '../equipment-model';
import type { Playback, Position } from '../types';
import type { PovAction } from '../agent-replay';
import { povDraw, povLanding, povMovement } from '../pov-movement';
import { povOffset } from '../pov-camera';
import { useReducedMotion } from '../reduced-motion';
import { EquipmentMuzzle, useNativeWeaponPose } from './EquipmentFire';
import type { WeaponPoseSample } from '../weapon-fire';
import {
  EquipmentInstanceState,
  EquipmentModels,
  PovEquipment,
  type PovEquipmentProps,
} from './RenderEquipment';

type ReplayHistory = Pick<Playback, 'frames' | 'rounds' | 'tickRate'>;

function viewmodelWeaponMaterials(model: Object3D) {
  const copies = new Map<Material, MeshPhysicalMaterial>();
  const adapt = (base: Material) => {
    const source = base.userData.vmat;
    if (!(base instanceof MeshStandardMaterial) || source?.ShaderName !== 'csgo_weapon.vfx')
      return base;
    const known = copies.get(base);
    if (known) return known;
    const range = source.VectorParams?.g_vMetalnessRemapRange ?? [0, 1];
    if (!Array.isArray(range) || range.length < 2) return base;
    const [low, high] = range;
    const bias = source.FloatParams?.g_flMetalnessTransitionBias ?? 2;
    if (
      ![low, high, bias].every(Number.isFinite) ||
      low < 0 ||
      high < low ||
      high > 1 ||
      bias < 1 ||
      bias > 4
    )
      return base;
    const material = new MeshPhysicalMaterial();
    const defines = material.defines;
    MeshStandardMaterial.prototype.copy.call(material, base);
    material.defines = defines;
    // The weapon shader's dielectric F0 is 0.02. Preserve the packed metal,
    // roughness, normal and AO maps while applying its metalness transition.
    material.ior = (1 + Math.sqrt(0.02)) / (1 - Math.sqrt(0.02));
    material.onBeforeCompile = (shader) => {
      shader.uniforms.cswatchWeaponMetal = { value: [low, high] };
      shader.uniforms.cswatchWeaponDiffuseBias = { value: bias };
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          uniform vec2 cswatchWeaponMetal;
          uniform float cswatchWeaponDiffuseBias;`,
        )
        .replace(
          '#include <metalnessmap_fragment>',
          `#include <metalnessmap_fragment>
          metalnessFactor = mix(cswatchWeaponMetal.x, cswatchWeaponMetal.y, metalnessFactor);`,
        )
        .replace(
          '#include <lights_physical_fragment>',
          `#include <lights_physical_fragment>
          material.diffuseContribution = diffuseColor.rgb * pow(1.0 - metalnessFactor, cswatchWeaponDiffuseBias);`,
        )
        .replace(
          '#include <lights_fragment_end>',
          `#include <lights_fragment_end>
          // Retain the hue and low-level detail of the highlight under the shared map grade.
          vec3 highlights = reflectedLight.directSpecular + reflectedLight.indirectSpecular;
          float peak = max3(highlights);
          float excess = max(0.0, peak - 0.25);
          float shoulder = mix(1.5, 0.55, metalnessFactor);
          float gain = (min(peak, 0.25) + excess / (1.0 + excess / shoulder)) / max(peak, 0.00001);
          reflectedLight.directSpecular *= gain;
          reflectedLight.indirectSpecular *= gain;`,
        );
    };
    material.customProgramCacheKey = () => 'cswatch-weapon-metal';
    reusePackedMaterialSamples(material);
    copies.set(base, material);
    return material;
  };
  model.traverse((node) => {
    if (node instanceof Mesh)
      node.material = Array.isArray(node.material)
        ? node.material.map(adapt)
        : adapt(node.material);
  });
  return () => {
    for (const material of copies.values()) material.dispose();
  };
}

function sampleAction(action?: AnimationAction, sample?: WeaponPoseSample) {
  if (!action) return;
  if (!sample || sample.weight <= 0) {
    if (action.isScheduled()) action.stop();
    return;
  }
  if (!action.isScheduled()) action.reset().play();
  action.time = sample.age;
  action.setEffectiveWeight(sample.weight);
}

class ViewmodelBoundary extends Component<
  { fallback: ReactNode; scope: ModelScope; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.scope.invalidate();
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function AuthoredViewmodel({
  position,
  scope,
  id,
  asset,
  action: recordedAction,
  history,
  frameTick,
  tick,
  reducedMotion,
}: {
  position: Position;
  scope: ModelScope;
  id: string;
  asset: ViewmodelAsset;
  action?: PovAction;
  history: ReplayHistory;
  frameTick: number;
  tick: number;
  reducedMotion: boolean;
}) {
  const gltf = usePovGLTF(asset.model);
  const { invalidate } = useThree();
  useLayoutEffect(() => scope.acquire(), [scope]);
  const rig = useMemo(() => {
    const clip = gltf.animations.find((candidate) => candidate.name === id + '-fire');
    const reloadClip = gltf.animations.find((candidate) => candidate.name === id + '-reload');
    const drawClip = gltf.animations.find(
      (candidate) =>
        candidate.name === id + '-draw' &&
        candidate.duration > 0 &&
        candidate.duration <= 2.5 &&
        candidate.tracks.length > 0,
    );
    const cameraAnchor = gltf.scene.getObjectByName('root_motion');
    if (!(cameraAnchor instanceof Bone) || !drawClip)
      throw new Error('Missing authored first-person action or anchor');
    const origin = cameraAnchor.getWorldPosition(cameraAnchor.position.clone());
    if (origin.lengthSq() > 1e-8) throw new Error('Unsupported first-person rest origin');
    assertMapBaseColorTextures({ scene: gltf.scene, parser: gltf.parser });
    const model = prepareEquipmentModel(gltf.scene);
    const disposeMaterials = viewmodelWeaponMaterials(model);
    const mixer = new AnimationMixer(model);
    const action = (value: AnimationClip | undefined) =>
      value ? mixer.clipAction(value).setLoop(LoopOnce, 1) : undefined;
    return {
      model,
      mount: model.getObjectByName(id + '-authored-mount'),
      utility: Object.fromEntries(
        (['throw', 'underhand', 'slash'] as const).map((kind) => [
          kind,
          action(gltf.animations.find((clip) => clip.name === id + '-' + kind)),
        ]),
      ),
      disposeMaterials,
      mixer,
      fire: action(clip),
      priorFire: action(clip && new AnimationClip(id + '-prior-fire', clip.duration, clip.tracks)),
      reload: action(reloadClip),
      draw: action(drawClip),
      drawDuration: drawClip.duration,
      fireDuration: clip?.duration ?? 0,
      reloadDuration: reloadClip?.duration ?? 0,
    };
  }, [gltf, id]);
  const pose = useNativeWeaponPose(position, rig.fireDuration, rig.reloadDuration);
  const { fire, priorFire, reload } = pose;
  const action = !reducedMotion && recordedAction ? rig.utility[recordedAction.kind] : undefined;
  const age = recordedAction?.age ?? 0;
  const duration = action?.getClip().duration ?? 0;
  const actionWeight = age < duration ? Math.min(1, age / 0.05, (duration - age) / 0.08) : 0;
  const released = recordedAction?.released === true;
  const draw =
    !reducedMotion && rig.drawDuration && !fire && !priorFire && !reload && !actionWeight
      ? povDraw(history, position, frameTick, tick, rig.drawDuration)
      : undefined;
  useLayoutEffect(() => {
    sampleAction(rig.fire, fire);
    sampleAction(rig.priorFire, priorFire);
    sampleAction(rig.reload, reload);
    if (rig.draw) sampleAction(rig.draw, draw);
    for (const clip of Object.values(rig.utility))
      sampleAction(clip, clip && clip === action ? { age, weight: actionWeight } : undefined);
    if (rig.mount) rig.mount.visible = !released;
    rig.mixer.update(0);
    invalidate();
  }, [
    rig,
    fire?.age,
    fire?.weight,
    priorFire?.age,
    priorFire?.weight,
    reload?.age,
    reload?.weight,
    draw?.age,
    draw?.weight,
    action,
    age,
    actionWeight,
    released,
    invalidate,
  ]);
  useEffect(
    () => () => {
      rig.mixer.stopAllAction();
      rig.mixer.uncacheRoot(rig.model);
      disposeEquipmentInstance(rig.model);
      rig.disposeMaterials();
    },
    [rig],
  );
  return (
    // The S2V viewmodel looks towards +Z. A Three camera looks towards its local -Z.
    <group rotation-y={Math.PI} name={'native-' + id + '-viewmodel'}>
      <primitive object={rig.model} dispose={null}>
        <EquipmentMuzzle position={position} model={rig.model} pov />
      </primitive>
    </group>
  );
}

function AvailableViewmodel({
  id,
  asset,
  position,
  fallback,
  identity,
  ...sampling
}: {
  id: string;
  asset: ViewmodelAsset;
  position: Position;
  fallback: ReactNode;
  identity: object;
  action?: PovAction;
  history: ReplayHistory;
  frameTick: number;
  tick: number;
  reducedMotion: boolean;
}) {
  const scope = usePovScope(asset.model, identity);
  const instance = 'native-pov:' + position.id + ':' + id;
  return (
    <ViewmodelBoundary
      fallback={
        <EquipmentInstanceState instance={instance} status="error">
          {fallback}
        </EquipmentInstanceState>
      }
      scope={scope}
    >
      <Suspense
        fallback={
          <EquipmentInstanceState instance={instance} status="pending">
            {fallback}
          </EquipmentInstanceState>
        }
      >
        <EquipmentInstanceState instance={instance} status="ready">
          <AuthoredViewmodel
            position={position}
            scope={scope}
            id={id}
            asset={asset}
            {...sampling}
          />
        </EquipmentInstanceState>
      </Suspense>
    </ViewmodelBoundary>
  );
}

/** Local asset availability is scoped to this viewer. Missing artwork keeps the normal POV. */
export default function PovViewmodel({
  native,
  agentModel,
  gaitHistory,
  action,
  airborne,
  history,
  tick,
  ...props
}: PovEquipmentProps & {
  native: boolean;
  agentModel?: string | null;
  gaitHistory?: GaitHistory;
  action?: PovAction;
  airborne: number;
  history: ReplayHistory;
  tick: number;
}) {
  const context = useContext(EquipmentModels);
  const reducedMotion = useReducedMotion();
  const frameTick = props.timing?.fromTick ?? tick;
  const teamRig = !reducedMotion && agentModel ? loadedEquipmentModel(agentModel) : undefined;
  const stride = useMemo(() => {
    const clips = teamRig && agentModelClips(teamRig);
    return clips && agentStrideProfile(clips);
  }, [teamRig]);
  const phase = useMemo(
    () =>
      stride &&
      gaitHistory &&
      agentPhaseAt(gaitHistory, props.position.id, history.tickRate, stride),
    [stride, gaitHistory, props.position.id, history.tickRate],
  );

  const motion = reducedMotion
    ? undefined
    : povMovement(
        props.position,
        props.next,
        props.alpha,
        props.timing,
        props.previous,
        props.travelMeters,
        povLanding(history, props.position, frameTick, tick),
        airborne,
        phase?.(tick) ??
          (stride && props.travelMeters !== undefined
            ? props.travelMeters / stride.referenceStride
            : undefined),
      );
  const root = useRef<Group>(null);
  const { invalidate } = useThree();
  const framing = useMemo(() => new Vector3(), []);
  const eye = useMemo(() => new Quaternion(), []);
  useLayoutEffect(() => invalidate(), [motion, invalidate]);
  useFrame(({ camera }) => {
    const group = root.current;
    if (!group) return;
    camera.getWorldQuaternion(eye);
    framing.set(
      povOffset.right + (motion?.side ?? 0),
      povOffset.up + (motion?.lift ?? 0),
      -povOffset.forward - (motion?.depth ?? 0),
    );
    camera.getWorldPosition(group.position).add(framing.applyQuaternion(eye));
    group.rotation.set(motion?.pitch ?? 0, motion?.yaw ?? 0, -(motion?.roll ?? 0));
    group.quaternion.premultiply(eye);
  }, -2);
  const identity = context?.identity;
  const weapon = canonicalEquipmentKey(props.position.weapon);
  // The recording may use the generic knife name for the T-side stock knife.
  const id = weapon === 'knife' && props.position.team === 2 ? 'knifet' : weapon;
  const catalog = context?.catalog as EquipmentCatalog | undefined;
  const asset = native && props.position.alive ? catalog?.viewmodels?.[id] : undefined;
  const fallback = action?.released ? null : <PovEquipment position={props.position} />;
  return (
    <group ref={root}>
      {identity && asset ? (
        <AvailableViewmodel
          key={asset.model + ':' + props.position.id + ':' + props.position.team}
          id={id}
          asset={asset}
          action={action}
          position={props.position}
          fallback={fallback}
          identity={identity}
          history={history}
          frameTick={frameTick}
          tick={tick}
          reducedMotion={reducedMotion}
        />
      ) : (
        fallback
      )}
    </group>
  );
}
