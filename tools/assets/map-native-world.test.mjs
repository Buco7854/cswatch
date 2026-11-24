import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Document } from '@gltf-transform/core';
import { inspectWorldLightmaps } from './install-map-baked-lighting.mjs';
import { inspectGradientFog, inspectSunShadowChannel } from './environment-metadata.mjs';
import { filterMapWorldMaterials } from './map-world-materials.mjs';
import { preserveAlphaCoverage } from './texture-budget.mjs';
import { bindVertexLighting } from './prepare-baked-lighting.mjs';
import { embeddedMapDraws, nativeMaterialLightmapSlot } from './native-map-lighting-layout.mjs';

test('lightmaps use the actual world atlas and authored stationary sun slot', () => {
  const prefix = 'maps/de_original';
  const roles = ['irradiance', 'direct_light_shadows', 'directional_irradiance'];
  const compiled = `{
\tm_builderParams =
\t{
\t\tm_nLightmapVersionNumber = 0
\t}
\tm_worldLightingInfo =
\t{
\t\tm_nLightmapVersionNumber = 8
\t\tm_nLightmapGameVersionNumber = 2
\t\tm_bHasLightmaps = true
\t\tm_vLightmapUvScale = [ 1.25, 0.75 ]
\t\tm_lightMaps =
\t\t[
${roles.map((name) => `\t\t\tresource:"${prefix}/lightmaps/${name}.vtex",`).join('\n')}
\t\t]
\t\tm_bakedShadows =
\t\t[
\t\t\t{
\t\t\t\tm_nShadowChannel = 2
\t\t\t},
\t\t]
\t}
}`;
  const lane = inspectSunShadowChannel(
    '====0====\nclassname "light_environment"\nbakedshadowindex "2"\n',
  );
  assert.equal(lane, 2);
  assert.equal(inspectSunShadowChannel('====0====\nclassname "light_environment"\n'), null);
  assert.equal(
    inspectSunShadowChannel('====0====\nclassname "light_environment"\nbakedshadowindex 4\n'),
    undefined,
  );
  assert.deepEqual(inspectWorldLightmaps(compiled, prefix, lane), {
    resources: roles.map((name) => `${prefix}/lightmaps/${name}.vtex_c`),
    uvScale: [1.25, 0.75],
    sunChannel: 2,
  });
  assert.equal(
    inspectWorldLightmaps(compiled, prefix, 0).proof.reason,
    'unsupported_sun_shadow_binding',
  );
  assert.equal(
    inspectWorldLightmaps(compiled, 'maps/de_other', lane).proof.reason,
    'missing_lightmap_resource',
  );
  assert.equal(
    inspectWorldLightmaps(compiled.replace('Number = 2', 'Number = 5'), prefix, lane).proof.reason,
    'unsupported_lightmap_format',
  );
});

test('world filtering removes opaque effects from the landscape while preserving cutouts', () => {
  const document = new Document();
  const material = (name, shader, alphaMode, extra) =>
    document
      .createMaterial()
      .setAlphaMode(alphaMode)
      .setExtras({ vmat: { Name: name, ShaderName: shader + '.vfx' }, ...extra });
  const fog = material('materials/dev/black_simple.vmat', 'csgo_black_unlit', 'OPAQUE');
  const leaves = material('materials/plants/leaves.vmat', 'csgo_foliage', 'MASK')
    .setAlphaCutoff(0.65)
    .setBaseColorTexture(document.createTexture());
  const effect = material('materials/effects/dust.vmat', 'csgo_effects', 'OPAQUE');
  const filtered = document.createPrimitive().setMaterial(effect);
  const landscape = document
    .createNode()
    .setExtras({ cswatch: { kind: 'skybox' } })
    .setMesh(document.createMesh().addPrimitive(filtered));
  document.createScene().addChild(landscape);
  document
    .createMesh()
    .addPrimitive(document.createPrimitive().setMaterial(fog))
    .addPrimitive(document.createPrimitive().setMaterial(leaves));
  const report = filterMapWorldMaterials(document);
  assert.equal(landscape.getMesh(), null);
  assert.equal(leaves.getAlphaCutoff(), 0.65);
  assert.equal(leaves.getBaseColorTextureInfo().getMinFilter(), 9987);
  assert.deepEqual(
    report.map(({ action }) => action),
    ['fog_surface', 'omit_effect', 'cutout'],
  );
});

