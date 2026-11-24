/** Exact native single clips. Never follow the character's animation graph. */
import contract from '../../shared/agent-animation.json' with { type: 'json' };
import { directionalRoles } from '../../shared/agent-animation-contract.mjs';
export const agentAnimationLimits = Object.freeze({
  seconds: contract.limits.seconds,
  samples: 2048,
  // Retargeting + posed-vertex validation must also be CPU bounded.
  totalSamples: 8192,
  jointSamples: 1_000_000,
  posedVertices: 64000000,
  channels: contract.limits.maxChannels,
  sourceBytes: 8 * 1024 ** 2,
  outputBytes: 8 * 1024 ** 2,
});

const special = {
  'rifle-idle': 'animation/anims/world/rifle/rifle_m4a4/idle_m4a4.vnmclip+non_additive.vnmclip_c',
  'rifle-crouch-idle':
    'animation/anims/world/rifle/rifle_m4a4/idle_crouch_m4a4.vnmclip+non_additive.vnmclip_c',
  'rifle-fire': 'animation/anims/world/rifle/rifle_m4a4/shoot_m4a4.vnmclip+non_additive.vnmclip_c',
  'rifle-draw': 'animation/anims/world/rifle/rifle_m4a4/draw_m4a4.vnmclip_c',
  'rifle-reload': 'animation/anims/world/rifle/rifle_m4a4/reload_m4a4.vnmclip_c',
  'pistol-idle':
    'animation/anims/world/pistol/pistol_glock/idle_glock.vnmclip+non_additive.vnmclip_c',
  'pistol-crouch-idle':
    'animation/anims/world/pistol/pistol_glock/idle_crouch_glock.vnmclip+non_additive.vnmclip_c',
  'pistol-fire':
    'animation/anims/world/pistol/pistol_glock/shoot_glock.vnmclip+non_additive.vnmclip_c',
  'pistol-draw': 'animation/anims/world/pistol/pistol_glock/draw_glock.vnmclip_c',
  'pistol-reload': 'animation/anims/world/pistol/pistol_glock/reload_glock.vnmclip_c',
  'knife-idle': 'animation/anims/world/knife/_default_knife/idle_knife.vnmclip_c',
  'knife-crouch-idle': 'animation/anims/world/knife/_default_knife/idle_crouch_knife.vnmclip_c',
  'knife-fire': 'animation/anims/world/knife/_default_knife/frontswing_knife.vnmclip_c',
  'knife-draw': 'animation/anims/world/knife/_default_knife/draw_knife.vnmclip_c',
  'dual-idle':
    'animation/anims/world/pistol/pistol_elite/idle_elite.vnmclip+non_additive.vnmclip_c',
  'dual-crouch-idle':
    'animation/anims/world/pistol/pistol_elite/idle_crouch_elite.vnmclip+non_additive.vnmclip_c',
  'dual-fire':
    'animation/anims/world/pistol/pistol_elite/shoot_right1_elite.vnmclip+non_additive.vnmclip_c',
  'dual-draw': 'animation/anims/world/pistol/pistol_elite/draw_elite.vnmclip_c',
  'dual-reload': 'animation/anims/world/pistol/pistol_elite/reload_elite.vnmclip_c',
  'grenade-idle':
    'animation/anims/world/grenade/_default_grenade/idle_grenade.vnmclip+non_additive.vnmclip_c',
  'grenade-crouch-idle':
    'animation/anims/world/grenade/_default_grenade/idle_crouch_grenade.vnmclip+non_additive.vnmclip_c',
  'grenade-draw': 'animation/anims/world/grenade/_default_grenade/draw_grenade.vnmclip_c',
  'grenade-throw':
    'animation/anims/world/grenade/_default_grenade/throw_overhand_grenade.vnmclip_c',
  'grenade-throw-underhand':
    'animation/anims/world/grenade/_default_grenade/throw_underhand_grenade.vnmclip_c',
  'rifle-defuse': 'animation/anims/world/shared/defuse/defuse_loop_rifle.vnmclip_c',
  'pistol-defuse': 'animation/anims/world/shared/defuse/defuse_loop_pistol.vnmclip_c',
  'knife-defuse': 'animation/anims/world/shared/defuse/defuse_loop_knife.vnmclip_c',
  'c4-carry':
    'animation/anims/world/equipment/c4/turn_right_loop_90_c4.vnmclip+non_additive.vnmclip_c',
  'death-a': 'animation/anims/world/shared/death_chest_a.vnmclip_c',
  'death-b': 'animation/anims/world/shared/death_chest_b.vnmclip_c',
};
export const directionalAgentRegistry = Object.freeze(
  Object.fromEntries(
    directionalRoles.map((role) => {
      const [weapon, gait, direction] = role.split('-');
      return [
        role,
        special[role] ??
          `animation/anims/world/${weapon}/_default_${weapon}/${gait}_${direction}_${weapon}.vnmclip_c`,
      ];
    }),
  ),
);
