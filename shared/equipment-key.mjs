/** Stable engine/display-key normalization, independent of locale and rendering. */
export const equipmentKey = (value) =>
  value
    .replace(/^weapon_/i, '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase();

const aliases = {
  m4a4: 'm4a1',
  m4a1s: 'm4a1silencer',
  p2000: 'hkp2000',
  usps: 'uspsilencer',
  glock18: 'glock',
  sg553: 'sg556',
  galil: 'galilar',
  ppbizon: 'bizon',
  cz75auto: 'cz75a',
  deserteagle: 'deagle',
  dualberettas: 'elite',
  r8revolver: 'revolver',
  zeus: 'taser',
  zeusx27: 'taser',
  incendiarygrenade: 'incgrenade',
  decoygrenade: 'decoy',
  defusekit: 'defuser',
  c4explosive: 'c4',
  highexplosivegrenade: 'hegrenade',
  kevlar: 'armor',
  bowieknife: 'knifesurvivalbowie',
  butterflyknife: 'knifebutterfly',
  classicknife: 'knifecss',
  falchionknife: 'knifefalchion',
  flipknife: 'knifeflip',
  gutknife: 'knifegut',
  huntsmanknife: 'knifetactical',
  m9bayonet: 'knifem9bayonet',
  karambit: 'knifekarambit',
  kukriknife: 'knifekukri',
  navajaknife: 'knifegypsyjackknife',
  nomadknife: 'knifeoutdoor',
  paracordknife: 'knifecord',
  shadowdaggers: 'knifepush',
  skeletonknife: 'knifeskeleton',
  stilettoknife: 'knifestiletto',
  survivalknife: 'knifecanis',
  talonknife: 'knifewidowmaker',
  ursusknife: 'knifeursus',
};

/** Exact recorded display aliases, shared by artwork, shape and model lookup. */
export function canonicalEquipmentKey(value) {
  const key = equipmentKey(value);
  return Object.hasOwn(aliases, key) ? aliases[key] : key;
}
