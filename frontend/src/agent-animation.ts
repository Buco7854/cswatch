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
  const actions = native
    ? nativeAgentRoles.map((role) => ({
        role,
        action: mixer.clipAction(clips[native[role]]).play(),
      }))
    : [];
  let legacy: AnimationAction | undefined;
  return {
    native: Boolean(native),
    sample(time: number, speed: number, duck: number) {
      const seconds = Number.isFinite(time) ? Math.max(0, time) : 0;
      if (native) {
        const weights = locomotionWeights(speed, duck);
        for (const { role, action } of actions) action.setEffectiveWeight(weights[role]);
      } else {
        const clip = genericAgentClip(clips, speed > 0.05, duck > 0.5);
        if (clip && legacy?.getClip() !== clip) {
          mixer.stopAllAction();
          legacy = mixer.clipAction(clip).play();
        }
      }
      mixer.setTime(seconds);
    },
    stop() {
      mixer.stopAllAction();
    },
  };
}
