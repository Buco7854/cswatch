import contract from './agent-animation.json' with { type: 'json' };

export const directionalClassRoles = (weapon) => [
  `${weapon}-idle`,
  `${weapon}-crouch-idle`,
  ...contract.gaits.flatMap((gait) =>
    contract.directions.map((direction) => `${weapon}-${gait}-${direction}`),
  ),
];
export const directionalMovementRoles = new Set(
  contract.weaponClasses.flatMap((weapon) => directionalClassRoles(weapon).slice(2)),
);
export const directionalRoles = Object.freeze([
  ...contract.weaponClasses.flatMap((weapon) => [
    ...directionalClassRoles(weapon),
    ...contract.actions
      .filter((action) => weapon !== 'knife' || action === 'draw')
      .map((action) => `${weapon}-${action}`),
  ]),
  ...contract.deaths,
]);
const known = new Set(directionalRoles);

/** Rifle is required; optional classes have whole locomotion sets. Actions are optional. */
export function validDirectionalRoles(roles) {
  const present = new Set(roles);
  if (present.size !== roles.length || roles.some((role) => !known.has(role))) return false;
  return contract.weaponClasses.every((weapon) => {
    if (weapon !== 'rifle' && !roles.some((role) => role.startsWith(weapon + '-'))) return true;
    return directionalClassRoles(weapon).every((role) => present.has(role));
  });
}
