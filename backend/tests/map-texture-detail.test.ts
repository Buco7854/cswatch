import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Group,
  LinearFilter,
  Mesh,
  MeshStandardMaterial,
  NearestFilter,
  Texture,
} from '../../frontend/node_modules/three/build/three.module.js';
import { improveMapTextureDetail } from '../../frontend/src/map-texture-detail.js';

test('detailed tiers filter opaque world color at grazing angles and preserve authored sampler choices', () => {
  const world = new Group();
  const material = new MeshStandardMaterial({ map: new Texture(), normalMap: new Texture() });
  const nearest = new Texture();
  nearest.magFilter = NearestFilter;
  const linear = new Texture();
  linear.minFilter = LinearFilter;
  const noMips = new Texture();
  noMips.generateMipmaps = false;
  const stronger = new Texture();
  stronger.anisotropy = 8;
  const colors = [nearest, linear, noMips, stronger];
  world.add(
    new Mesh(undefined, [material, ...colors.map((map) => new MeshStandardMaterial({ map }))]),
  );
  improveMapTextureDetail([world], 'compact');
  assert.equal(material.map!.anisotropy, 1);
  improveMapTextureDetail([world], 'mobile');
  assert.equal(material.map!.anisotropy, 2);
  improveMapTextureDetail([world], 'desktop');
  assert.equal(material.map!.anisotropy, 4);
  assert.equal(material.normalMap!.anisotropy, 1);
  assert.deepEqual(
    colors.map((v) => v.anisotropy),
    [1, 1, 1, 8],
  );
});

test('mobile preserves coverage when a transparent or masked mesh shares an opaque mesh’s source', () => {
  for (const options of [{ alphaTest: 0.5 }, { transparent: true }]) {
    const opaque = new Texture();
    const other = new MeshStandardMaterial({ map: opaque.clone(), ...options });
    const world = new Group();
    world.add(
      new Mesh(undefined, new MeshStandardMaterial({ map: opaque })),
      new Mesh(undefined, other),
    );
    improveMapTextureDetail([world], 'mobile');
    assert.equal(opaque.anisotropy, 1);
    assert.equal(other.map!.anisotropy, 1);
    assert.equal(other.alphaToCoverage, false);
    improveMapTextureDetail([world], 'desktop');
    assert.equal(other.map!.anisotropy, 4);
    assert.equal(other.alphaToCoverage, Boolean(options.alphaTest));
  }
});
