/** Exact native single clips. Never follow the character's animation graph. */
import { directionalRoles } from '../../shared/agent-animation-contract.mjs';
import { readFileSync } from 'node:fs';
const contract = JSON.parse(
  readFileSync(new URL('../../shared/agent-animation.json', import.meta.url), 'utf8'),
);
export const agentAnimationNames = Object.freeze(contract.clips);
export const agentAnimationRegistry = Object.freeze({
  idle: 'animation/anims/world/rifle/rifle_m4a4/idle_m4a4.vnmclip+non_additive.vnmclip_c',
  walk: 'animation/anims/world/rifle/_default_rifle/walk_n_rifle.vnmclip_c',
  run: 'animation/anims/world/rifle/_default_rifle/run_n_rifle.vnmclip_c',
  'crouch-idle':
    'animation/anims/world/rifle/rifle_m4a4/idle_crouch_m4a4.vnmclip+non_additive.vnmclip_c',
  'crouch-walk': 'animation/anims/world/rifle/_default_rifle/crouch_n_rifle.vnmclip_c',
});
export const agentAnimationRoles = Object.freeze(Object.keys(agentAnimationNames));
if (
  contract.schemaVersion !== 2 ||
  agentAnimationRoles.length !== 5 ||
  agentAnimationRoles.some((role) => !Object.hasOwn(agentAnimationRegistry, role))
)
  throw Error('Invalid shared prepared-agent animation contract.');
export const agentAnimationLimits = Object.freeze({
  clips: 5,
  seconds: 30,
  samples: 2048,
  // Retargeting + posed-vertex validation must also be CPU bounded.
  totalSamples: 4096,
  directionalSamples: 8192,
  jointSamples: 1_000_000,
  posedVertices: 64000000,
  channels: 1024,
  sourceBytes: 8 * 1024 ** 2,
  outputBytes: 8 * 1024 ** 2,
});

const special = {
  'rifle-idle': agentAnimationRegistry.idle,
  'rifle-crouch-idle': agentAnimationRegistry['crouch-idle'],
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
