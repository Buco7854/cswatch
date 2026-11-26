import contract from './agent-actions.json' with { type: 'json' };

/** Roles of the shared native action bank. `upper` clips replace the upper body
 * (spine, arms and the weapon pivot) of the locomotion pose; `full` clips own the
 * whole skeleton; `delta` clips apply their change from the first frame on top of
 * the current pose (Valve authors them as additive layers). */
const roles = new Map();
for (const [weapon, [, , , shoot]] of Object.entries(contract.weapons))
  for (const action of contract.weaponActions)
    if (!(weapon === 'taser' && action === 'reload') && shoot)
      roles.set(`weapon:${weapon}:${action}`, 'upper');
for (const kind of contract.classes) {
  roles.set(`air:${kind}`, 'full');
  roles.set(`air-crouch:${kind}`, 'full');
  roles.set(`jump-start:${kind}`, 'delta');
  roles.set(`jump-land:${kind}`, 'delta');
  roles.set(`ladder:${kind}`, 'full');
  roles.set(`ladder-fast:${kind}`, 'full');
}
for (const part of contract.flinches) roles.set(`flinch:${part}`, 'delta');
for (const death of contract.deaths) roles.set(`death:${death}`, 'full');
roles.set('c4:plant', 'upper');
roles.set('c4:plant-crouch', 'upper');

export const agentActionRoles = Object.freeze([...roles.keys()]);
export const agentActionKind = (role) => roles.get(role);
export const agentActionContract = contract;

/** Validate a complete declaration set before selection or publication. */
export function agentActionDeclarations(animations) {
  if (!Array.isArray(animations) || animations.length !== agentActionRoles.length) return;
  const entries = new Map();
  for (const animation of animations) {
    const meta = animation?.extras?.cswatch;
    if (
      meta?.kind !== 'native-agent-action' ||
      meta.schemaVersion !== contract.schemaVersion ||
      typeof meta.role !== 'string' ||
      !roles.has(meta.role) ||
      meta.blend !== roles.get(meta.role) ||
      animation.name !== 'cswatch:' + meta.role ||
      (meta.role.startsWith('ladder') &&
        !(
          typeof meta.climbMeters === 'number' &&
          meta.climbMeters >= 0.2 &&
          meta.climbMeters <= 4
        )) ||
      entries.has(meta.role)
    )
      return;
    entries.set(meta.role, meta);
  }
  if (entries.size === agentActionRoles.length) return entries;
}
