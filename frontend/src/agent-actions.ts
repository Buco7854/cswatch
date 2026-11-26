import {
  Bone,
  InterpolateLinear,
  LinearInterpolant,
  Matrix4,
  Quaternion,
  QuaternionLinearInterpolant,
  Vector3,
  type AnimationClip,
  type Object3D,
} from 'three';
import {
  agentActionDeclarations,
  agentActionContract,
  type AgentActionBlend,
} from '../../shared/agent-actions.mjs';

/** The shared native action bank. Its curves bind by bone name to any agent model.
 * Rotations drive every joint; translations only drive the joints that carry motion,
 * so each agent keeps its own bone lengths. */
type Curve = {
  bone: number;
  position: boolean;
  values: Float32Array;
  interpolant: LinearInterpolant | QuaternionLinearInterpolant | null;
};
export type ActionClip = {
  duration: number;
  blend: AgentActionBlend;
  climbMeters?: number;
  curves: Curve[];
};
export type ActionBank = { bones: string[]; clips: Map<string, ActionClip> };
const travelling = new Set(['root_motion', 'pelvis', 'wpnPivot', 'wpn']);

const banks = new WeakMap<object, ActionBank | null>();
export function agentActionBank(gltf: {
  animations: AnimationClip[];
  parser: { json: { animations?: unknown } };
}) {
  if (banks.has(gltf)) return banks.get(gltf) ?? undefined;
  const bank = readActionBank(gltf.animations, gltf.parser.json.animations);
  banks.set(gltf, bank ?? null);
  return bank;
}

export function readActionBank(
  clips: readonly AnimationClip[],
  declarations: unknown,
): ActionBank | undefined {
  const metadata = agentActionDeclarations(declarations);
  if (!metadata || clips.length !== metadata.size) return;
  const bones: string[] = [],
    index = new Map<string, number>(),
    result = new Map<string, ActionClip>();
  for (const clip of clips) {
    const role = clip.name.slice('cswatch:'.length);
    const meta = metadata.get(role);
    if (
      !meta ||
      result.has(role) ||
      !(clip.duration > 0 && clip.duration <= agentActionContract.limits.seconds) ||
      !clip.tracks.length ||
      clip.tracks.length > agentActionContract.limits.maxChannels
    )
      return;
    const curves: Curve[] = [];
    for (const track of clip.tracks) {
      const match = /^([^.]+)\.(position|quaternion)$/.exec(track.name);
      if (!match) return;
      const position = match[2] === 'position';
      if (
        track.getInterpolation() !== InterpolateLinear ||
        track.getValueSize() !== (position ? 3 : 4) ||
        track.times.length > 2048 ||
        !track.validate()
      )
        return;
      if (position && !travelling.has(match[1])) continue;
      let bone = index.get(match[1]);
      if (bone === undefined) {
        bone = bones.length;
        bones.push(match[1]);
        index.set(match[1], bone);
      }
      curves.push({
        bone,
        position,
        values: track.values as Float32Array,
        interpolant:
          track.times.length === 1
            ? null
            : position
              ? new LinearInterpolant(track.times, track.values, 3)
              : new QuaternionLinearInterpolant(track.times, track.values, 4),
      });
    }
    result.set(role, {
      duration: clip.duration,
      blend: meta.blend,
      climbMeters: meta.climbMeters,
      curves,
    });
  }
  return { bones, clips: result };
}

const indices = new WeakMap<ActionClip, Map<number, Curve>>();
function referenceIndex(clip: ActionClip) {
  let index = indices.get(clip);
  if (!index)
    indices.set(clip, (index = new Map(clip.curves.map((c) => [c.bone * 2 + +c.position, c]))));
  return index;
}
const vector = new Vector3(),
  rotation = new Quaternion(),
  first = new Quaternion(),
  delta = new Quaternion(),
  firstVector = new Vector3();