test('static gradient fog uses authored distance, color and landscape height', () => {
  const entity = `====0====
classname "env_gradient_fog"
fogstart 500
fogend 15000
fogfalloffexponent 2
heightfog true
fogstartheight 200
fogendheight -100
fogverticalexponent 1
fogcolor [ 128, 64, 255 ]
fogstrength 2
fogmaxopacity 0.75
`;
  const matrix = [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 3, 0, 1];
  assert.deepEqual(inspectGradientFog(entity, matrix), {
    fog: {
      start: 500 * 2 * 0.0254,
      end: 15000 * 2 * 0.0254,
      exponent: 2,
      height: { start: 200 * 2 * 0.0254 + 3, end: -100 * 2 * 0.0254 + 3, exponent: 1 },
      color: [256 / 255, 128 / 255, 2],
      maxOpacity: 0.75,
    },
  });
  assert.equal(
    inspectGradientFog(entity + 'startdisabled true\n').reason,
    'no_authored_gradient_fog',
  );
  assert.equal(
    inspectGradientFog(entity + 'gradientfogtexture custom.vtex\n').reason,
    'unsupported_gradient_fog',
  );
});

test('a resized foliage mask retains coverage at the material cutoff', () => {
  const source = Uint8Array.from([0, 0, 0, 0, 240, 240, 240, 240]);
  const rgba = Uint8Array.from([5, 6, 7, 0, 5, 6, 7, 70, 5, 6, 7, 100, 5, 6, 7, 200]);
  preserveAlphaCoverage(source, rgba, 0.5);
  assert.equal([rgba[3], rgba[7], rgba[11], rgba[15]].filter((alpha) => alpha >= 128).length, 2);
  assert.equal(rgba[0], 5);
});

test('a compiled COLOR1 stream binds irradiance while ordinary vertex tint stays on PBR', () => {
  const document = new Document(),
    buffer = document.createBuffer();
  const positions = document
    .createAccessor()
    .setType('VEC3')
    .setBuffer(buffer)
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
  const source = document
    .createAccessor()
    .setType('VEC4')
    .setBuffer(buffer)
    .setArray(Uint8Array.from([255, 128, 0, 40, 50, 60, 70, 80, 100, 120, 130, 140]))
    .setNormalized(true);
  const material = document.createMaterial().setExtras({
    vmat: { Name: 'materials/qa/concrete.vmat', ShaderName: 'csgo_vertexlitgeneric.vfx' },
  });
  const indices = document
    .createAccessor()
    .setType('SCALAR')
    .setBuffer(buffer)
    .setArray(Uint16Array.from([0, 1, 2]));
  const native = document
    .createPrimitive()
    .setMaterial(material)
    .setIndices(indices)
    .setAttribute('POSITION', positions)
    .setAttribute('_COLOR_1', source);
  const tinted = document
    .createPrimitive()
    .setMaterial(material)
    .setAttribute('POSITION', positions)
    .setAttribute('COLOR_0', source);
  const unverified = document
    .createPrimitive()
    .setMaterial(material)
    .setIndices(indices)
    .setAttribute('POSITION', positions)
    .setAttribute('_COLOR_1', source);
  document.createMesh('qa.meshset_0').addPrimitive(native).addPrimitive(tinted);
  document.createMesh('unverified.meshset_0').addPrimitive(unverified);
  const proof = new Map([['qa.meshset_0:materials/qa/concrete.vmat:3:3', 'vertex']]);
  assert.equal(bindVertexLighting(document, proof), 1);
  assert.equal(native.getMaterial().getExtras().cswatch.vertexLighting, true);
  assert.equal(tinted.getMaterial(), material);
  assert.equal(unverified.getMaterial(), material);
});

