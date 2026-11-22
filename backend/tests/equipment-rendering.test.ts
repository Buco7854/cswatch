import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Group,
  Mesh,
  BoxGeometry,
  MeshStandardMaterial,
  DirectionalLight,
  Box3,
  Vector3,
  Euler,
  Bone,
  Skeleton,
  SkinnedMesh,
  PerspectiveCamera,
} from '../../frontend/node_modules/three/build/three.module.js';
import {
  prepareEquipmentModel,
  disposeEquipmentInstance,
} from '../../frontend/src/equipment-model.js';
import {
  fitPovAttachment,
  staticPovAttachment,
  povFar,
  povNear,
  povOffset,
  povProjection,
} from '../../frontend/src/pov-camera.js';
import { validateEquipmentAssets } from '../../frontend/src/equipment-assets.js';
import { projectileEquipment } from '../../frontend/src/projectile-equipment.js';
import { equipmentIconKey } from '../../frontend/src/equipment-icons.js';
import equipmentModels from '../../shared/equipment-models.json';
import { originalEquipmentCatalog } from '../../frontend/tests/fixtures/original-equipment.js';

test('recorded display names retain their exact weapon or knife identity across HUD artwork and prepared model registries', () => {
  for (const [label, id] of [
    ['Bowie Knife', 'knifesurvivalbowie'],
    ['★ Butterfly Knife', 'knifebutterfly'],
    ['Classic Knife', 'knifecss'],
    ['Falchion Knife', 'knifefalchion'],
    ['Flip Knife', 'knifeflip'],
    ['Gut Knife', 'knifegut'],
    ['Huntsman Knife', 'knifetactical'],
    ['M9 Bayonet', 'knifem9bayonet'],
    ['Karambit', 'knifekarambit'],
    ['Kukri Knife', 'knifekukri'],
    ['Navaja Knife', 'knifegypsyjackknife'],
    ['Nomad Knife', 'knifeoutdoor'],
    ['Paracord Knife', 'knifecord'],
    ['Shadow Daggers', 'knifepush'],
    ['Skeleton Knife', 'knifeskeleton'],
    ['Stiletto Knife', 'knifestiletto'],
    ['Survival Knife', 'knifecanis'],
    ['Talon Knife', 'knifewidowmaker'],
    ['Ursus Knife', 'knifeursus'],
    ['R8 Revolver', 'revolver'],
    ['M4A1-S', 'm4a1silencer'],
    ['weapon_knife_survival_bowie', 'knifesurvivalbowie'],
  ]) {
    assert.equal(equipmentIconKey(label), id, label);
    assert.ok(Object.hasOwn(equipmentModels.items, id), `Exact ${label} model is selectable`);
  }
  for (const unknown of ['My Bowie lookalike', 'Some Knife', 'constructor', 'unknown-rifle'])
    assert.equal(equipmentIconKey(unknown), undefined);
});

test('equipment instances preserve exact named geometry and shared texture ownership while isolating imported lights/pose', () => {
  const source = new Group(),
    geometry = new BoxGeometry(0.6, 0.08, 0.08),
    material = new MeshStandardMaterial({ color: 'magenta' }),
    mesh = new Mesh(geometry, material),
    light = new DirectionalLight('white', 2049);
  mesh.name = 'qa-original-equipment-body';
  source.add(mesh, light);
  source.position.set(10, 20, 30);
  const instance = prepareEquipmentModel(source),
    clone = instance.getObjectByName(mesh.name) as Mesh;
  assert.notEqual(instance, source);
  assert.notEqual(clone, mesh);
  assert.equal(clone.geometry, geometry);
  assert.equal(clone.material, material);
  assert.deepEqual(instance.position.toArray(), [10, 20, 30]);
  assert.equal(
    instance.children.find((child) => child instanceof DirectionalLight)?.visible,
    false,
  );
  assert.equal(light.visible, true);
  assert.equal(light.intensity, 2049);
  clone.position.set(3, 4, 5);
  assert.deepEqual(mesh.position.toArray(), [0, 0, 0]);
  assert.equal(clone.castShadow, false);
  assert.equal(clone.receiveShadow, true);
});

test('equipment discovery rejects arbitrary URLs, malformed budgets and attachment bounds while keeping canonical identities', () => {
  const valid = originalEquipmentCatalog(),
    input = structuredClone(valid);
  assert.deepEqual(Object.keys(validateEquipmentAssets(valid).items), Object.keys(valid.items));
  for (const change of [
    (value: typeof input) => (value.items.ak47.model = 'https://example.com/model.glb'),
    (value: typeof input) => (value.items.ak47.model = '/api/assets/equipment-models/c4.glb'),
    (value: typeof input) => (value.items.ak47.sha256 = 'x'.repeat(64)),
    (value: typeof input) => (value.items.ak47.bytes = 16 * 1024 ** 2 + 1),
    (value: typeof input) => (value.items.ak47.geometryBytes = 8 * 1024 ** 2 + 1),
    (value: typeof input) => (value.items.ak47.decodedTextureBytes = 16 * 1024 ** 2 + 1),
    (value: typeof input) => (value.items.ak47.bounds.min[0] = 1),
    (value: typeof input) => (value.items.ak47.bounds.max[1] = Infinity),
  ]) {
    const candidate = structuredClone(valid);
    change(candidate);
    assert.throws(() => validateEquipmentAssets(candidate));
  }
  const unknown = structuredClone(valid);
  unknown.items['arbitrary-id'] = unknown.items.ak47;
  assert.throws(() => validateEquipmentAssets(unknown));
});