/** Bind the bank to one posed agent instance. */
export function bindAgentActions(root: Object3D, bank: ActionBank) {
  const named = new Map<string, Bone>();
  root.traverse((node) => {
    if (node instanceof Bone) named.set(node.name, node);
  });
  const bones = bank.bones.map((name) => named.get(name));
  const read = (curve: Curve, time: number) =>
    curve.interpolant ? curve.interpolant.evaluate(time) : curve.values;
  const clamp = (clip: ActionClip, time: number) => Math.min(Math.max(time, 0), clip.duration);
  return {
    has: (role: string) => bank.clips.has(role),
    duration: (role: string) => bank.clips.get(role)?.duration,
    /** Blend toward the authored pose. `skip` omits joints (for example the legs). */
    climbMeters: (role: string) => bank.clips.get(role)?.climbMeters,
    /** Blend toward the authored pose. A weight function can mask or scale joints. */
    pose(role: string, time: number, weight: number | ((bone: Bone) => number)) {
      const clip = bank.clips.get(role);
      if (!clip || (typeof weight === 'number' && !(weight > 0))) return false;
      const at = clamp(clip, time);
      for (const curve of clip.curves) {
        const bone = bones[curve.bone];
        if (!bone) continue;
        const amount = Math.min(typeof weight === 'number' ? weight : weight(bone), 1);
        if (!(amount > 0)) continue;
        const data = read(curve, at);
        if (curve.position) bone.position.lerp(vector.fromArray(data), amount);
        else bone.quaternion.slerp(rotation.fromArray(data).normalize(), amount);
      }
      return true;
    },
    /** Apply the clip's change since `reference` (default: its first frame) on top of
     * the current pose: Valve authors these layers as additive deltas. */
    delta(
      role: string,
      time: number,
      weight: number,
      reference?: { role: string; time: number },
      skip?: (bone: Bone) => boolean,
    ) {
      const clip = bank.clips.get(role);
      const base = reference ? bank.clips.get(reference.role) : clip;
      if (!clip || !base || !(weight > 0)) return false;
      const at = clamp(clip, time),
        baseAt = reference ? clamp(base, reference.time) : 0;
      const references = reference ? referenceIndex(base) : undefined;
      for (const curve of clip.curves) {
        const bone = bones[curve.bone];
        if (!bone || skip?.(bone)) continue;
        const origin = references ? references.get(curve.bone * 2 + +curve.position) : curve;
        if (!origin) continue;
        const now = read(curve, at);
        const then = read(origin, baseAt);
        if (curve.position) {
          vector.fromArray(now).sub(firstVector.fromArray(then)).multiplyScalar(weight);
          bone.position.add(vector);
        } else {
          first.fromArray(then).normalize().invert();
          delta.copy(first).multiply(rotation.fromArray(now).normalize());
          if (weight < 1) delta.slerp(rotation.identity(), 1 - weight);
          bone.quaternion.multiply(delta);
        }
      }
      return true;
    },
    /** World transform of `name` relative to `parent` in the authored pose. */
    relative(role: string, time: number, name: string, parent: string, target: Matrix4) {
      const clip = bank.clips.get(role);
      const bone = named.get(name),
        frame = named.get(parent);
      if (!clip || !bone || !frame) return false;
      const saved: [Bone, Vector3, Quaternion][] = [];
      root.traverse((node) => {
        if (node instanceof Bone)
          saved.push([node, node.position.clone(), node.quaternion.clone()]);
      });
      this.pose(role, time, 1);
      root.updateWorldMatrix(true, true);
      target.copy(frame.matrixWorld).invert().multiply(bone.matrixWorld);
      for (const [node, position, quaternion] of saved) {
        node.position.copy(position);
        node.quaternion.copy(quaternion);
      }
      root.updateWorldMatrix(true, true);
      return true;
    },
  };
}
export type AgentActions = ReturnType<typeof bindAgentActions>;
