import { equipmentLabel } from './equipment-labels';
import { equipmentKey } from './equipment-key';
export { equipmentKey } from './equipment-key';

export type EquipmentKind =
  | 'ak'
  | 'rifle'
  | 'sniper'
  | 'smg'
  | 'pistol'
  | 'shotgun'
  | 'machinegun'
  | 'knife'
  | 'taser'
  | 'bomb'
  | 'flash'
  | 'smoke'
  | 'he'
  | 'molotov'
  | 'incendiary'
  | 'decoy'
  | 'armor'
  | 'helmet'
  | 'defuser'
  | 'unknown';
const labels: Record<string, string> = {
  ak47: 'AK-47',
  m4a4: 'M4A4',
  m4a1silencer: 'M4A1-S',
  m4a1silenceroff: 'M4A1-S',
  m4a1s: 'M4A1-S',
  awp: 'AWP',
  ssg08: 'SSG 08',
  scar20: 'SCAR-20',
  g3sg1: 'G3SG1',
  aug: 'AUG',
  sg556: 'SG 553',
  sg553: 'SG 553',
  famas: 'FAMAS',
  galilar: 'Galil AR',
  galil: 'Galil AR',
  mp9: 'MP9',
  mac10: 'MAC-10',
  mp7: 'MP7',
  mp5sd: 'MP5-SD',
  ump45: 'UMP-45',
  bizon: 'PP-Bizon',
  ppbizon: 'PP-Bizon',
  p90: 'P90',
  glock: 'Glock-18',
  glock18: 'Glock-18',
  hkp2000: 'P2000',
  p2000: 'P2000',
  uspsilencer: 'USP-S',
  uspsilenceroff: 'USP-S',
  usps: 'USP-S',
  p250: 'P250',
  fiveseven: 'Five-SeveN',
  tec9: 'Tec-9',
  cz75a: 'CZ75-Auto',
  cz75auto: 'CZ75-Auto',
  deagle: 'Desert Eagle',
  deserteagle: 'Desert Eagle',
  revolver: 'R8 Revolver',
  elite: 'Dual Berettas',
  dualberettas: 'Dual Berettas',
  nova: 'Nova',
  xm1014: 'XM1014',
  sawedoff: 'Sawed-Off',
  mag7: 'MAG-7',
  negev: 'Negev',
  m249: 'M249',
  c4: 'C4',
};
const kinds: Record<string, EquipmentKind> = {
  ak47: 'ak',
  m4a1: 'rifle',
  m4a4: 'rifle',
  m4a1silencer: 'rifle',
  m4a1silenceroff: 'rifle',
  m4a1s: 'rifle',
  aug: 'rifle',
  sg556: 'rifle',
  sg553: 'rifle',
  famas: 'rifle',
  galilar: 'rifle',
  galil: 'rifle',
  awp: 'sniper',
  ssg08: 'sniper',
  scar20: 'sniper',
  g3sg1: 'sniper',
  mp9: 'smg',
  mac10: 'smg',
  mp7: 'smg',
  mp5sd: 'smg',
  ump45: 'smg',
  bizon: 'smg',
  ppbizon: 'smg',
  p90: 'smg',
  glock: 'pistol',
  glock18: 'pistol',
  hkp2000: 'pistol',
  p2000: 'pistol',
  uspsilencer: 'pistol',
  uspsilenceroff: 'pistol',
  usps: 'pistol',
  p250: 'pistol',
  fiveseven: 'pistol',
  tec9: 'pistol',
  cz75a: 'pistol',
  cz75auto: 'pistol',
  deagle: 'pistol',
  deserteagle: 'pistol',
  revolver: 'pistol',
  elite: 'pistol',
  dualberettas: 'pistol',
  nova: 'shotgun',
  xm1014: 'shotgun',
  sawedoff: 'shotgun',
  mag7: 'shotgun',
  negev: 'machinegun',
  m249: 'machinegun',
  c4: 'bomb',
  plantedc4: 'bomb',
  taser: 'taser',
  zeus: 'taser',
  zeusx27: 'taser',
  smokegrenade: 'smoke',
  flashbang: 'flash',
  hegrenade: 'he',
  molotov: 'molotov',
  incgrenade: 'incendiary',
  incendiarygrenade: 'incendiary',
  decoy: 'decoy',
  decoygrenade: 'decoy',
  armor: 'armor',
  armorhelmet: 'armor',
  helmet: 'helmet',
  defuser: 'defuser',
  defusekit: 'defuser',
};
export function equipmentKind(value: string): EquipmentKind {
  const key = equipmentKey(value);
  return key.startsWith('knife') || key === 'bayonet' ? 'knife' : kinds[key] || 'unknown';
}
export function equipmentName(value: string) {
  // Preserve an already recorded display name. Only the engine entity key is mapped to M4A4.
  if (/^weapon_m4a1$/i.test(value)) return 'M4A4';
  return labels[equipmentKey(value)] || equipmentLabel(value);
}
export const utilityKinds: readonly EquipmentKind[] = [
  'he',
  'flash',
  'smoke',
  'molotov',
  'incendiary',
  'decoy',
];

/** Count the raw inventory, not localized labels. Two flashes remain two flashes in every locale. */
export function utilityInventory(inventory: readonly string[] | undefined) {
  if (inventory === undefined) return null;
  const grouped = new Map<EquipmentKind, { kind: EquipmentKind; item: string; count: number }>();
  for (const item of inventory) {
    const kind = equipmentKind(item);
    if (!utilityKinds.includes(kind)) continue;
    const current = grouped.get(kind);
    if (current) current.count++;
    else grouped.set(kind, { kind, item, count: 1 });
  }
  return utilityKinds.flatMap((kind) => (grouped.has(kind) ? [grouped.get(kind)!] : []));
}
