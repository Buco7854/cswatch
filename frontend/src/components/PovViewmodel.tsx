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
import { AnimationMixer, Bone, Group, LoopOnce, Object3D, Quaternion, Vector3 } from 'three';
import viewmodels from '../../../shared/viewmodels.json' with { type: 'json' };
import { canonicalEquipmentKey } from '../equipment-key';
import { useEquipmentGLTF, useEquipmentScope } from '../equipment-loader';
import type { ModelScope } from '../model-cache';
import { assertMapBaseColorTextures } from '../map-model';
import { disposeEquipmentInstance, prepareEquipmentModel } from '../equipment-model';
import type { Position } from '../types';
import { povMovement } from '../pov-movement';
import { useReducedMotion } from '../reduced-motion';
import { EquipmentMuzzle, useNativeWeaponAction } from './EquipmentFire';
import { EquipmentModels, PovEquipment, type PovEquipmentProps } from './RenderEquipment';

type ViewmodelId = keyof typeof viewmodels;
function viewmodelId(weapon: string): ViewmodelId | undefined {
  const canonical = canonicalEquipmentKey(weapon);
  const id = canonical === 'm4a1' ? 'm4a4' : canonical;
  return Object.hasOwn(viewmodels, id) ? (id as ViewmodelId) : undefined;
}
const urlFor = (id: ViewmodelId) => `/api/assets/viewmodels/${id}/${viewmodels[id].sha256}.glb`;
// The S2V viewmodel looks towards +Z. A Three camera looks towards its local -Z.
const authoredBasis = new Quaternion(0, 1, 0, 0);
const cameraDepthAxis = new Vector3(0, 0, -1);

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
  motion,
}: {
  position: Position;
  scope: ModelScope;
  id: ViewmodelId;
  motion: PovEquipmentProps['motion'];
}) {
  const gltf = useEquipmentGLTF(urlFor(id));
  const pin = viewmodels[id];
  const { invalidate } = useThree();
  useLayoutEffect(() => scope.acquire(), [scope]);
  const rig = useMemo(() => {
    const clip = gltf.animations.find((candidate) => candidate.name === id + '-fire');
    const reloadClip = gltf.animations.find((candidate) => candidate.name === id + '-reload');
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
    const reload = mixer.clipAction(reloadClip).setLoop(LoopOnce, 1);
    return {
      model,
      mixer,
      fire,
      reload,
      fireDuration: clip.duration,
      reloadDuration: reloadClip.duration,
    };
  }, [gltf, id, pin]);
  const action = useNativeWeaponAction(position, rig.fireDuration, rig.reloadDuration);
  const kind = action?.type,
    age = action?.age;
  const root = useRef<Group>(null);
  const framing = useMemo(() => new Vector3(), []);
  const lean = useMemo(() => new Quaternion(), []);
  useLayoutEffect(() => invalidate(), [motion, invalidate]);
  useLayoutEffect(() => {
    if (kind !== 'fire') rig.fire.stop();
    if (kind !== 'reload') rig.reload.stop();
    if (kind && age !== undefined) {
      rig[kind].reset().play();
      rig.mixer.setTime(age);
    }
    invalidate();
  }, [rig, kind, age, invalidate]);
  useEffect(
    () => () => {
      rig.mixer.stopAllAction();
      rig.mixer.uncacheRoot(rig.model);
      disposeEquipmentInstance(rig.model);
    },
    [rig],
  );
  useFrame(({ camera, size }) => {
    if (!root.current) return;
    // Keep the held model in frame on tall displays without changing the map projection.
    const portrait = Math.max(0, Math.min(1, (1.2 - size.width / size.height) / 0.75));
    framing.set(
      -0.09 * portrait + (motion?.side ?? 0),
      -0.026 * portrait + (motion?.lift ?? 0),
      -0.14 * portrait - (motion?.depth ?? 0),
    );
    root.current.position.copy(camera.position).add(framing.applyQuaternion(camera.quaternion));
    root.current.quaternion
      .copy(camera.quaternion)
      .multiply(lean.setFromAxisAngle(cameraDepthAxis, motion?.roll ?? 0))
      .multiply(authoredBasis);
  }, 1);
  return (
    <group ref={root} name={'native-' + id + '-viewmodel'}>
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
  motion,
}: {
  id: ViewmodelId;
  position: Position;
  fallback: ReactNode;
  identity: object;
  motion: PovEquipmentProps['motion'];
}) {
  const scope = useEquipmentScope(urlFor(id), identity);
  return (
    <ViewmodelBoundary fallback={fallback} scope={scope}>
      <Suspense fallback={fallback}>
        <AuthoredViewmodel position={position} scope={scope} id={id} motion={motion} />
      </Suspense>
    </ViewmodelBoundary>
  );
}

/** Local asset availability is scoped to this viewer. Missing artwork keeps the normal POV. */
export default function PovViewmodel({
  native,
  ...props
}: PovEquipmentProps & { native: boolean }) {
  const context = useContext(EquipmentModels);
  const reducedMotion = useReducedMotion();
  const motion = reducedMotion
    ? undefined
    : povMovement(props.position, props.next, props.alpha, props.timing);
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
  const fallback = <PovEquipment {...props} motion={motion} />;
  return id && identity && ready ? (
    <AvailableViewmodel
      key={id + ':' + props.position.id}
      id={id}
      position={props.position}
      fallback={fallback}
      identity={identity}
      motion={motion}
    />
  ) : (
    fallback
  );
}
