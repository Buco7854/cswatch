import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { inspectMapGrade } from './environment-metadata.mjs';
import { prepareMapGrade } from './prepare-map-grade.mjs';

const entity = (name, disable = false) => `
classname "post_processing_volume"
master true
startdisabled ${disable}
postprocessing resource_name:"lighting/postprocessing/${name}.vpost"
enableexposure true
minexposure 0.8
maxexposure 1.0
`;
const entities = `====0====${entity('disabled', true)}====1====${entity('authored')}`;
const lut = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const data = `
m_bHasTonemapParams = true
m_toneMapParams =
{
  m_flExposureBias = 0.0
  m_flShoulderStrength = 0.0
  m_flLinearStrength = 0.001
  m_flLinearAngle = 0.001
  m_flToeStrength = 1.0
  m_flToeNum = 1.0
  m_flToeDenom = 1.0
  m_flWhitePoint = 1.5
  m_flLuminanceSource = 0.0
  m_flExposureBiasShadows = 0.0
  m_flExposureBiasHighlights = 0.0
}
m_nColorCorrectionVolumeDim = 2
m_colorCorrectionVolumeData = #[${lut.toString('hex').match(/../g).join(' ')}]
m_bHasColorCorrection = true
`;

test('only the unique enabled master supplies the resource, exposure, curve and exact RGBA LUT', () => {
  const authored = inspectMapGrade(entities);
  assert.deepEqual(authored, {
    resource: 'lighting/postprocessing/authored.vpost_c',
    min: 0.8,
    max: 1,
  });
  assert.equal(inspectMapGrade(entities + '====2====' + entity('other')), null);
  assert.equal(inspectMapGrade('====0====' + entity('disabled', true)), null);
  assert.throws(() => inspectMapGrade('====0====' + entity('../escape')), /resource path/);
  const result = prepareMapGrade(authored, data);
  assert.deepEqual(result.lut, lut);
  assert.deepEqual(result.grade.lut, {
    size: 2,
    sha256: createHash('sha256').update(lut).digest('hex'),
  });
  assert.deepEqual(result.grade.exposure, { min: 0.8, max: 1, bias: 0 });
  assert.equal(result.grade.curve.whiteStops, 1.5);
});

test('declines unsupported, ambiguous, overlong and incomplete post-processing data', () => {
  const authored = inspectMapGrade(entities);
  for (const invalid of [
    data.replace('m_bHasColorCorrection = true', 'm_bHasColorCorrection = false'),
    data.replace('m_nColorCorrectionVolumeDim = 2', 'm_nColorCorrectionVolumeDim = 1000'),
    data.replace('1C 1D 1E 1F'.toLowerCase(), ''),
    data.replace('m_flLuminanceSource = 0.0', 'm_flLuminanceSource = 1.0'),
    data.replace('m_flToeDenom = 1.0', 'm_flToeDenom = 0.0'),
    data + 'm_bHasTonemapParams = true\n',
    data.repeat(1200),
  ])
    assert.throws(() => prepareMapGrade(authored, invalid));
});

test('extracts linear sun radiance and sky fill from a single static environment light', () => {
  const sunlight = `====2====
classname "light_environment"
enabled true
directlight 1
style 0
color [255, 223, 179]
brightness 3
skycolor [130, 205, 255]
skyintensity 1
`;
  const authored = inspectMapGrade(entities + sunlight);
  const { grade } = prepareMapGrade(authored, data);
  assert.equal(grade.lighting.sun[0], 3);
  assert.ok(Math.abs(grade.lighting.sun[1] - 2.213731) < 1e-6);
  assert.ok(Math.abs(grade.lighting.sun[2] - 1.352357) < 1e-6);
  assert.ok(Math.abs(grade.lighting.sky[0] - 0.223228) < 1e-6);
  assert.equal(grade.lighting.sky[2], 1);
  assert.equal(
    inspectMapGrade(entities + sunlight.replace('style 0', 'style 1')).lighting,
    undefined,
  );
  assert.throws(() =>
    prepareMapGrade(authored, data.replace('WhitePoint = 1.5', 'WhitePoint = 7')),
  );
});
