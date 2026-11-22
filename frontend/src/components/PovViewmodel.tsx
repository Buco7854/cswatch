import {
  Component,
  Suspense,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import {
  AnimationClip,
  AnimationMixer,
  Bone,
  Group,
  LoopOnce,
  Object3D,
  Quaternion,
  Vector3,
  type AnimationAction,
} from 'three';
import viewmodels from '../../../shared/viewmodels.json' with { type: 'json' };
import { canonicalEquipmentKey } from '../equipment-key';
import { useEquipmentGLTF, useEquipmentScope } from '../equipment-loader';
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

type ViewmodelId = keyof typeof viewmodels;
function viewmodelId(weapon: string): ViewmodelId | undefined {
  const canonical = canonicalEquipmentKey(weapon);
  const id = canonical === 'm4a1' ? 'm4a4' : canonical;
  return Object.hasOwn(viewmodels, id) ? (id as ViewmodelId) : undefined;
}
const urlFor = (id: ViewmodelId) => `/api/assets/viewmodels/${id}/${viewmodels[id].sha256}.glb`;
type ReplayHistory = Pick<Playback, 'frames' | 'rounds' | 'tickRate'>;

function sampleAction(action: AnimationAction, sample?: WeaponPoseSample) {
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
  history,
  frameTick,
  tick,
  reducedMotion,
}: {
  position: Position;
  scope: ModelScope;
  id: ViewmodelId;
  history: ReplayHistory;
  frameTick: number;
  tick: number;
  reducedMotion: boolean;
}) {
  const gltf = useEquipmentGLTF(urlFor(id));
  const pin = viewmodels[id];
  const { invalidate } = useThree();
  useLayoutEffect(() => scope.acquire(), [scope]);
  const rig = useMemo(() => {
    const clip = gltf.animations.find((candidate) => candidate.name === id + '-fire');
    const reloadClip = gltf.animations.find((candidate) => candidate.name === id + '-reload');
    const drawClip = gltf.animations.find(
      (candidate) =>
        candidate.name === id + '-draw' &&
        candidate.duration > 0 &&
        candidate.duration <= 1.5 &&
        candidate.tracks.length > 0,
    );
    const cameraAnchor = gltf.scene.getObjectByName('root_motion');
    if (
      !(cameraAnchor instanceof Bone) ||
      !clip ||
      !(clip.duration > 0 && clip.duration < 2) ||
      !clip.tracks.length ||
      !reloadClip ||
      !(reloadClip.duration > 0 && reloadClip.duration <= 4) ||
      !reloadClip.tracks.length
    )
      throw new Error('Missing authored first-person action or anchor');
    const origin = cameraAnchor.getWorldPosition(cameraAnchor.position.clone());
    if (origin.lengthSq() > 1e-8) throw new Error('Unsupported first-person rest origin');
    assertMapBaseColorTextures({ scene: gltf.scene, parser: gltf.parser });
    const model = prepareEquipmentModel(gltf.scene);
    const barrel = model.getObjectByName(pin.muzzle.bone);
    if (barrel instanceof Bone) {
      const marker = new Object3D();
      marker.name = 'cswatch_native_muzzle';
      marker.userData.cswatchNativeAttachment = 'muzzle_flash';
      marker.position.fromArray(pin.muzzle.sourceInches).multiplyScalar(0.0254);
      marker.quaternion.fromArray(pin.muzzle.quaternion);
      barrel.add(marker);
    }
    const mixer = new AnimationMixer(model);
    const fire = mixer.clipAction(clip).setLoop(LoopOnce, 1);
    const priorFire = mixer
      .clipAction(new AnimationClip(id + '-prior-fire', clip.duration, clip.tracks))
      .setLoop(LoopOnce, 1);
    const reload = mixer.clipAction(reloadClip).setLoop(LoopOnce, 1);
    return {
      model,
      mixer,
      fire,
      priorFire,
      reload,
      draw: drawClip ? mixer.clipAction(drawClip).setLoop(LoopOnce, 1) : undefined,
      drawDuration: drawClip?.duration,
      fireDuration: clip.duration,
      reloadDuration: reloadClip.duration,
    };
  }, [gltf, id, pin]);
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
  position,
  fallback,
  identity,
  ...sampling
}: {
  id: ViewmodelId;
  position: Position;
  fallback: ReactNode;
  identity: object;
  history: ReplayHistory;
  frameTick: number;
  tick: number;
  reducedMotion: boolean;
}) {
  const scope = useEquipmentScope(urlFor(id), identity);
  return (
    <ViewmodelBoundary fallback={fallback} scope={scope}>
      <Suspense fallback={fallback}>
        <AuthoredViewmodel position={position} scope={scope} id={id} {...sampling} />
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
  const [available, setAvailable] = useState<{ identity: object; ids: ReadonlySet<ViewmodelId> }>();
  const id = native && props.position.alive ? viewmodelId(props.position.weapon) : undefined;
  const ready = Boolean(id && available?.identity === identity && available?.ids.has(id));
  useEffect(() => {
    if (!identity || !id || ready) return;
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 10000);
    void fetch(urlFor(id), {
      method: 'HEAD',
      credentials: 'same-origin',
      redirect: 'error',
      signal: controller.signal,
    })
      .then((response) => {
        if (
          response.ok &&
          response.headers.get('content-type') === 'model/gltf-binary' &&
          Number(response.headers.get('content-length')) === viewmodels[id].bytes &&
          !controller.signal.aborted
        )
          setAvailable((current) => ({
            identity,
            ids: new Set([...(current?.identity === identity ? current.ids : []), id]),
          }));
      })
      .catch(() => {})
      .finally(() => clearTimeout(deadline));
    return () => {
      clearTimeout(deadline);
      controller.abort();
    };
  }, [identity, id, ready]);
  const fallback = <PovEquipment position={props.position} />;
  return (
    <group ref={root}>
      {id && identity && ready ? (
        <AvailableViewmodel
          key={id + ':' + props.position.id}
          id={id}
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
