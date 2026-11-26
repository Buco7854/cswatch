import {
  Bone,
  InterpolateLinear,
  LinearInterpolant,
  MathUtils,
  Matrix4,
  Quaternion,
  QuaternionLinearInterpolant,
  Vector3,
  type AnimationClip,
  type Object3D,
} from 'three';
import equipment from '../../shared/equipment-models.json' with { type: 'json' };
import { canonicalEquipmentKey } from './equipment-key';
import contract from '../../shared/agent-animation.json' with { type: 'json' };
import { agentWeaponClass } from '../../shared/agent-gait-history.mjs';
import type { AgentActionSample } from './agent-replay';
import { shortestAngle } from './player-pose';
import type { AgentActions } from './agent-actions';
import { createGripRig } from './agent-grip';
export { agentWeaponClass } from '../../shared/agent-gait-history.mjs';
import type {
  AgentDeath,
  AgentDirection,
  AgentGait,
  AgentWeaponClass,
  DirectionalAgentMetadata,
  DirectionalAgentRole,
} from '../../shared/agent-animation';
import {
  directionalMovementRoles,
  directionalDeclarations,
} from '../../shared/agent-animation-contract.mjs';

export type DirectionalSample = {
  yaw: number;
  pitch: number;
  velocityX: number;
  velocityY: number;
  coherence?: number;
  weapon: string;
  action?: AgentActionSample;
  defusing?: boolean;
  death?: { variant: number; age: number; role?: string };
  /** Recorded airborne state: weight in the air, seconds since take-off and landing. */
  air?: { weight: number; jumpAge?: number; landAge?: number };
  /** Recorded ladder movement: metres climbed (signed) and vertical speed (m/s). */
  ladder?: { climbed: number; speed: number };
  /** Aim yaw beyond the feet' yaw (degrees), carried by the spine while standing. */
  twist?: number;
  /** The standing feet's latest catch-up step (recordedStance). */
  turn?: { side: 'left' | 'right'; turned: number; restAge?: number };
  /** Most recent recorded hit: bank flinch role and its age in seconds. */
  flinch?: { role: string; age: number };
};
type NativeClip = { clip: AnimationClip; metadata: DirectionalAgentMetadata };
type ClipSet = ReadonlyMap<DirectionalAgentRole, NativeClip>;
type GaitSample = { role: DirectionalAgentRole; weight: number };
const directions = contract.directions as AgentDirection[];
const clamp = (value: number) => Math.max(0, Math.min(value, 1));
const cycle = (value: number) => value - Math.floor(value);
const smooth = (value: number) => {
  const t = clamp(value);
  return t * t * (3 - 2 * t);
};
/** The time fraction at which a smoothstep ease has covered `progress` of its change. */
const easedTime = (progress: number) => 0.5 - Math.sin(Math.asin(1 - 2 * clamp(progress)) / 3);

const loadedClips = new WeakMap<object, ClipSet | null>();
/** Agents and their POV rig share one validated set of source animation curves. */
export function agentModelClips(gltf: {
  animations: AnimationClip[];
  parser: { json: { animations?: unknown } };
}) {
  if (loadedClips.has(gltf)) return loadedClips.get(gltf) ?? undefined;
  const clips = directionalClips(gltf.animations, gltf.parser.json.animations);
  loadedClips.set(gltf, clips ?? null);
  return clips;
}

export function directionalClips(
  clips: readonly AnimationClip[],
  declarations: unknown,
): ClipSet | undefined {
  const metadata = directionalDeclarations(declarations);
  if (!metadata || clips.length !== metadata.size) return;
  const result = new Map<DirectionalAgentRole, NativeClip>();
  for (const clip of clips) {
    const role = clip.name.slice('cswatch:'.length) as DirectionalAgentRole;
    const meta = metadata.get(role);
    if (
      !meta ||
      clip.name !== 'cswatch:' + role ||
      result.has(role) ||
      !(clip.duration > 0 && clip.duration <= contract.limits.seconds) ||
      !clip.tracks.length ||
      clip.tracks.length > contract.limits.maxChannels ||
      (directionalMovementRoles.has(role) &&
        meta.strideMeters! / clip.duration > contract.limits.maxSpeedMetersPerSecond)
    )
      return;
    result.set(role, { clip, metadata: meta });
  }
  return result;
}

