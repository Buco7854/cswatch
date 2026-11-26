import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentActionRegistry } from './agent-action-registry.mjs';
import { agentActionRoles, agentActionKind } from '../../shared/agent-actions.mjs';
import { travellingJoints } from './prepare-agent-actions.mjs';

test('every action role names one fixed official world clip', () => {
  assert.equal(Object.keys(agentActionRegistry).length, agentActionRoles.length);
  assert.ok(agentActionRoles.length <= 320);
  const paths = Object.values(agentActionRegistry);
  assert.equal(new Set(paths).size, paths.length, 'no clip serves two roles');
  for (const [role, path] of Object.entries(agentActionRegistry)) {
    assert.match(
      path,
      /^animation\/anims\/world\/[a-z0-9_/]+(?:\.vnmclip\+non_additive)?\.vnmclip_c$/,
    );
    assert.ok(['upper', 'full', 'delta'].includes(agentActionKind(role)), role);
    // Additive layers are read from Valve's composed (non-additive) export.
    if (agentActionKind(role) === 'delta') assert.match(path, /\+non_additive/, role);
  }
  assert.equal(
    agentActionRegistry['weapon:awp:idle'],
    'animation/anims/world/rifle/rifle_awp/idle_awp.vnmclip+non_additive.vnmclip_c',
  );
  assert.equal(
    agentActionRegistry['weapon:hkp2000:reload'],
    'animation/anims/world/pistol/pistol_hkp2000/reload_hkp.vnmclip_c',
  );
  assert.equal(agentActionRegistry['weapon:taser:reload'], undefined);
  assert.equal(
    agentActionRegistry['turn-left-crouch:knife'],
    'animation/anims/world/knife/_default_knife/turn_left_45_crouch_knife.vnmclip_c',
  );
  assert.equal(
    agentActionRegistry['turn-right:rifle'],
    'animation/anims/world/rifle/_default_rifle/turn_right_45_rifle.vnmclip_c',
  );
  assert.equal(
    agentActionRegistry['ladder:pistol'],
    'animation/anims/world/pistol/_default_pistol/ladder_facing_slow_pistol.vnmclip_c',
  );
});

test('only motion-carrying joints keep authored translation', () => {
  assert.deepEqual([...travellingJoints].sort(), ['pelvis', 'root_motion', 'wpn', 'wpnPivot']);
});
