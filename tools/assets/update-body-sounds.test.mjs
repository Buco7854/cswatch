import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSoundEvents, updateBodySounds } from './update-body-sounds.mjs';

const kv3 = `{
\tBase.Step = 
\t{
\t\tvolume = 0.9
\t\tdistance_volume_mapping_curve = 
\t\t[
\t\t\t[
\t\t\t\t0.0, 1.0, 0.0, 0.0,
\t\t\t\t2.0, 3.0,
\t\t\t],
\t\t\t[
\t\t\t\t1100.0, 0.0, 0.0, 0.0,
\t\t\t\t2.0, 3.0,
\t\t\t],
\t\t]
\t}
\tCT_Test.StepLeft = 
\t{
\t\tbase = "Base.Step"
\t\tvsnd_files_track_01 = 
\t\t[
\t\t\t"sounds/player/footsteps/test_01.vsnd",
\t\t\t"sounds/player/footsteps/test_02.vsnd",
\t\t]
\t}
\tWeapon_Test.Single = 
\t{
\t\tvsnd_files_track_01 = 
\t\t[
\t\t\t"sounds/weapons/test/test_01.vsnd",
\t\t]
\t}
\tPlayer.Death = 
\t{
\t\tvolume = 0.5
\t\tvsnd_files_track_01 = 
\t\t[
\t\t\t"sounds/player/death1.vsnd",
\t\t\t"sounds/player/death2.vsnd",
\t\t]
\t}
}
`;

test('authored variations and curves are added for player events only', () => {
  const events = parseSoundEvents(kv3);
  assert.deepEqual(events['CT_Test.StepLeft'].files, [
    'sounds/player/footsteps/test_01.vsnd',
    'sounds/player/footsteps/test_02.vsnd',
  ]);
  const registry = updateBodySounds(
    {
      schemaVersion: 1,
      items: {
        footstep: { source: 'sounds/player/footsteps/test_01.vsnd_c', category: 'footstep' },
        'test-fire': { source: 'sounds/weapons/test/test_01.vsnd_c', category: 'weapon' },
      },
      events: {
        'CT_Test.StepLeft': { soundId: 'footstep', channel: 'sos', hash: 1, volume: 0.9 },
        'Weapon_Test.Single': { soundId: 'test-fire', channel: 'weapon-sound' },
      },
    },
    events,
  );
  const step = registry.events['CT_Test.StepLeft'];
  assert.deepEqual(step.variants, ['footstep', 'footstep-test-02']);
  assert.deepEqual(step.distance, [
    [0, 1],
    [1100, 0],
  ]);
  assert.equal(registry.items['footstep-test-02'].category, 'footstep');
  assert.deepEqual(registry.events['Weapon_Test.Single'], {
    soundId: 'test-fire',
    channel: 'weapon-sound',
  });
  assert.deepEqual(registry.events['Player.Death'].variants, ['hit-death1', 'hit-death2']);
  assert.equal(registry.events['Player.Death'].volume, 0.5);
  assert.equal(registry.items['hit-death1'].category, 'weapon');
});