type Step = { stride: number; speed: number };
type StrideProfile = Map<AgentWeaponClass, Record<AgentGait, Step[]>>;

function gaitProfile(clips: ClipSet): StrideProfile {
  const profiles: StrideProfile = new Map();
  for (const weapon of contract.weaponClasses as AgentWeaponClass[]) {
    const steps = (gait: AgentGait) =>
      directions.map((direction) => {
        const { metadata, clip } = clips.get(`${weapon}-${gait}-${direction}`)!;
        const stride = metadata.strideMeters!;
        return { stride, speed: stride / clip.duration };
      });
    profiles.set(weapon, { walk: steps('walk'), run: steps('run'), crouch: steps('crouch') });
  }
  return profiles;
}
function gaitChoice(
  profile: StrideProfile,
  weapon: AgentWeaponClass,
  speed: number,
  duck: number,
  bearing: number,
) {
  const gait = profile.get(weapon)!;
  const direction = Number.isFinite(bearing) ? cycle(bearing / 360) * 8 : 0;
  const sector = Math.floor(direction);
  const towardNext = direction - sector;
  const next = (sector + 1) % 8;
  const walkSpeed = MathUtils.lerp(gait.walk[sector].speed, gait.walk[next].speed, towardNext);
  const runSpeed = MathUtils.lerp(gait.run[sector].speed, gait.run[next].speed, towardNext);
  const run = clamp((speed - walkSpeed) / Math.max(0.25, runSpeed - walkSpeed));
  const crouch = clamp(duck);
  const walkStride = MathUtils.lerp(gait.walk[sector].stride, gait.walk[next].stride, towardNext);
  const runStride = MathUtils.lerp(gait.run[sector].stride, gait.run[next].stride, towardNext);
  const crouchStride = MathUtils.lerp(
    gait.crouch[sector].stride,
    gait.crouch[next].stride,
    towardNext,
  );
  const stride = MathUtils.lerp(MathUtils.lerp(walkStride, runStride, run), crouchStride, crouch);
  return { weapon, stride, sector, next, towardNext, run, crouch };
}

const profiles = new WeakMap<ClipSet, StrideProfile>();
function profileFor(clips: ClipSet) {
  let profile = profiles.get(clips);
  if (!profile) {
    profile = gaitProfile(clips);
    profiles.set(clips, profile);
  }
  return profile;
}

export function directionalGait(
  clips: ClipSet,
  input: DirectionalSample,
  speed: number,
  duck: number,
  integratedPhase?: number,
) {
  // Positive Source-relative bearing points to the actor's left.
  const bearing = MathUtils.radToDeg(Math.atan2(input.velocityY, input.velocityX)) - input.yaw;
  const { weapon, stride, sector, next, towardNext, run, crouch } = gaitChoice(
    profileFor(clips),
    agentWeaponClass(input.weapon),
    speed,
    duck,
    bearing,
  );
  // Opposing velocities cancel before they can exchange directional weights.
  // A small diagonal residual during the crossover should stay mostly idle.
  const moving = clamp((speed - 0.05) / 0.45) * smooth((input.coherence ?? 1) / 0.65);
  const samples: GaitSample[] = [];
  const add = (role: DirectionalAgentRole, weight: number) => {
    if (weight > 0) samples.push({ role, weight });
  };
  add(`${weapon}-idle`, (1 - crouch) * (1 - moving));
  add(`${weapon}-crouch-idle`, crouch * (1 - moving));
  for (const [gait, weight] of [
    ['walk', (1 - crouch) * moving * (1 - run)],
    ['run', (1 - crouch) * moving * run],
    ['crouch', crouch * moving],
  ] as const) {
    add(`${weapon}-${gait}-${directions[sector]}`, weight * (1 - towardNext));
    add(`${weapon}-${gait}-${directions[next]}`, weight * towardNext);
  }
  return {
    weapon,
    stride,
    phase: integratedPhase === undefined ? undefined : cycle(integratedPhase),
    samples,
  };
}

