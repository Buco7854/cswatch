export const roles: readonly ['member', 'admin'];
export type Role = (typeof roles)[number];
export function hasPermission(role: Role | null | undefined, permission: 'admin'): boolean;
