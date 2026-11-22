import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, resample, weld } from '@gltf-transform/functions';
import sharp from 'sharp';
import {
  inspectMapEnvironment,
  inspectSkyCamera,
  inspectSkyMaterial,
  convertSkyFaces,
  prepareEnvironment,
  prepareCubemapFog,
} from './prepare-environment.mjs';
import {
  sourceRotate,
  skyWorldMatrix,
  sourceCubemapSample,
  viewerCubeDirection,
  linearToSrgb,
} from './environment-space.mjs';

const mainText = `====0====
classname "skybox_reference"
targetmapname "maps/prefabs/de_test/sky.vmap"
origin "0 0 0"
angles "0 0 0"
scales "1 1 1"
====1====
classname "env_sky"
skyname "materials/skybox/test.vmat"
angles "0 0 0"
brightnessscale 1
tint_color [255,255,255,255]
====2====
classname "env_cubemap_fog"
cubemapfogstartdistance 384
cubemapfogenddistance 8000
startdisabled false
`;
const skyText = `====0====
classname "sky_camera"
origin "5208 -968 44.5"
scale 16
====1====
classname "env_sky"
skyname "materials/skybox/test.vmat"
angles "0 146.25 0"
brightnessscale 1
tint_color [255,255,255,255]
`;
const materialText = `m_name = "g_tSkyTexture"
m_pValue = resource:"materials/skybox/test.vtex"
m_name = "g_flBrightnessExposureBias"
m_flValue = 0.765
m_name = "g_flRenderOnlyExposureBias"
m_flValue = 0.0`;
const sourceFaces = ['rt', 'lf', 'bk', 'ft', 'up', 'dn'];
const fogMainText = mainText
  .replace(
    'skyname "materials/skybox/test.vmat"',
    'targetname "authored_sky"\nskyname "materials/skybox/test.vmat"',
  )
  .replace(
    'cubemapfogenddistance 8000',
    `cubemapfogenddistance 8000
cubemapfogsource "1"
cubemapfogskyentity "authored_sky"
cubemapfogfalloffexponent 1.6
cubemapfoglodbiase 0.8
cubemapfogmaxopacity 1
cubemapheightfog true
cubemapfogheightstart -500
cubemapfogheightend 5000
cubemapfogheightexponent 1`,
  );
