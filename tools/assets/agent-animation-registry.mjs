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
  'knife-draw': 'animation/anims/world/knife/_default_knife/draw_knife.vnmclip_c',
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
