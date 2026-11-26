import type { Object3D } from 'three';

/** Posed agent instances by player ID (`death:ID` for bodies), for effects placed on bodies. */
const roots = new Map<string, Object3D>();
export function registerAgentRoot(id: string, root: Object3D) {
  roots.set(id, root);
  return () => {
    if (roots.get(id) === root) roots.delete(id);
  };
}
export const agentRoot = (id: string) => roots.get(id);
