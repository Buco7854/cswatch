import type { Object3D } from 'three';

/** Verification builds (`VITE_CSWATCH_CAPTURE=1`) expose a deterministic camera,
 * tick and pose probe to local capture harnesses. Release builds compile it out. */
declare global {
  interface ImportMeta {
    readonly env: Record<string, string | undefined>;
  }
}
export const captureEnabled = import.meta.env.VITE_CSWATCH_CAPTURE === '1';

type CaptureState = {
  agents: Map<string, Object3D>;
  scene?: unknown;
  replayFrames?: { tick: number };
};
const state: CaptureState = { agents: new Map() };

export function captureRegister(patch: Record<string, unknown>) {
  if (!captureEnabled) return;
  Object.assign(state, patch);
  (globalThis as { __cswatchCapture?: CaptureState }).__cswatchCapture = state;
}

export function captureAgent(id: string, root: Object3D) {
  if (!captureEnabled) return;
  state.agents.set(id, root);
  captureRegister({});
  return () => {
    if (state.agents.get(id) === root) state.agents.delete(id);
  };
}