function authoredFog(text = fogMainText, sky = skyText) {
  const main = inspectMapEnvironment(text),
    camera = inspectSkyCamera(sky);
  return prepareCubemapFog({
    main,
    camera,
    material: inspectSkyMaterial(materialText),
    effective: camera.skyEnvironment ?? main,
  });
}
const reference = { origin: [0, 0, 0], angles: [0, 0, 0], scales: [1, 1, 1] };
function near(actual, expected) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, i) =>
    assert.ok(Math.abs(value - expected[i]) < 1e-7, `${value} != ${expected[i]}`),
  );
}
async function scratch(t) {
  const root = await mkdtemp(join(tmpdir(), 'cswatch-env-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function faces(root) {
  const paths = {};
  for (const [index, face] of sourceFaces.entries()) {
    const data = Buffer.alloc(4 * 4 * 3);
    for (let y = 0; y < 4; y++)
      for (let x = 0; x < 4; x++) {
        const at = (y * 4 + x) * 3;
        data[at] = 20 + index * 25 + x * 3;
        data[at + 1] = 40 + y * 10;
        data[at + 2] = 128;
      }
    paths[face] = join(root, face + '.png');
    await writeFile(
      paths[face],
      await sharp(data, { raw: { width: 4, height: 4, channels: 3 } })
        .png()
        .toBuffer(),
    );
  }
  return paths;
}
async function model(path, name, textured = false) {
  const document = new Document(),
    buffer = document.createBuffer();
  const position = document
    .createAccessor()
    .setType('VEC3')
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
    .setBuffer(buffer);
  const mesh = document
    .createMesh(name)
    .addPrimitive(document.createPrimitive().setAttribute('POSITION', position));
  if (textured) {
    const image = await sharp({
      create: { width: 3072, height: 1024, channels: 4, background: '#806b55' },
    })
      .png()
      .toBuffer();
    const texture = document
      .createTexture('source-map-texture')
      .setImage(image)
      .setMimeType('image/png');
    mesh.listPrimitives()[0].setMaterial(document.createMaterial().setBaseColorTexture(texture));
  }
  document.createScene().addChild(document.createNode(name).setMesh(mesh));
  await new NodeIO().write(path, document);
}

test('landscape intermediate budgets images before binary encoding and leaves source geometry and files intact', async (t) => {
  const root = await scratch(t),
    main = join(root, 'main.glb'),
    sky = join(root, 'sky.glb'),
    output = join(root, 'prepared');
  await mkdir(output);
  await model(main, 'playable', true);
  await model(sky, 'landscape');
  const original = await readFile(main),
    stages = [];
  const result = await prepareEnvironment({
    map: 'de_test',
    assetVersion: 'test-1',
    source: 'Synthetic fixtures',
    mainGltf: main,
    skyGltf: sky,
    mainEntities: mainText,
    skyEntities: skyText,
    materialData: materialText,
    skyFaces: await faces(root),
    output,
    onProgress: (stage) => stages.push(stage),
  });
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS),
    doc = await io.read(result.mergedInput);
  const texture = doc.getRoot().listTextures()[0];
  const metadata = await sharp(texture.getImage()).metadata();
  assert.equal(metadata.format, 'webp');
  assert.equal(metadata.width, 2048);
  assert.ok(metadata.height <= 1024);
  assert.deepEqual(
    Array.from(
      doc
        .getRoot()
        .listMeshes()
        .find((mesh) => mesh.getName() === 'playable')
        .listPrimitives()[0]
        .getAttribute('POSITION')
        .getArray(),
    ),
    [0, 0, 0, 1, 0, 0, 0, 1, 0],
  );
  assert.deepEqual(await readFile(main), original);
  assert.ok(result.report.intermediateTextureBudget.residentBaseRGBABytes <= 512 * 1024 ** 2);
  assert.deepEqual(stages, [
    'read-main',
    'read-sky',
    'budget-textures',
    'encode-geometry',
    'complete',
  ]);
});

test('bounded entity inspection preserves actual prefab sky precedence and fog evidence', () => {
  const main = inspectMapEnvironment([mainText]),
    camera = inspectSkyCamera([skyText]);
  assert.equal(main.skyMap, 'maps/prefabs/de_test/sky.vmap');
  assert.equal(camera.skyEnvironment.skyMaterial, 'materials/skybox/test.vmat');
  assert.deepEqual(camera.skyEnvironment.angles, [0, 146.25, 0]);
  assert.equal(main.fog[0].cubemapfogstartdistance, 384);
  assert.deepEqual(inspectSkyMaterial(materialText), {
    texture: 'materials/skybox/test.vtex',
    exposureBias: 0.765,
    renderExposureBias: 0,
  });
  assert.throws(
    () => inspectMapEnvironment([mainText, mainText.replace('angles "0 0 0"', 'angles "0 20 0"')]),
    /Ambiguous/,
  );
  assert.throws(
    () => inspectMapEnvironment(mainText.replace('maps/prefabs', 'maps//prefabs')),
    /resource path/,
  );
  assert.throws(
    () =>
      inspectMapEnvironment(
        mainText.replace(
          'classname "skybox_reference"',
          'classname "skybox_reference"\nparentname "moving"',
        ),
      ),
    /Parented/,
  );
  assert.throws(() => inspectSkyCamera(skyText.repeat(100000)), /text limit/);
  assert.throws(() => inspectSkyMaterial(materialText + materialText), /exactly one/);
});

test('Source integer sky scale and transforms preserve S2V meters basis without double scale', () => {
  near(
    skyWorldMatrix(reference, { origin: [5208, -968, 44.5], scale: 16 }).slice(12, 15),
    [393.3952, -18.0848, -2116.5312],
  );
  near(
    skyWorldMatrix(reference, { origin: [-8, -308, 202], scale: 16 }).slice(12, 15),
    [125.1712, -82.0928, 3.2512],
  );
  near(
    skyWorldMatrix(reference, { origin: [0, 0, 0], scale: 16 }).slice(0, 12),
    [16, 0, 0, 0, 0, 16, 0, 0, 0, 0, 16, 0],
  );
  near(sourceRotate([1, 0, 0], [90, 0, 0]), [0, 0, -1]);
  near(
    sourceRotate(sourceRotate([4, 8, -3], [34, 146.25, 19]), [34, 146.25, 19], true),
    [4, 8, -3],
  );
  const placed = skyWorldMatrix(
    { origin: [10, 20, 30], angles: [0, 90, 0], scales: [1, 1, 1] },
    { origin: [1, 2, 3], scale: 16 },
  );
  // A separately exported sky camera must land exactly on the main-world
  // reference after the prefab's rigid placement and magnification compose.
  const localCamera = [2, 3, 1].map((value) => value * 0.0254);
  near(
    [0, 1, 2].map(
      (axis) =>
        placed[axis] * localCamera[0] +
        placed[4 + axis] * localCamera[1] +
        placed[8 + axis] * localCamera[2] +
        placed[12 + axis],
    ),
    [20, 30, 10].map((value) => value * 0.0254),
  );
  assert.equal(inspectSkyCamera(skyText.replace('scale 16', 'scale 0')).scale, 1);
  assert.throws(
    () => skyWorldMatrix({ ...reference, scales: [2, 2, 2] }, { origin: [0, 0, 0], scale: 16 }),
    /Unsupported/,
  );
});

test('Three cube slot rays and asymmetric face coordinates match primary S2V convention', () => {
  const expected = {
    px: ['lf', 0.8, 0.7],
    nx: ['rt', 0.2, 0.3],
    py: ['up', 0.7, 0.2],
    ny: ['dn', 0.3, 0.8],
    pz: ['ft', 0.7, 0.2],
    nz: ['bk', 0.3, 0.8],
  };
  for (const [slot, [face, u, v]] of Object.entries(expected)) {
    const sample = sourceCubemapSample(viewerCubeDirection(slot, 0.3, 0.2));
    assert.equal(sample.face, face);
    near([sample.u, sample.v], [u, v]);
  }
  assert.equal(sourceCubemapSample([1, 0, 0], [0, 90, 0]).face, 'ft');
  assert.equal(sourceCubemapSample([1, 0, 0], [0, 146.25, 0]).face, 'lf');
  assert.equal(sourceCubemapSample([1, 0, 0], [0, 90, 0], [0, -90, 0]).face, 'rt');
});

test('authored cubemap fog keeps Source falloff, meter ranges, exposure and relative cube rotation', () => {
  const prepared = authoredFog();
  assert.equal(prepared.reason, null);
  const fog = prepared.fog;
  assert.equal(fog.blend, 'multiply');
  near(
    [fog.start, fog.end, fog.exponent, fog.lodBias, fog.maxOpacity, fog.brightness],
    [9.7536, 203.2, 1.6, 0.8, 1, 2 ** 0.765],
  );
  near([fog.height.start, fog.height.end, fog.height.exponent], [-12.7, 127, 1]);
  const angle = (146.25 * Math.PI) / 180;
  near(fog.rotation, [
    Math.cos(angle),
    0,
    -Math.sin(angle),
    0,
    1,
    0,
    Math.sin(angle),
    0,
    Math.cos(angle),
  ]);
  // A prepared visible sky with different authored yaw must sample the exact
  // same source texel as the original fog's own yaw, not the visible background.
  for (const ray of [
    [1, 0.2, -0.5],
    [-1, 0.3, 0.2],
    [0.2, 1, 0.4],
    [0.1, -0.8, -1],
  ]) {
    const rotated = [0, 1, 2].map(
      (axis) =>
        fog.rotation[axis] * ray[0] +
        fog.rotation[axis + 3] * ray[1] +
        fog.rotation[axis + 6] * ray[2],
    );
    const actual = sourceCubemapSample(rotated, [0, 146.25, 0]),
      expected = sourceCubemapSample(ray, [0, 0, 0]);
    assert.equal(actual.face, expected.face);
    near([actual.u, actual.v], [expected.u, expected.v]);
  }
});

test('native height direction, explicit disabling and proven opacity default remain distinct', () => {
  assert.deepEqual(
    authoredFog(fogMainText.replace('cubemapheightfog true', 'cubemapheightfog false')).fog.height,
    null,
  );
  const reversed = authoredFog(
    fogMainText
      .replace('cubemapfogheightstart -500', 'cubemapfogheightstart 5000')
      .replace('cubemapfogheightend 5000', 'cubemapfogheightend -500'),
  ).fog.height;
  near([reversed.start, reversed.end], [127, -12.7]);
  const withoutHeight = authoredFog(
    fogMainText
      .replace('cubemapfogheightend 5000', 'cubemapfogheightwidth 5500')
      .replace('cubemapheightfog true\n', '')
      .replace('cubemapfogmaxopacity 1\n', ''),
  ).fog;
  assert.equal(withoutHeight.maxOpacity, 1);
  near([withoutHeight.height.start, withoutHeight.height.end], [-12.7, 127]);
});

test('missing, ambiguous, differently sourced or out-of-contract fog stays unavailable without guessed values', () => {
  for (const text of [
    mainText,
    fogMainText.replace('cubemapfoglodbiase 0.8', ''),
    fogMainText.replace('cubemapfogskyentity "authored_sky"', 'cubemapfogskyentity "other"'),
    fogMainText.replace('cubemapfogsource "1"', 'cubemapfogsource "0"'),
    fogMainText.replace('cubemapfogmaxopacity 1', 'cubemapfogmaxopacity 2'),
  ]) {
    const result = authoredFog(text);
    assert.equal(result.fog, null);
    assert.ok(result.reason);
  }
  assert.equal(
    authoredFog(fogMainText, skyText.replace('[255,255,255,255]', '[128,255,255,255]')).fog,
    null,
  );
  const double = fogMainText + '\n====9====\nclassname "env_cubemap_fog"\n';
  assert.match(authoredFog(double).reason, /unique/);
});

test('CPU conversion rotates asymmetric pixels, converts clamped linear values to sRGB and applies authored tint', async (t) => {
  const root = await scratch(t),
    paths = await faces(root);
  const output = await convertSkyFaces(paths, { angles: [0, 0, 0], tint: [255, 255, 255] });
  const mapping = {
    px: ['lf', (x, y) => [3 - y, 3 - x]],
    nx: ['rt', (x, y) => [y, x]],
    py: ['up', (x, y) => [3 - x, y]],
    ny: ['dn', (x, y) => [x, 3 - y]],
    pz: ['ft', (x, y) => [3 - x, y]],
    nz: ['bk', (x, y) => [x, 3 - y]],
  };
  for (const [slot, [source, lookup]] of Object.entries(mapping)) {
    const image = await sharp(output.outputs[slot]).raw().toBuffer();
    for (const [x, y] of [
      [0, 0],
      [3, 0],
      [0, 3],
      [3, 3],
    ]) {
      const [sx, sy] = lookup(x, y),
        index = sourceFaces.indexOf(source),
        at = (y * 4 + x) * 3;
      near(
        [...image.subarray(at, at + 3)],
        [20 + index * 25 + sx * 3, 40 + sy * 10, 128].map((value) =>
          Math.round(linearToSrgb(value / 255) * 255),
        ),
      );
    }
  }
  const tinted = await convertSkyFaces(paths, { angles: [0, 0, 0], tint: [0, 255, 255] });
  assert.equal((await sharp(tinted.outputs.px).raw().toBuffer())[0], 0);
  const rotated = await convertSkyFaces(paths, { angles: [0, 146.25, 0], tint: [255, 255, 255] });
  assert.notDeepEqual(rotated.outputs.nx, output.outputs.nx);
});

test('actual GLB merge keeps separately-rendered tagged landscape through map optimizer transforms and preserves overview', async (t) => {
  const root = await scratch(t),
    main = join(root, 'main.glb'),
    sky = join(root, 'sky.glb'),
    output = join(root, 'prepared');
  await mkdir(output);
  await writeFile(join(output, 'overview.png'), 'existing overview');
  await model(main, 'playable');
  await model(sky, 'landscape');
  const result = await prepareEnvironment({
    map: 'de_test',
    assetVersion: 'test-1',
    source: 'Synthetic fixtures',
    mainGltf: main,
    skyGltf: sky,
    mainEntities: fogMainText,
    skyEntities: skyText,
    materialData: materialText,
    skyFaces: await faces(root),
    output,
  });
  const document = await new NodeIO().read(result.mergedInput);
  await document.transform(dedup(), prune(), resample(), weld());
  const optimized = await new NodeIO().readBinary(await new NodeIO().writeBinary(document));
  const tag = optimized
    .getRoot()
    .listNodes()
    .find((node) => node.getExtras().cswatch?.kind === 'skybox');
  assert.equal(tag.getName(), 'cswatch_skybox');
  assert.deepEqual(tag.getExtras(), { cswatch: { kind: 'skybox', schemaVersion: 1 } });
  near(tag.getTranslation(), [393.3952, -18.0848, -2116.5312]);
  near(tag.getScale(), [16, 16, 16]);
  assert.equal(tag.listChildren()[0].getName(), 'landscape');
  assert.ok(tag.listChildren()[0].getMesh());
  assert.ok(
    optimized
      .getRoot()
      .listNodes()
      .some((node) => node.getName() === 'playable'),
  );
  const metadata = JSON.parse(
    await readFile(join(result.environmentPath, 'environment.json'), 'utf8'),
  );
  assert.equal(metadata.schemaVersion, 2);
  assert.equal(Object.hasOwn(metadata, 'grade'), false);
  assert.equal(metadata.landscape, true);
  assert.equal(metadata.sky.brightness, 2 ** 0.765);
  assert.equal(metadata.fog.maxOpacity, 1);
  near([metadata.fog.height.start, metadata.fog.height.end], [-12.7, 127]);
  assert.equal(Object.keys(metadata.sky.faces).length, 6);
  assert.equal(await readFile(join(output, 'overview.png'), 'utf8'), 'existing overview');
  await assert.rejects(
    prepareEnvironment({
      map: 'de_test',
      assetVersion: 'test-1',
      source: 'Synthetic fixtures',
      mainGltf: main,
      skyGltf: sky,
      mainEntities: mainText,
      skyEntities: skyText,
      materialData: materialText,
      skyFaces: await faces(root),
      output,
    }),
    /EEXIST/,
  );
});

test('invalid local geometry references or symlinks fail closed and remove only the new environment stage', async (t) => {
  const root = await scratch(t),
    output = join(root, 'prepared');
  await mkdir(output);
  await writeFile(join(output, 'overview.png'), 'safe');
  const main = join(root, 'bad.gltf'),
    sky = join(root, 'sky.glb');
  await model(sky, 'sky');
  const config = {
    map: 'de_test',
    assetVersion: 'test',
    source: 'Synthetic fixtures',
    mainGltf: main,
    skyGltf: sky,
    mainEntities: mainText,
    skyEntities: skyText,
    materialData: materialText,
    skyFaces: await faces(root),
    output,
  };
  for (const uri of [
    'https://example.com/model.bin',
    '../secret.bin',
    '%2e%2e/secret.bin',
    'file:///etc/passwd',
  ]) {
    await writeFile(
      main,
      JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri, byteLength: 4 }] }),
    );
    await assert.rejects(prepareEnvironment(config), /local paths/);
    assert.deepEqual((await readdir(output)).sort(), ['environments', 'overview.png']);
  }
  await symlink(sky, join(root, 'link.bin'));
  await writeFile(
    main,
    JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri: 'link.bin', byteLength: 4 }] }),
  );
  await assert.rejects(prepareEnvironment(config), /ELOOP/);
  assert.equal(await readFile(join(output, 'overview.png'), 'utf8'), 'safe');
});
