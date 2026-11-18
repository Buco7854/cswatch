import { equipmentIconKey } from './equipment-icons';

const exactClasses: Readonly<Record<string, string>> = {
  CFlashbangProjectile: 'flashbang',
  CHEGrenadeProjectile: 'hegrenade',
  CSmokeGrenadeProjectile: 'smokegrenade',
  CDecoyProjectile: 'decoy',
  // CMolotovProjectile intentionally stays unknown: that class also carries incendiaries.
};
const utilities = new Set([
  'flashbang',
  'hegrenade',
  'smokegrenade',
  'molotov',
  'incgrenade',
  'decoy',
]);
/** Exact native class or canonical equipment identity only, never fuzzy names or positions. */
export function projectileEquipment(kind: string): string | undefined {
  if (Object.hasOwn(exactClasses, kind)) return exactClasses[kind];
  const key = equipmentIconKey(kind);
  return key && utilities.has(key) ? key : undefined;
}
