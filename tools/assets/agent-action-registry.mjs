/** Exact official single clips for the shared action bank. Never follow the animation graph. */
import { agentActionRoles, agentActionContract as contract } from '../../shared/agent-actions.mjs';

const world = 'animation/anims/world/';
const composed = (path) => path + '.vnmclip+non_additive.vnmclip_c';
const plain = (path) => path + '.vnmclip_c';
const classSuffix = { rifle: '_rifle', pistol: '_pistol', knife: '' };
const flinchClip = {
  head: 'flinch_head',
  'head-left': 'flinch_head_left',
  'head-right': 'flinch_head_right',
  'head-rear': 'flinch_head_rear',
  chest: 'flinch_chest',
  'chest-left': 'flinch_chest_left',
  'chest-right': 'flinch_chest_right',
  'chest-rear': 'flinch_chest_rear',
  stomach: 'flinch_stomach',
  'stomach-rear': 'flinch_stomach_rear',
  'arm-left': 'flinch_arm_left',
  'arm-right': 'flinch_arm_right',
  'leg-left': 'flinch_leg_left',
  'leg-right': 'flinch_leg_right',
};
const deathClip = {
  'chest-a': 'death_chest_a',
  'chest-b': 'death_chest_b',
  'gut-a': 'death_gut_a',
  'gut-b': 'death_gut_b',
  'rknee-a': 'death_rknee_a',
  'rknee-b': 'death_rknee_b',
  rshoulder: 'death_rshoulder',
};
function source(role) {
  const [family, subject, action] = role.split(':');
  if (family === 'weapon') {
    const [kind, folder, name, shoot] = contract.weapons[subject];
    const base = `${world}${kind}/${folder}/`;
    if (action === 'idle') return composed(`${base}idle_${name}`);
    if (action === 'crouch-idle') return composed(`${base}idle_crouch_${name}`);
    if (action === 'fire') return composed(`${base}shoot_${shoot}`);
    return plain(`${base}${action}_${name}`);
  }
  const base = `${world}${subject}/_default_${subject}/`;
  if (family === 'air') return plain(`${base}inair_stand_${subject}`);
  if (family === 'air-crouch') return plain(`${base}inair_crouch_stand_${subject}`);
  if (family === 'ladder') return plain(`${base}ladder_facing_slow_${subject}`);
  if (family === 'ladder-fast') return plain(`${base}ladder_facing_fast_${subject}`);
  if (family === 'jump-start')
    return composed(`${world}shared/jump_additive_start${classSuffix[subject]}`);
  if (family === 'jump-land')
    return composed(`${world}shared/jump_additive_land${classSuffix[subject]}`);
  if (family === 'flinch') return composed(`${world}shared/${flinchClip[subject]}`);
  if (family === 'death') return plain(`${world}shared/${deathClip[subject]}`);
  if (role === 'c4:plant') return plain(`${world}equipment/c4/planting`);
  if (role === 'c4:plant-crouch') return plain(`${world}equipment/c4/planting_crouch`);
  throw Error('Unknown native action role.');
}
export const agentActionRegistry = Object.freeze(
  Object.fromEntries(agentActionRoles.map((role) => [role, source(role)])),
);
