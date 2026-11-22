import type { AgentWeaponClass, DirectionalAgentRole } from './agent-animation.js';
export function directionalClassRoles(weapon: AgentWeaponClass): DirectionalAgentRole[];
export const directionalMovementRoles: ReadonlySet<DirectionalAgentRole>;
export const directionalRoles: readonly DirectionalAgentRole[];
export function validDirectionalRoles(roles: readonly string[]): boolean;