export function agentStrideProfile(clips: ClipSet) {
  const profile = profileFor(clips);
  return {
    key: JSON.stringify([...profile]),
    // A single authored stride keeps legacy cumulative distance continuous
    // when the observed player changes weapon, direction, or stance.
    referenceStride: clips.get('rifle-walk-n')!.metadata.strideMeters!,
    strideAt: (weapon: AgentWeaponClass, speed: number, duck: number, bearing: number) =>
      gaitChoice(profile, weapon, speed, duck, bearing).stride,
  };
}

type BoneChannel = { bone: string; property: 'position' | 'quaternion' };
type Curve = {
  channel: number;
  values: Float32Array;
  interpolant: LinearInterpolant | QuaternionLinearInterpolant | null;
};
type PoseBank = {
  bindings: BoneChannel[];
  curves: Map<DirectionalAgentRole, Curve[]>;
};
type Channel = {
  target: Vector3 | Quaternion;
  rest: Vector3 | Quaternion;
  value: Vector3 | Quaternion;
  weight: number;
  masked: boolean;
  spine: boolean;
};

const banks = new WeakMap<ClipSet, PoseBank>();
function poseBank(clips: ClipSet): PoseBank | undefined {
  const existing = banks.get(clips);
  if (existing) return existing;
  const bank: PoseBank = { bindings: [], curves: new Map() };
  const indices = new Map<string, number>();
  for (const [role, { clip }] of clips) {
    const curves: Curve[] = [];
    const names = new Set<string>();
    for (const track of clip.tracks) {
      let channel = indices.get(track.name);
      if (channel === undefined) {
        const match = /^([^\.]+)\.(position|quaternion)$/.exec(track.name);
        if (!match) return;
        channel = bank.bindings.length;
        bank.bindings.push({
          bone: match[1],
          property: match[2] === 'position' ? 'position' : 'quaternion',
        });
        indices.set(track.name, channel);
      }
      const position = bank.bindings[channel].property === 'position';
      if (
        names.has(track.name) ||
        track.getInterpolation() !== InterpolateLinear ||
        track.getValueSize() !== (position ? 3 : 4) ||
        track.times.length > 2048 ||
        !track.validate()
      )
        return;
      names.add(track.name);
      // Sampling immediately copies the result into a player's pose. Only the
      // search cursor and scratch result are shared; each time is absolute.
      const interpolant =
        track.times.length === 1
          ? null
          : position
            ? new LinearInterpolant(track.times, track.values, 3)
            : new QuaternionLinearInterpolant(track.times, track.values, 4);
      curves.push({ channel, values: track.values, interpolant });
    }
    bank.curves.set(role, curves);
  }
  banks.set(clips, bank);
  return bank;
}

