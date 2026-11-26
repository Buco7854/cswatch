import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseKv3Text, convertRagdoll } from './agent-ragdoll.mjs';

const kv3 = `<!-- kv3 encoding:text:version{e21c7f3c-8a33-41c5-9977-a76d3a32aa0d} format:generic:version{7412167c-06e9-4698-aff2-e63eb59037e7} -->
{
\tm_boneNames = [ "pelvis", "spine_2" ]
\tm_bindPose =
\t[
\t\t[ 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 40.0 ],
\t\t[ 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 50.0 ],
\t]
\tm_parts =
\t[
\t\t{ m_flMass = 50.0 m_flAngularDamping = 2.0 m_rnShape = { m_spheres = [  ] m_capsules = [ { m_Capsule = { m_vCenter = [ [ 0.0, 0.0, 0.0 ], [ 0.0, 0.0, 8.0 ] ] m_flRadius = 7.0 } } ] } },
\t\t{ m_flMass = 50.0 m_rnShape = { m_spheres = [ { m_Sphere = { m_vCenter = [ 0.0, 0.0, 4.0 ] m_flRadius = 7.0 } } ] m_capsules = [  ] } },
\t]
\tm_joints =
\t[
\t\t{ m_nBody1 = 0 m_nBody2 = 1 m_Frame1 = [ 0.0, 0.0, 10.0, 1.0, 0.0, 0.0, 0.0, 1.0 ] m_Frame2 = [ 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0 ] m_bEnableSwingLimit = true m_SwingLimit = { m_flMin = 0.0 m_flMax = 0.5 } m_bEnableTwistLimit = false m_flFriction = 0.4 },
\t]
}`;

test('the PHYS block converts to skeleton bone space with a verified axis fit', () => {
  const phys = parseKv3Text(kv3);
  assert.equal(phys.m_parts.length, 2);
  // Source Z-up inches -> glTF Y-up metres: (x, y, z) -> (x, z, -y) * 0.0254.
  const bind = new Map([
    ['pelvis', [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 40 * 0.0254, 0, 1]],
    ['spine_2', [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 50 * 0.0254, 0, 1]],
  ]);
  const ragdoll = convertRagdoll(phys, bind);
  assert.ok(ragdoll.axesFitMeters < 1e-4);
  assert.equal(ragdoll.bodies[0].bone, 'pelvis');
  assert.deepEqual(
    ragdoll.bodies[0].shapes[0].b.map((v) => Math.abs(v)),
    [0, 8 * 0.0254, 0].map((v) => Math.round(v * 1e5) / 1e5),
  );
  assert.equal(ragdoll.bodies[0].shapes[0].radius, Math.round(7 * 0.0254 * 1e5) / 1e5);
  assert.equal(ragdoll.bodies[1].shapes[0].a.join(), ragdoll.bodies[1].shapes[0].b.join());
  assert.deepEqual(ragdoll.joints[0].swing, [0, 0.5]);
  assert.equal(ragdoll.joints[0].twist, null);
  // Bones the skeleton lacks, or bind poses that disagree with it, are refused.
  assert.throws(() => convertRagdoll(phys, new Map([['pelvis', bind.get('pelvis')]])));
  const shifted = new Map([...bind].map(([k, m]) => [k, m.map((v, i) => (i === 13 ? v + 1 : v))]));
  assert.throws(() => convertRagdoll(phys, shifted));
  assert.throws(() => parseKv3Text('{ m_a = [ ' + '1, '.repeat(100001) + '] }'));
});
