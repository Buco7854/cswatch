import assert from 'node:assert/strict';
import test from 'node:test';
import { mapSurface } from '../../frontend/src/map-availability.js';
const installed = {
  sample: false,
  requested2D: false,
  discovery: 'ready' as const,
  model: '/map-assets/de_qa/desktop/scene.glb',
  modelStatus: 'ready' as const,
  rendererFailed: false,
};
test('real map selection never treats replay positions as installed artwork', () => {
  assert.equal(mapSurface({ ...installed, model: null, modelStatus: 'missing' }), 'plot');
  assert.equal(
    mapSurface({ ...installed, discovery: 'missing', model: null, modelStatus: 'missing' }),
    'plot',
  );
  assert.equal(
    mapSurface({ ...installed, discovery: 'error', model: null, modelStatus: 'error' }),
    'plot',
  );
  assert.equal(
    mapSurface({ ...installed, model: null, discovery: 'pending', modelStatus: 'pending' }),
    'loading',
  );
});
test('actual model loading retains its loader, while failure/noWebGL use independently calibrated2D', () => {
  assert.equal(mapSurface({ ...installed, modelStatus: 'pending' }), '3d');
  assert.equal(mapSurface(installed), '3d');
  assert.equal(mapSurface({ ...installed, modelStatus: 'error' }), 'plot');
  assert.equal(mapSurface({ ...installed, rendererFailed: true }), 'plot');
  assert.equal(mapSurface({ ...installed, requested2D: true }), 'plot');
  assert.equal(
    mapSurface({ ...installed, modelStatus: 'ready', rendererFailed: false }),
    '3d',
    'new rendererattempt can recover after2D',
  );
});
test('explicit original internal practice remains an authored synthetic exception', () => {
  assert.equal(
    mapSurface({
      ...installed,
      sample: true,
      model: null,
      discovery: 'missing',
      modelStatus: 'missing',
    }),
    '3d',
  );
  assert.equal(mapSurface({ ...installed, sample: true, model: null, requested2D: true }), 'plot');
});