function rigAim(root: Object3D, bones: Map<string, Bone>) {
  const spine = ['spine_0', 'spine_1', 'spine_2', 'spine_3'].map((name) => bones.get(name));
  const chest = spine[3],
    carried = bones.get('wpnPivot');
  if (!chest || !carried?.parent || spine.some((joint) => !joint)) return;
  const before = new Matrix4(),
    weapon = new Matrix4(),
    delta = new Matrix4();
  const axis = new Vector3(),
    localAxis = new Vector3(),
    carriedScale = new Vector3(),
    worldRotation = new Quaternion();
  const weights = [0.12, 0.18, 0.28, 0.42];
  const up = new Vector3();
  /** Pitch bends and yaw twist (the aim beyond the feet' yaw) spread over the spine. */
  return (pitch: number, twist = 0) => {
    const angle = MathUtils.degToRad(MathUtils.clamp(shortestAngle(0, pitch), -70, 70));
    const turn = MathUtils.degToRad(MathUtils.clamp(twist, -70, 70));
    if (!angle && !turn) return;
    chest.updateWorldMatrix(true, false);
    before.copy(chest.matrixWorld).invert();
    carried.updateWorldMatrix(true, false);
    weapon.copy(carried.matrixWorld);
    // The four spine bends share the rig's lateral axis. Everything descended
    // from the upper spine keeps its rigid transform, including both hands.
    root.getWorldQuaternion(worldRotation);
    up.set(0, 1, 0).applyQuaternion(worldRotation);
    // The lateral axis follows the twisted chest, so pitch stays a forward bend.
    axis.set(1, 0, 0).applyQuaternion(worldRotation).applyAxisAngle(up, turn);
    for (const [index, joint] of spine.entries()) {
      joint!.getWorldQuaternion(worldRotation).invert();
      if (turn)
        joint!.rotateOnAxis(
          localAxis.copy(up).applyQuaternion(worldRotation),
          turn * weights[index],
        );
      joint!.getWorldQuaternion(worldRotation).invert();
      if (angle)
        joint!.rotateOnAxis(
          localAxis.copy(axis).applyQuaternion(worldRotation),
          angle * weights[index],
        );
    }
    chest.updateWorldMatrix(true, false);
    delta.multiplyMatrices(chest.matrixWorld, before);
    // Valve's weapon pivot hangs off root_motion, beside the torso hierarchy.
    carried.matrix.copy(carried.parent!.matrixWorld).invert().multiply(delta).multiply(weapon);
    carried.matrix.decompose(carried.position, carried.quaternion, carriedScale);
  };
}

