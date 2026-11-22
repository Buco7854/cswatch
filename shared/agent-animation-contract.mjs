import contract from './agent-animation.json' with { type: 'json' };

const directionalClassRoles = (weapon) => [
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
export function validDirectionalRoles(roles) {
  const present = new Set(roles);
  return (
    roles.length === directionalRoles.length && directionalRoles.every((role) => present.has(role))
  );
}

/** Validate the complete GLB declaration set before selection or publication. */
export function directionalDeclarations(animations) {
  if (!Array.isArray(animations) || animations.length !== directionalRoles.length) return;
  const entries = new Map();
  for (const animation of animations) {
    const meta = animation?.extras?.cswatch;
    if (
      meta?.kind !== 'native-agent' ||
      meta.schemaVersion !== contract.schemaVersion ||
      meta.rootMotion !== 'recorded-position' ||
      typeof meta.role !== 'string' ||
      animation.name !== 'cswatch:' + meta.role ||
      entries.has(meta.role) ||
      (directionalMovementRoles.has(meta.role) &&
        (typeof meta.strideMeters !== 'number' ||
          !(meta.strideMeters >= 0.1 && meta.strideMeters <= contract.limits.maxStrideMeters) ||
          typeof meta.phaseOffset !== 'number' ||
          !(meta.phaseOffset >= 0 && meta.phaseOffset < 1)))
    )
      return;
    entries.set(meta.role, meta);
  }
  if (validDirectionalRoles([...entries.keys()])) return entries;
}
