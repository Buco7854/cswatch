import { inspectMapGraphics } from './map-visual-audit.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Document } from '@gltf-transform/core';
import { materialShaderBatch } from './shader-preflight.mjs';
import { bindPreparedWater } from './prepare-map-water.mjs';
import { readWaterBindings, writeWaterBindings } from './map-water-inputs.mjs';
import { filterMapWorldMaterials } from './map-world-materials.mjs';

const vmat = {
  Name: 'materials/qa/basin.vmat',
  ShaderName: 'csgo_water_fancy.vfx',
  IntParams: { F_REFRACTION: 1, F_REFLECTION_TYPE: 2 },
  FloatParams: {
    g_flWaterFogStrength: 0.5,
    g_flReflectance: 0.04,
    g_flFresnelExponent: 6,
    g_flWaterRoughnessMin: 0.25,
    g_flWaterRoughnessMax: 0.8,
  },
  VectorParams: { g_vWaterFogColor: [0.25, 0.5, 0.75, 1], g_vColorTint: [1, 1, 1, 0] },
};
function data() {
  const section = (name, params, key) =>
    'm_' +
    name +
    ' = [\n' +
    Object.entries(params)
      .map(
        ([k, v]) =>
          ' { m_name = "' +
          k +
          '"\n m_' +
          key +
          ' = ' +
          (Array.isArray(v) ? JSON.stringify(v) : v) +
          '\n },',
      )
      .join('\n') +
    '\n]\n';
  return (
    'm_materialName = "' +
    vmat.Name +
    '"\nm_shaderName = "' +
    vmat.ShaderName +
    '"\n' +
    section('intParams', vmat.IntParams, 'nValue') +
    section('floatParams', vmat.FloatParams, 'flValue') +
    section('vectorParams', vmat.VectorParams, 'value') +
    'm_textureParams = []\nm_dynamicParams = []\nm_dynamicTextureParams = []\n'
  );
}
const decode = (text) =>
  materialShaderBatch('[1/1] /qa/source.vmat_c\n' + text, ['/qa/source.vmat_c'])[0];
const material = { resource: vmat.Name + '_c', sha256: 'a'.repeat(64), ...decode(data()) };

test('water requires static checked optical terms and one unambiguous material source', async () => {
  assert.deepEqual(material.water, {
    name: vmat.Name,
    fog: [0.25, 0.5, 0.75],
    density: 0.5,
    roughness: 0.25,
    reflectance: 0.04,
    exponent: 6,
  });
  for (const text of [
    data().replace('m_dynamicParams = []', 'm_dynamicParams = [ expression ]'),
    data().replace('m_dynamicTextureParams = []', 'm_dynamicTextureParams = [ expression ]'),
    data().replace('g_flWaterFogStrength', 'missing'),
    data().replace('F_REFRACTION', 'F_SIMPLE_SKYBOX'),
    data().replace('0.04', '100'),
    data().replace('g_vWaterFogColor', 'g_vColorTint'),
  ])
    assert.equal(decode(text).water, undefined);
  const dir = await mkdtemp(join(tmpdir(), 'cswatch-water-'));
  try {
    const write = (materials) => writeWaterBindings(dir, [{ materials }]);
    assert.deepEqual(await write([]), []);
    assert.deepEqual(await write([{ ...material, resource: 'materials/other.vmat_c' }]), []);
    assert.deepEqual(await write([material, { ...material, sha256: 'b'.repeat(64) }]), []);
    const [option, file] = await write([material, material]);
    assert.equal(option, '--water-bindings');
    assert.deepEqual((await readWaterBindings(file)).get(vmat.Name), material.water);
    await writeFile(file, JSON.stringify([{ ...material.water, exponent: 0 }]));
    await assert.rejects(readWaterBindings(file), /Invalid prepared water/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('water preparation replaces the fallback once and omits unverified or mismatched surfaces', () => {
  const d = new Document();
  const valid = d.createMaterial().setExtras({ vmat }).setBaseColorTexture(d.createTexture());
  const unrelated = d.createMaterial().setExtras({
    vmat: { Name: 'materials/qa/stone.vmat', ShaderName: 'csgo_lightmappedgeneric.vfx' },
  });
  const wrong = d
    .createMaterial()
    .setExtras({
      vmat: { ...vmat, FloatParams: { ...vmat.FloatParams, g_flFresnelExponent: 4 } },
      cswatch: { water: { schemaVersion: 1 } },
    })
    .setAlphaMode('BLEND');
  const prim = d.createPrimitive().setMaterial(valid).setAttribute('COLOR_0', d.createAccessor());
  const mesh = d
    .createMesh()
    .addPrimitive(prim)
    .addPrimitive(d.createPrimitive().setMaterial(unrelated))
    .addPrimitive(d.createPrimitive().setMaterial(wrong));
  d.createScene().addChild(d.createNode().setMesh(mesh));
  const eligible = bindPreparedWater(d, new Map([[vmat.Name, material.water]]));
  assert.deepEqual(
    inspectMapGraphics(d, eligible)
      .materials.filter((r) => r.feature === 'water')
      .map((r) => [r.action, r.coverage, r.primitives]),
    [
      ['approximated_water', 'approximated', 1],
      ['omit_unsupported_refraction', 'omitted', 1],
    ],
  );
  assert.deepEqual(
    filterMapWorldMaterials(d, eligible).map((r) => r.action),
    ['surface', 'approximated_water', 'omit_unsupported_refraction'],
  );
  assert.equal(mesh.listPrimitives().length, 2);
  assert.equal(prim.getAttribute('COLOR_0'), null);
  assert.equal(valid.getAlphaMode(), 'BLEND');
  assert.equal(valid.getRoughnessFactor(), 0.25);
  assert.equal(valid.getMetallicFactor(), 0);
  assert.equal(valid.getBaseColorTexture(), null);
  assert.ok(Math.abs(valid.getExtension('KHR_materials_ior').getIOR() - 1.5) < 1e-8);
  assert.ok(Math.abs(valid.getBaseColorFactor()[1] - 0.21404114) < 1e-7);
  assert.equal(valid.getBaseColorFactor()[3], 1 / 3);
  assert.deepEqual(unrelated.listExtensions(), []);
  assert.equal(unrelated.getAlphaMode(), 'OPAQUE');
});

test('an unused water dependency adds no material extension to a dry world', () => {
  const document = new Document();
  document.createMaterial().setExtras({ vmat });
  const bed = document.createMaterial();
  const mesh = document.createMesh().addPrimitive(document.createPrimitive().setMaterial(bed));
  document.createScene().addChild(document.createNode().setMesh(mesh));
  const prepared = bindPreparedWater(document, new Map([[vmat.Name, material.water]]));
  assert.equal(prepared.size, 0);
  assert.deepEqual(document.getRoot().listExtensionsUsed(), []);
  assert.deepEqual(filterMapWorldMaterials(document, prepared), [
    { shader: 'gltf', action: 'surface', primitives: 1 },
  ]);
});
