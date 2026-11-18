/** Exact native single clips. Never follow the character's animation graph. */
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
  contract.schemaVersion !== 1 ||
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
  channels: 1024,
  sourceBytes: 8 * 1024 ** 2,
  outputBytes: 8 * 1024 ** 2,
});
