import type { AnimationAction, AnimationClip, AnimationMixer } from 'three';
import { genericAgentClip } from './agent-model';
import { locomotionWeights, nativeAgentRoles, nativeClipIndices } from './agent-locomotion';

/** Native cycles are sampled from demo time with normalized analytical weights.
 * There are no wall-clock fades, native AnimGraph claims or accumulated mixer deltas. */
export function agentAnimation(
  mixer: AnimationMixer,
  clips: readonly AnimationClip[],
  declarations: unknown,
) {
  const native = nativeClipIndices(clips, declarations);
  const cycles = native
    ? nativeAgentRoles.map((role) => ({
        role,
        clip: clips[native[role]],
      }))
    : [];
  const actions = new Map<AnimationClip, AnimationAction>();
  let previous: [number, number, number, number | undefined] | undefined;
  let legacy: AnimationAction | undefined;
  const actionFor = (clip: AnimationClip) => {
    let action = actions.get(clip);
    if (!action) {
      action = mixer.clipAction(clip).play();
      actions.set(clip, action);
    }
    return action;
  };
  return {
    native: Boolean(native),
    sample(time: number, speed: number, duck: number, travelMeters?: number) {
      const seconds = Number.isFinite(time) ? Math.max(0, time) : 0;
      if (
        previous?.[0] === seconds &&
        previous[1] === speed &&
        previous[2] === duck &&
        previous[3] === travelMeters
      )
        return;
      previous = [seconds, speed, duck, travelMeters];
      if (native) {
        const weights = locomotionWeights(speed, duck);
        // Moving clips use the same normalized step phase even when their
        // authored durations differ. Idle loops retain their own timing.
        const period = clips[native.walk].duration;
        const steps = travelMeters === undefined ? seconds / period : travelMeters / 3.1;
        const phase = steps % 1;
        for (const { role, clip } of cycles) {
          const action = actionFor(clip);
          action.time = role.endsWith('idle') ? seconds % clip.duration : phase * clip.duration;
          action.setEffectiveWeight(weights[role]);
        }
        mixer.update(0);
      } else {
        const clip = genericAgentClip(clips, speed > 0.05, duck > 0.5);
        if (clip) {
          if (legacy?.getClip() !== clip) mixer.stopAllAction();
          legacy = mixer.clipAction(clip).play();
        }
        mixer.setTime(seconds);
      }
    },
    stop() {
      mixer.stopAllAction();
      actions.clear();
      previous = undefined;
      legacy = undefined;
    },
  };
}
