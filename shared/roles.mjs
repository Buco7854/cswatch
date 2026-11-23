export const roles = Object.freeze(['member', 'admin']);

const permissions = Object.freeze({ member: Object.freeze([]), admin: Object.freeze(['admin']) });

export function hasPermission(role, permission) {
  return roles.includes(role) && permissions[role].includes(permission);
}
