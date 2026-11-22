import { t } from './i18n';

const utilityNames: Record<string, string> = {
  smokegrenade: 'Smoke grenade',
  flashbang: 'Flashbang',
  hegrenade: 'HE grenade',
  molotov: 'Molotov',
  incgrenade: 'Incendiary grenade',
  incendiarygrenade: 'Incendiary grenade',
  decoy: 'Decoy grenade',
  decoygrenade: 'Decoy grenade',
};
export function equipmentLabel(value: string) {
  const name = value.replace(/^weapon_/, '').replaceAll('_', ' ');
  const key = name.replace(/[\s-]/g, '').toLowerCase();
  return utilityNames[key] ? t(utilityNames[key]) : name;
}
