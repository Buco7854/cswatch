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
  Quaternion,
  Vector3,
  type AnimationAction,
} from 'three';
import type { ViewmodelAsset } from '../../../shared/viewmodel-assets';
import type { EquipmentCatalog } from '../equipment-assets';
import { canonicalEquipmentKey } from '../equipment-key';
import { usePovGLTF, usePovScope } from '../equipment-loader';
import type { ModelScope } from '../model-cache';
import { assertMapBaseColorTextures } from '../map-model';
import { disposeEquipmentInstance, prepareEquipmentModel } from '../equipment-model';
import type { Playback, Position } from '../types';
import { povDraw, povLanding, povMovement } from '../pov-movement';
import { povOffset } from '../pov-camera';
import { useReducedMotion } from '../reduced-motion';
import { EquipmentMuzzle, useNativeWeaponPose } from './EquipmentFire';
import type { WeaponPoseSample } from '../weapon-fire';
import { EquipmentModels, PovEquipment, type PovEquipmentProps } from './RenderEquipment';

type ReplayHistory = Pick<Playback, 'frames' | 'rounds' | 'tickRate'>;

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
  history,
  frameTick,
  tick,
  reducedMotion,
}: {
  position: Position;
  scope: ModelScope;
  id: string;
  asset: ViewmodelAsset;
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
    const mixer = new AnimationMixer(model);
    const action = (value: AnimationClip | undefined) =>
      value ? mixer.clipAction(value).setLoop(LoopOnce, 1) : undefined;
    return {
      model,
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
  const draw =
    !reducedMotion && rig.drawDuration && !fire && !priorFire && !reload
      ? povDraw(history, position, frameTick, tick, rig.drawDuration)
      : undefined;
  useLayoutEffect(() => {
    sampleAction(rig.fire, fire);
    sampleAction(rig.priorFire, priorFire);
    sampleAction(rig.reload, reload);
    if (rig.draw) sampleAction(rig.draw, draw);
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
    invalidate,
  ]);
  useEffect(
    () => () => {
      rig.mixer.stopAllAction();
      rig.mixer.uncacheRoot(rig.model);
      disposeEquipmentInstance(rig.model);
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
  history: ReplayHistory;
  frameTick: number;
  tick: number;
  reducedMotion: boolean;
}) {
  const scope = usePovScope(asset.model, identity);
  return (
    <ViewmodelBoundary fallback={fallback} scope={scope}>
      <Suspense fallback={fallback}>
        <AuthoredViewmodel position={position} scope={scope} id={id} asset={asset} {...sampling} />
      </Suspense>
    </ViewmodelBoundary>
  );
}

/** Local asset availability is scoped to this viewer. Missing artwork keeps the normal POV. */
export default function PovViewmodel({
  native,
  history,
  tick,
  ...props
}: PovEquipmentProps & { native: boolean; history: ReplayHistory; tick: number }) {
  const context = useContext(EquipmentModels);
  const reducedMotion = useReducedMotion();
  const frameTick = props.timing?.fromTick ?? tick;
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
  const fallback = <PovEquipment position={props.position} />;
  return (
    <group ref={root}>
      {identity && asset ? (
        <AvailableViewmodel
          key={asset.model + ':' + props.position.id + ':' + props.position.team}
          id={id}
          asset={asset}
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