export function createDirectionalAgent(root: Object3D, clips: ClipSet, actions?: AgentActions) {
  const bank = poseBank(clips);
  if (!bank) return;
  const bones = new Map<string, Bone>();
  root.traverse((node) => {
    if (node instanceof Bone) bones.set(node.name, node);
  });
  const aim = rigAim(root, bones);
  const grip = actions ? createGripRig(root) : undefined;
  const upperBones = new Set<Object3D>();
  for (const name of ['spine_0', 'wpnPivot'])
    bones.get(name)?.traverse((node) => upperBones.add(node));
  const lowerOnly = (bone: Bone) => (upperBones.has(bone) ? 0 : 1);
  const notPelvis = (bone: Bone) => bone.name === 'pelvis';
  const upper = new Set<Object3D>();
  for (const name of ['spine_0', 'wpnPivot']) bones.get(name)?.traverse((node) => upper.add(node));
  const channels = new Map<string, Channel>();
  function channelFor(bone: Bone, property: BoneChannel['property']) {
    const name = bone.name + '.' + property;
    const existing = channels.get(name);
    if (existing) return existing;
    const target = bone[property];
    const channel = {
      target,
      rest: target.clone(),
      value: target.clone(),
      weight: 0,
      masked: upper.has(bone),
      spine: bone.name.startsWith('spine_'),
    };
    channels.set(name, channel);
    return channel;
  }
  const bound: Channel[] = [];
  for (const { bone: name, property } of bank.bindings) {
    const bone = bones.get(name);
    if (!bone) return;
    bound.push(channelFor(bone, property));
  }
  const curves = bank.curves;
  // A sparse rig can omit an authored key for an aimed joint. Its rest
  // rotation must still be restored before another absolute pose sample.
  if (aim) {
    for (const name of ['spine_0', 'spine_1', 'spine_2', 'spine_3', 'wpnPivot'])
      channelFor(bones.get(name)!, 'quaternion');
    channelFor(bones.get('wpnPivot')!, 'position');
  }
  // Action layers and hand IK write joints the locomotion bank may leave untouched;
  // each sample must start again from rest for seek-deterministic poses.
  if (actions)
    for (const bone of bones.values()) {
      channelFor(bone, 'quaternion');
      if (['root_motion', 'pelvis', 'wpnPivot', 'wpn'].includes(bone.name))
        channelFor(bone, 'position');
    }
  for (const side of ['L', 'R'])
    for (const prefix of ['leg_upper_', 'leg_lower_', 'ankle_']) {
      const joint = bones.get(prefix + side);
      if (joint) channelFor(joint, 'quaternion');
    }
  const vector = new Vector3(),
    rotation = new Quaternion();
  const deathRoles = contract.deaths as AgentDeath[];
  function mix(target: Vector3 | Quaternion, data: ArrayLike<number>, amount: number) {
    if (target instanceof Quaternion) target.slerp(rotation.fromArray(data).normalize(), amount);
    else target.lerp(vector.fromArray(data), amount);
  }
  function accumulate(role: DirectionalAgentRole, time: number, weight: number) {
    for (const curve of curves.get(role)!) {
      const channel = bound[curve.channel];
      const data = curve.interpolant ? curve.interpolant.evaluate(time) : curve.values;
      channel.weight += weight;
      mix(channel.value, data, weight / channel.weight);
    }
  }
  function overlay(role: DirectionalAgentRole, time: number, weight: number, spineWeight = 1) {
    for (const curve of curves.get(role)!) {
      const channel = bound[curve.channel];
      if (channel.masked)
        mix(
          channel.target,
          curve.interpolant ? curve.interpolant.evaluate(time) : curve.values,
          channel.spine ? weight * spineWeight : weight,
        );
    }
  }

  function carryClass(weapon: string) {
    const key = canonicalEquipmentKey(weapon);
    if (key === 'elite') return 'dual';
    if (
      Object.hasOwn(equipment.items, key) &&
      equipment.items[key as keyof typeof equipment.items].kind === 'grenade'
    )
      return 'grenade';
  }

  function carryPose(weapon: string, duck: number, weight: number) {
    if (!weight) return;
    if (canonicalEquipmentKey(weapon) === 'c4') overlay('c4-carry', 0, weight, 0.2);
    const variant = carryClass(weapon);
    if (!variant) return;
    overlay(`${variant}-idle`, 0, weight);
    overlay(`${variant}-crouch-idle`, 0, weight * clamp(duck));
  }

  function accumulateGait(
    gait: ReturnType<typeof directionalGait>,
    seconds: number,
    blend: number,
  ) {
    if (!blend) return;
    for (const { role, weight } of gait.samples) {
      const { clip, metadata } = clips.get(role)!;
      const phase =
        metadata.phaseOffset === undefined
          ? cycle(seconds / clip.duration)
          : cycle((gait.phase ?? seconds / clip.duration) + metadata.phaseOffset);
      accumulate(role, phase * clip.duration, weight * blend);
    }
  }
  let lastDeath: { role: string; time: number } | undefined;
  const classIdle = { rifle: 'm4a1', pistol: 'glock' } as Record<string, string>;
  const bankWeapon = (weapon: string) => {
    const key = canonicalEquipmentKey(weapon);
    return actions?.has(`weapon:${key}:idle`) ? key : undefined;
  };
  /** Valve's per-weapon carry pose, as a difference from the class's default weapon, so
   * locomotion keeps its torso motion while the arms take this weapon's grip. */
  function weaponCarry(weapon: string, duck: number, weight: number) {
    const key = bankWeapon(weapon),
      kind = agentWeaponClass(weapon);
    const base = classIdle[kind];
    if (!actions || !key || !base || !(weight > 0) || key === base) return;
    const crouch = clamp(duck);
    if (crouch < 1)
      actions.delta(
        `weapon:${key}:idle`,
        0,
        weight * (1 - crouch),
        { role: `weapon:${base}:idle`, time: 0 },
        notPelvis,
      );
    if (crouch > 0)
      actions.delta(
        `weapon:${key}:crouch-idle`,
        0,
        weight * crouch,
        { role: `weapon:${base}:crouch-idle`, time: 0 },
        notPelvis,
      );
  }
  /** Both hands return to this weapon's authored grip after every other layer. */
  function holdWeapon(weapon: string, amount: number) {
    const key = bankWeapon(weapon);
    if (!grip || !actions || !key || !(amount > 0)) return;
    const offsets = grip.offsets(key, (hand, target) =>
      actions.relative(`weapon:${key}:idle`, 0, hand, 'wpn', target),
    );
    if (offsets) grip.apply(offsets, amount, amount);
  }
  return {
    sample(
      seconds: number,
      speed: number,
      duck: number,
      phase: number | undefined,
      input: DirectionalSample,
    ) {
      const death = input.death;
      const bankDeath =
        death?.role && actions?.has(death.role) ? (death.role as string) : undefined;
      const deathRole = bankDeath ?? (death && deathRoles[death.variant % deathRoles.length]);
      const deathDuration = !deathRole
        ? 0
        : bankDeath
          ? actions!.duration(bankDeath)!
          : clips.get(deathRole as AgentDeath)!.clip.duration;
      const deathTime = death && deathRole ? Math.min(death.age, deathDuration) : undefined;
      if (deathRole && lastDeath?.role === deathRole && lastDeath.time === deathTime)
        return deathTime;
      lastDeath =
        deathRole && deathTime !== undefined ? { role: deathRole, time: deathTime } : undefined;
      for (const channel of channels.values()) channel.weight = 0;
      const base = deathRole ? undefined : directionalGait(clips, input, speed, duck, phase);
      const previousWeapon =
        input.action?.kind === 'draw' ? input.action.previousWeapon : undefined;
      const blend = previousWeapon ? smooth(input.action!.age / 0.12) : 1;
      if (deathRole && deathTime !== undefined && !bankDeath) {
        accumulate(deathRole as AgentDeath, deathTime, 1);
      } else if (base) {
        if (previousWeapon && blend < 1) {
          const prior = directionalGait(
            clips,
            { ...input, weapon: previousWeapon },
            speed,
            duck,
            phase,
          );
          accumulateGait(prior, seconds, 1 - blend);
        }
        accumulateGait(base, seconds, blend);
      }
      for (const { target, rest, value, weight } of channels.values()) {
        if (target instanceof Quaternion)
          target.copy(rest as Quaternion).slerp(value as Quaternion, Math.min(weight, 1));
        else target.copy(rest as Vector3).lerp(value as Vector3, Math.min(weight, 1));
      }
      if (bankDeath && deathTime !== undefined) {
        actions!.pose(bankDeath, deathTime, 1);
        return deathTime;
      }
      let hands = 0;
      if (base) {
        const kind = base.weapon;
        // Airborne and ladder layers own the legs; the upper body keeps its weapon pose.
        const ladder = input.ladder;
        const ladderRole = ladder && `ladder${Math.abs(ladder.speed) > 2.2 ? '-fast' : ''}:${kind}`;
        const climb = ladderRole && actions?.climbMeters(ladderRole);
        if (ladder && ladderRole && climb) {
          const duration = actions!.duration(ladderRole)!;
          actions!.pose(ladderRole, cycle(ladder.climbed / climb) * duration, lowerOnly);
        } else if (input.air && actions) {
          const { weight, jumpAge, landAge } = input.air;
          const airRole = `air${duck > 0.5 ? '-crouch' : ''}:${kind}`;
          if (weight > 0)
            actions.pose(
              airRole,
              cycle(seconds / actions.duration(airRole)!) * actions.duration(airRole)!,
              (bone) => weight * lowerOnly(bone),
            );
          if (jumpAge !== undefined && jumpAge < actions.duration(`jump-start:${kind}`)!)
            actions.delta(`jump-start:${kind}`, jumpAge, 1 - smooth(jumpAge / 0.6));
          if (landAge !== undefined && landAge < actions.duration(`jump-land:${kind}`)!)
            actions.delta(`jump-land:${kind}`, landAge, 1 - smooth((landAge - 0.3) / 0.33));
        } else if (input.turn && actions) {
          // The recorded stance already requires standing. Valve's 45 degree step: its root yaw
          // is the turn itself, which the recorded feet
          // already make, so only the legs play. The rotating half is driven by the angle turned
          // (through the clip's own ease) so the planted foot stays put; the settle plays on.
          const { side, turned, restAge } = input.turn;
          const role = `turn-${side}${duck > 0.5 ? '-crouch' : ''}:${kind}`;
          const duration = actions.duration(role);
          if (duration) {
            const fraction = turned >= 45 && turned % 45 < 1e-3 ? 1 : (turned % 45) / 45;
            const rotating = Math.min(duration, 0.667) * easedTime(fraction);
            const time = rotating + (restAge ?? 0);
            if (time < duration) {
              const weight = smooth(turned / 6) * smooth((duration - time) / 0.3);
              actions.pose(role, time, (bone) =>
                bone.name === 'root_motion' ? 0 : weight * lowerOnly(bone),
              );
            }
          }
        }
        const variant = carryClass(input.weapon);
        if (!variant) {
          if (previousWeapon) weaponCarry(previousWeapon, duck, 1 - blend);
          weaponCarry(input.weapon, duck, blend);
        }
        if (previousWeapon) carryPose(previousWeapon, duck, 1 - blend);
        carryPose(input.weapon, duck, blend);
        hands = variant || kind === 'knife' ? 0 : 1;
        if (input.defusing) {
          hands = 0;
          const role = `${base.weapon}-defuse` as const;
          const duration = clips.get(role)!.clip.duration;
          overlay(role, cycle(seconds / duration) * duration, 1);
        } else if (input.action) {
          const { kind: action, age } = input.action;
          const key = !variant ? bankWeapon(input.weapon) : undefined;
          const native =
            key && (action === 'fire' || action === 'reload' || action === 'draw')
              ? `weapon:${key}:${action}`
              : undefined;
          const role =
            native && actions!.has(native)
              ? native
              : (`${variant ?? base.weapon}-${action}` as DirectionalAgentRole);
          const duration =
            (role === native
              ? actions!.duration(role)
              : clips.get(role as DirectionalAgentRole)?.clip.duration) || 0;
          const apply = (time: number, weight: number, spineWeight = 1) =>
            role === native
              ? actions!.pose(role, time, (bone) =>
                  bone.name === 'pelvis'
                    ? 0
                    : bone.name.startsWith('spine_')
                      ? weight * spineWeight
                      : weight,
                )
              : overlay(role as DirectionalAgentRole, time, weight, spineWeight);
          if (age >= 0 && age < duration) {
            // Complete the entry by the next recorded shot even in a tight burst.
            const entry = Math.min(0.06, duration / 4, input.action.nextFireInterval ?? Infinity);
            const tail = Math.min(0.12, duration / 4);
            const incoming = smooth(age / entry);
            const envelope = incoming * smooth((duration - age) / tail);
            const prior = input.action.priorFireAge;
            if (action === 'fire' && incoming < 1 && prior !== undefined && prior < duration) {
              // The new shot blends from the outgoing authored pose. Both
              // samples use the same replay instant even after a backward seek.
              apply(prior, smooth((duration - prior) / tail));
            }
            const throwing = action === 'throw' || action === 'throw-underhand';
            const running = throwing ? smooth((speed - 2.5) / 2) : 0;
            const release = action === 'throw-underhand' ? 13 / 30 : 0.5;
            const windup = 1 - smooth((age - release + 0.16) / 0.12);
            apply(age, envelope * (1 - 0.32 * running * windup), 1 - 0.6 * running);
            // Reload and draw take the support hand off the weapon by authorship.
            if (action !== 'fire') hands *= 1 - envelope;
          }
        }
        if (input.flinch && actions?.has(input.flinch.role)) {
          const duration = actions.duration(input.flinch.role)!;
          const { age } = input.flinch;
          if (age >= 0 && age < duration)
            actions.delta(
              input.flinch.role,
              age,
              smooth(age / 0.04) * smooth((duration - age) / 0.2),
            );
        }
      }
      if (!death) aim?.(input.pitch, input.twist ?? 0);
      if (base && hands > 0) holdWeapon(input.weapon, hands);
      return deathTime;
    },
  };
}