test('original static POV preset leaves positive eye clearance in every recorded aim orientation', () => {
  const asset = originalEquipmentCatalog(['ak47']).items.ak47,
    preset = staticPovAttachment(asset.bounds);
  const box = new Box3(new Vector3(...asset.bounds.min), new Vector3(...asset.bounds.max));
  // This fixture uses a native-scale, origin-centered prop with explicit static attachment.
  box.min.multiplyScalar(preset.scale).add(new Vector3(...preset.position));
  box.max.multiplyScalar(preset.scale).add(new Vector3(...preset.position));
  assert.ok(box.min.x > 0.05, 'whole original model remains ahead of the camera near plane');
  assert.ok(box.distanceToPoint(new Vector3()) > 0.3, 'static model does not intersect the eye');
  for (const yaw of [0, 90, 180, 270])
    for (const pitch of [-70, 0, 70]) {
      const eyeOffset = new Vector3(...preset.position).applyEuler(
        new Euler(0, (yaw * Math.PI) / 180, (-pitch * Math.PI) / 180, 'YZX'),
      );
      assert.ok(Math.abs(eyeOffset.length() - new Vector3(...preset.position).length()) < 1e-10);
    }
});

test('trajectory-based grenade models accept exact native/canonical kinds and keep ambiguous incendiary classes unknown', () => {
  assert.equal(projectileEquipment('CSmokeGrenadeProjectile'), 'smokegrenade');
  assert.equal(projectileEquipment('CHEGrenadeProjectile'), 'hegrenade');
  assert.equal(projectileEquipment('CFlashbangProjectile'), 'flashbang');
  assert.equal(projectileEquipment('CDecoyProjectile'), 'decoy');
  assert.equal(projectileEquipment('weapon_incgrenade'), 'incgrenade');
  assert.equal(projectileEquipment('CMolotovProjectile'), undefined);
  assert.equal(projectileEquipment('someone_smoke_like'), undefined);
  assert.equal(projectileEquipment('CBaseCSGrenadeProjectile'), undefined);
});

test('cloned skinned equipment releases only instance bone textures while retaining shared model resources', () => {
  const source = new Group(),
    bone = new Bone(),
    geometry = new BoxGeometry(),
    material = new MeshStandardMaterial(),
    mesh = new SkinnedMesh(geometry, material);
  source.add(bone, mesh);
  mesh.bind(new Skeleton([bone]));
  const instance = prepareEquipmentModel(source),
    cloned = instance.children.find((child) => child instanceof SkinnedMesh) as SkinnedMesh;
  assert.notEqual(cloned.skeleton, mesh.skeleton);
  cloned.skeleton.computeBoneTexture();
  mesh.skeleton.computeBoneTexture();
  let released = 0,
    originalReleased = 0,
    geometryReleased = 0,
    materialReleased = 0;
  cloned.skeleton.boneTexture!.addEventListener('dispose', () => released++);
  mesh.skeleton.boneTexture!.addEventListener('dispose', () => originalReleased++);
  geometry.addEventListener('dispose', () => geometryReleased++);
  material.addEventListener('dispose', () => materialReleased++);
  disposeEquipmentInstance(instance);
  assert.equal(released, 1);
  assert.equal(originalReleased, 0);
  assert.equal(geometryReleased, 0);
  assert.equal(materialReleased, 0);
  assert.equal(cloned.skeleton.boneTexture, null);
  assert.notEqual(mesh.skeleton.boneTexture, null);
  mesh.skeleton.dispose();
  geometry.dispose();
  material.dispose();
});

test('portrait static POV attachment retains native scale/depth while moving lateral offset inside the narrower field of view', () => {
  const asset = originalEquipmentCatalog(['ak47']).items.ak47,
    preset = staticPovAttachment(asset.bounds);
  const before = structuredClone(preset),
    portrait = fitPovAttachment(preset, 390 / 900),
    desktop = fitPovAttachment(preset, 1440 / 900);
  assert.deepEqual(preset, before);
  assert.deepEqual(desktop, preset);
  assert.equal(portrait.scale, preset.scale);
  assert.equal(portrait.position[0], preset.position[0]);
  assert.equal(portrait.position[1], preset.position[1]);
  assert.ok(portrait.position[2] < preset.position[2] * 0.3);
  const { aspect, fov } = povProjection(390 / 900);
  const camera = new PerspectiveCamera(fov, aspect, povNear, povFar);
  const offset = new Vector3(povOffset.right, povOffset.up, -povOffset.forward);
  const position = new Vector3(...portrait.position);
  const basis = new Euler(0, Math.PI / 2, 0);
  for (const x of [asset.bounds.min[0], asset.bounds.max[0]])
    for (const y of [asset.bounds.min[1], asset.bounds.max[1]])
      for (const z of [asset.bounds.min[2], asset.bounds.max[2]]) {
        const corner = new Vector3(x, y, z)
          .multiplyScalar(portrait.scale)
          .add(position)
          .applyEuler(basis)
          .add(offset)
          .project(camera);
        assert.ok(corner.x > 0 && corner.x < 1, 'every corner is inside the right half');
        assert.ok(corner.y > -1 && corner.y < 0, 'every corner is inside the lower half');
        assert.ok(Math.abs(corner.z) < 1, 'every corner is between the clip planes');
      }
});
