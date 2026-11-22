import type { DirectionalAgentMetadata, DirectionalAgentRole } from './agent-animation.js';
export const directionalMovementRoles: ReadonlySet<DirectionalAgentRole>;
export const directionalRoles: readonly DirectionalAgentRole[];
export function validDirectionalRoles(roles: readonly string[]): boolean;
export function directionalDeclarations(
  animations: unknown,
): Map<DirectionalAgentRole, DirectionalAgentMetadata> | undefined;
