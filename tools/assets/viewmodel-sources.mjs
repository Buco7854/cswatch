import { equipmentModelRegistry } from './equipment-model-registry.mjs';

const arms = 'weapons/models/shared/arms/weapon_arms.vmdl_c';
const root = 'animation/anims/viewmodel/';
// The official M4A1-S and USP graphs use the default rifle and pistol clips.
// Each rig uses the mesh of the exact inventory item.
const clips = {
  ak47: [
    'rifle/rifle_ak',
    { idle: 'idle_ak', draw: 'draw_ak', fire: 'shoot1_ak', reload: 'reload_ak' },
  ],
  aug: [
    'rifle/rifle_aug',
    { idle: 'idle_aug', draw: 'draw_aug', fire: 'shoot1_aug', reload: 'reload_aug' },
  ],
  awp: [
    'rifle/rifle_awp',
    { idle: 'idle_awp', draw: 'draw_awp', fire: 'shoot1_awp', reload: 'reload_awp' },
  ],
  bizon: [
    'rifle/rifle_bizon',
    { idle: 'idle_bizon', draw: 'draw_bizon', fire: 'shoot1_bizon', reload: 'reload_bizon' },
  ],
  cz75a: [
    'pistol/pistol_cz75a',
    { idle: 'idle_cz75a', draw: 'draw_cz75a', fire: 'shoot1_cz75a', reload: 'reload_cz75a' },
  ],
  deagle: [
    'pistol/pistol_deagle',
    { idle: 'idle_deagle', draw: 'draw_deagle', fire: 'shoot1_deagle', reload: 'reload_deagle' },
  ],
  elite: [
    'pistol/pistol_elite',
    { idle: 'idle_elite', draw: 'draw_elite', reload: 'reload_elite', fire: 'shoot_right1_elite' },
  ],
  famas: [
    'rifle/rifle_famas',
    { idle: 'idle_famas', draw: 'draw_famas', fire: 'shoot1_famas', reload: 'reload_famas' },
  ],
  fiveseven: [
    'pistol/pistol_fiveseven',
    {
      idle: 'idle_fiveseven',
      draw: 'draw_fiveseven',
      fire: 'shoot1_fiveseven',
      reload: 'reload_fiveseven',
    },
  ],
  g3sg1: [
    'rifle/rifle_g3sg1',
    { idle: 'idle1_g3sg1', draw: 'draw_g3sg1', fire: 'shoot1_g3sg1', reload: 'reload_g3sg1' },
  ],
  galilar: [
    'rifle/rifle_galilar',
    {
      idle: 'idle_galilar',
      draw: 'draw_galilar',
      fire: 'shoot1_galilar',
      reload: 'reload_galilar',
    },
  ],
  glock: [
    'pistol/pistol_glock18',
    { idle: 'idle_glock', draw: 'draw_glock', fire: 'shoot1_glock', reload: 'reload_glock' },
  ],
  hkp2000: [
    'pistol/pistol_hkp2000',
    { idle: 'idle_hkp', draw: 'draw_hkp', fire: 'shoot1_hkp', reload: 'reload_hkp' },
  ],
  m249: [
    'rifle/rifle_m249',
    { idle: 'idle1_m249', draw: 'draw_m249', fire: 'shoot1_m249', reload: 'reload_m249' },
  ],
  m4a1: [
    'rifle/rifle_m4a4',
    { idle: 'idle_m4a4', draw: 'draw_m4a4', fire: 'shoot1_m4a4', reload: 'reload_m4a4' },
  ],
  m4a1silencer: [
    'rifle/_default_rifle',
    {
      idle: 'idle_rifle',
      draw: 'draw_rifle',
      fire: 'shoot1_rifle',
      reload: 'reload_rifle',
      // Played when the recorded silencer state of the held weapon changes.
      silencerOn: 'silencer_attach_rifle',
      silencerOff: 'silencer_detach_rifle',
    },
  ],
  mac10: [
    'rifle/rifle_mac10',
    { idle: 'idle_mac10', draw: 'draw_mac10', fire: 'shoot1_mac10', reload: 'reload_mac10' },
  ],
  mag7: [
    'rifle/rifle_mag7',
    { idle: 'idle_mag7', draw: 'draw_mag7', fire: 'shoot1_mag7', reload: 'reload_mag7' },
  ],
  mp5sd: [
    'rifle/rifle_mp5sd',
    { idle: 'idle_mp5sd', draw: 'draw_mp5sd', fire: 'shoot1_mp5sd', reload: 'reload_mp5sd' },
  ],
  mp7: [
    'rifle/rifle_mp7',
    { idle: 'idle_mp7', draw: 'draw_mp7', fire: 'shoot1_mp7', reload: 'reload_mp7' },
  ],
  mp9: [
    'rifle/rifle_mp9',
    { idle: 'idle_mp9', draw: 'draw_mp9', fire: 'shoot1_mp9', reload: 'reload_mp9' },
  ],
  negev: [
    'rifle/rifle_negev',
    { idle: 'idle_negev', draw: 'draw_negev', fire: 'shoot1_negev', reload: 'reload_negev' },
  ],
  nova: [
    'rifle/rifle_nova',
    { idle: 'idle_nova', draw: 'draw_nova', fire: 'shoot1_nova', reload: 'reload_nova' },
  ],
  p250: [
    'pistol/pistol_p250',
    { idle: 'idle_p250', draw: 'draw_p250', fire: 'shoot1_p250', reload: 'reload_p250' },
  ],
  p90: [
    'rifle/rifle_p90',
    { idle: 'idle_p90', draw: 'draw_p90', fire: 'shoot1_p90', reload: 'reload_p90' },
  ],
  revolver: [
    'pistol/pistol_revolver',
    {
      idle: 'idle_revolver',
      draw: 'draw_revolver',
      fire: 'shoot1_revolver',
      reload: 'reload_revolver',
    },
  ],
  sawedoff: [
    'rifle/rifle_sawedoff',
    {
      idle: 'idle_sawedoff',
      draw: 'draw_sawedoff',
      fire: 'shoot1_sawedoff',
      reload: 'reload_sawedoff',
    },
  ],
  scar20: [
    'rifle/rifle_scar20',
    { idle: 'idle_scar20', draw: 'draw_scar20', fire: 'shoot1_scar20', reload: 'reload_scar20' },
  ],
  sg556: [
    'rifle/rifle_sg556',
    { idle: 'idle_sg556', draw: 'draw_sg556', fire: 'shoot1_sg556', reload: 'reload_sg556' },
  ],
  ssg08: [
    'rifle/rifle_ssg08',
    { idle: 'idle_ssg08', draw: 'draw_ssg08', fire: 'shoot1_ssg08', reload: 'reload_ssg08' },
  ],
  taser: ['pistol/pistol_taser', { idle: 'idle_taser', draw: 'draw_taser', fire: 'shoot1_taser' }],
  tec9: [
    'pistol/pistol_tec9',
    { idle: 'idle_tec9', draw: 'draw_tec9', fire: 'shoot1_tec9', reload: 'reload_tec9' },
  ],
  ump45: [
    'rifle/rifle_ump45',
    { idle: 'idle_ump45', draw: 'draw_ump45', fire: 'shoot1_ump45', reload: 'reload_ump45' },
  ],
  uspsilencer: [
    'pistol/_default_pistol',
    {
      idle: 'idle_pistol',
      draw: 'draw_pistol',
      fire: 'shoot1_pistol',
      reload: 'reload_pistol',
      silencerOn: 'silencer_attach_pistol',
      silencerOff: 'silencer_detach_pistol',
    },
  ],
  xm1014: [
    'rifle/rifle_xm1014',
    { idle: 'idle_xm1014', draw: 'draw_xm1014', fire: 'shoot1_xm1014', reload: 'reload_xm1014' },
  ],
  bayonet: ['knife/knife_bayonet', { idle: 'idle1_bayonet', draw: 'draw_bayonet' }],
  knife: ['knife/_default_knife', { idle: 'idle_knife', draw: 'draw_knife' }],
  knifet: ['knife/knife_default_t', { idle: 'idle_default_t', draw: 'draw_default_t' }],
  knifebowie: ['knife/knife_bowie', { idle: 'idle1_bowie', draw: 'draw_bowie' }],
  knifebutterfly: ['knife/knife_butterfly', { idle: 'idle1_butterfly', draw: 'draw_butterfly' }],
  knifecanis: ['knife/knife_canis', { idle: 'idle1_canis', draw: 'draw_canis' }],
  knifecord: ['knife/knife_cord', { idle: 'idle1_cord', draw: 'draw_cord' }],
  knifecss: ['knife/knife_css', { idle: 'idle1_css', draw: 'draw_css' }],
  knifefalchion: ['knife/knife_falchion', { idle: 'idle1_falchion', draw: 'draw_falchion' }],
  knifeflip: ['knife/knife_flip', { idle: 'idle1_flip', draw: 'draw_flip' }],
  knifegut: ['knife/knife_gut', { idle: 'idle1_gut', draw: 'draw_gut' }],
  knifegypsyjackknife: ['knife/knife_navaja', { idle: 'idle1_navaja', draw: 'draw_navaja' }],
  knifekarambit: ['knife/knife_karambit', { idle: 'idle1_karambit', draw: 'draw_karambit' }],
  knifekukri: ['knife/knife_kukri', { idle: 'idle1_kukri', draw: 'draw_kukri' }],
  knifem9bayonet: ['knife/knife_m9', { idle: 'idle1_m9', draw: 'draw_m9' }],
  knifeoutdoor: ['knife/knife_outdoor', { idle: 'idle1_outdoor', draw: 'draw_outdoor' }],
  knifepush: ['knife/knife_push', { idle: 'idle1_push', draw: 'draw_push' }],
  knifeskeleton: ['knife/knife_skeleton', { idle: 'idle1_skeleton', draw: 'draw_skeleton' }],
  knifestiletto: ['knife/knife_stiletto', { idle: 'idle1_stiletto', draw: 'draw_stiletto' }],
  knifesurvivalbowie: ['knife/knife_bowie', { idle: 'idle1_bowie', draw: 'draw_bowie' }],
  knifetactical: ['knife/knife_tactical', { idle: 'idle1_tactical', draw: 'draw_tactical' }],
  knifeursus: ['knife/knife_ursus', { idle: 'idle1_ursus', draw: 'draw_ursus' }],
  knifewidowmaker: ['knife/knife_talon', { idle: 'idle1_talon', draw: 'draw_talon' }],
  flashbang: ['grenade/grenade_flashbang', { idle: 'idle_flashbang', draw: 'draw_flashbang' }],
  smokegrenade: ['grenade/grenade_smokegrenade', { idle: 'idle_smoke', draw: 'draw_smoke' }],
  hegrenade: ['grenade/grenade_hegrenade', { idle: 'idle_hegrenade', draw: 'draw_hegrenade' }],
  molotov: ['grenade/grenade_molotov', { idle: 'idle_molotov', draw: 'draw_molotov' }],
  incgrenade: ['grenade/grenade_incendiary', { idle: 'idle_incendiary', draw: 'draw_incendiary' }],
  decoy: ['grenade/_default_grenade', { idle: 'idle_grenade', draw: 'draw_grenade' }],
  c4: ['equipment/c4', { idle: 'idle_c4', draw: 'draw_c4' }],
};
// These fixed first-person families use the same suffix as their draw clip.
// Every family ships an inspect clip (lookat01); grenades a pin pull, knives a
// secondary (heavy) attack and the C4 its plant.
function actionFiles(directory, roles) {
  const suffix = roles.draw.slice('draw_'.length);
  const inspect = 'lookat01_' + suffix;
  if (directory.startsWith('grenade/'))
    return {
      ...roles,
      throw: 'throw_overhand_' + suffix,
      underhand: 'throw_underhand_' + suffix,
      pullpin: 'pullpin_' + suffix,
      inspect,
    };
  if (directory.startsWith('knife/'))
    return { ...roles, slash: 'light_miss1_' + suffix, heavy: 'heavy_miss1_' + suffix, inspect };
  if (directory === 'equipment/c4') return { ...roles, plant: 'plant_' + suffix, inspect };
  return { ...roles, inspect };
}

export const viewmodelSources = Object.freeze(
  Object.fromEntries(
    Object.entries(clips).map(([id, [directory, roles]]) => [
      id,
      Object.freeze({
        arms,
        weapon: equipmentModelRegistry[id].resource,
        ...Object.fromEntries(
          Object.entries(actionFiles(directory, roles)).map(([role, file]) => [
            role,
            root + directory + '/' + file + '.vnmclip_c',
          ]),
        ),
      }),
    ]),
  ),
);

export const viewmodelClips = new Set(
  Object.values(viewmodelSources).flatMap((resources) =>
    Object.values(resources).filter((path) => path.endsWith('.vnmclip_c')),
  ),
);
export const presentationPriority = Object.freeze([
  'ak47',
  'm4a1',
  'm4a1silencer',
  'awp',
  'uspsilencer',
  'glock',
  'knife',
  'knifet',
  'deagle',
  'smokegrenade',
  'flashbang',
  'hegrenade',
  'molotov',
  'c4',
  'mp9',
  'mac10',
  'ssg08',
]);