test('compiled draw metadata distinguishes a third lightmap UV from a second ordinary UV', () => {
  const slot = (name, type, index, format) => ({ name, type, index, format });
  const input = [
    slot('vPosition', 'POSITION', 0, 6),
    slot('vTexCoord', 'TEXCOORD', 0, 16),
    slot('vSecondUV', 'TEXCOORD', 1, 16),
    slot('vLightmapUV', 'TEXCOORD', 3, 35),
    slot('vBlend', 'TEXCOORD', 4, 28),
    slot('vColor', 'COLOR', 0, 28),
    slot('vPerVertexLighting', 'COLOR', 1, 28),
  ];
  const element = (indent, fields) =>
    `${indent}{\n${Object.entries(fields)
      .map(([key, value]) => `${indent}\t${key} = ${value}\n`)
      .join('')}${indent}},\n`;
  const layout = input
    .map(({ type, index, format }) =>
      element('\t'.repeat(6), {
        m_pSemanticName: `"${type}"`,
        m_nSemanticIndex: index,
        m_Format: format,
        m_nSlotType: '"RENDER_SLOT_PER_VERTEX"',
      }),
    )
    .join('');
  const control = `\t-- Block: MDAT  Size: 280 bytes\n--- Data for block "CTRL" ---\n\tembedded_meshes =\n\t[\n\t\t{\n\t\t\tm_Name = "meshset_0"\n\t\t\tm_nDataBlock = 0\n\t\t\tm_vertexBuffers =\n\t\t\t[\n\t\t\t\t{\n\t\t\t\t\tm_nElementCount = 8\n\t\t\t\t\tm_inputLayoutFields =\n\t\t\t\t\t[\n${layout}\t\t\t\t\t]\n\t\t\t\t},\n\t\t\t]\n\t\t},\n\t]`;
  const mesh = `--- Data for block "MDAT" ---\n\tm_sceneObjects =\n\t[\n\t\t{\n\t\t\tm_drawCalls =\n\t\t\t[\n\t\t\t\t{\n\t\t\t\t\tm_nIndexCount = 12\n\t\t\t\t\tm_material = resource:"materials/qa/plaster.vmat"\n\t\t\t\t\tm_bHasBakedLightingFromLightMap = true\n\t\t\t\t\tm_vertexBuffers =\n\t\t\t\t\t[\n\t\t\t\t\t\t{\n\t\t\t\t\t\t\tm_hBuffer = 0\n\t\t\t\t\t\t},\n\t\t\t\t\t]\n\t\t\t\t},\n\t\t\t]\n\t\t},\n\t]`;
  const signature = `--- Data for block "INSG" ---\n\tm_elems =\n\t[\n${input
    .map(({ name, type, index }) =>
      element('\t\t', {
        m_pName: `"${name}"`,
        m_pD3DSemanticName: `"${type}"`,
        m_nD3DSemanticIndex: index,
      }),
    )
    .join('')}\t]`;
  const { records } = embeddedMapDraws(control, mesh);
  assert.deepEqual(embeddedMapDraws(control + '\n' + mesh).records, records);
  assert.deepEqual(embeddedMapDraws(mesh + '\n' + control).records, records);
  assert.equal(embeddedMapDraws(control + '\n' + mesh + '\n' + mesh), undefined);
  assert.equal(embeddedMapDraws(control), undefined);
  assert.equal(embeddedMapDraws(control + '\n' + mesh + ' '.repeat(1024 ** 2)), undefined);
  assert.deepEqual(records, [
    {
      material: 'materials/qa/plaster.vmat',
      indices: 12,
      vertices: 8,
      slots: [0, 1, 3],
      atlas: true,
    },
  ]);
  assert.equal(records[0].slots.indexOf(nativeMaterialLightmapSlot(signature)), 2);
  assert.equal(
    embeddedMapDraws(control, mesh.replace('= true', '= false')).records[0].atlas,
    false,
  );
  const vertex = mesh.replace('m_bHasBakedLightingFromLightMap = true', 'm_nFlags = 18');
  assert.equal(embeddedMapDraws(control, vertex).records[0].vertex, true);
  assert.equal(
    embeddedMapDraws(
      control,
      vertex.replace(
        'm_nFlags = 18',
        'm_bHasBakedLightingFromVertexStream = false\n\t\t\t\t\tm_nFlags = 18',
      ),
    ).records[0].vertex,
    undefined,
  );
});
