import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { DemoReader } from 'cs2parser';
import { observeSmokeTracks } from '../src/smoke-state.js';
import { validSmokeTracks } from '../../shared/smoke-state.mjs';

const prefix = 'CSmokeGrenadeProjectile.';
const frame = (sequence: number) => Uint8Array.of(sequence, 0, 3, 0, 0, 0, 0);

function recording() {
  const reader = Object.assign(new EventEmitter(), {
    currentTick: 4,
    header: { patch_version: 13984 },
    entities: {
      33: {
        properties: {
          [prefix + 'm_bDidSmokeEffect']: true,
          [prefix + 'm_VoxelFrameData']: frame(0),
          [prefix + 'm_vSmokeDetonationPos']: [100, 200, 50],
          [prefix + 'm_vSmokeColor']: [75, 127, 155],
        },
      },
    },
  });
  const finish = observeSmokeTracks(reader as unknown as DemoReader, 1000, 64);
  reader.emit('entitycreated', [33, 1, 0, 'CSmokeGrenadeProjectile', 8]);
  reader.emit('tickend');
  return { reader, properties: reader.entities[33].properties, finish };
}

test('smoke journals retain real update offsets and expire inactive projectile state', () => {
  const { reader, properties, finish } = recording();
  reader.currentTick = 10;
  properties[prefix + 'm_VoxelFrameData'] = Uint8Array.of(...frame(0), ...frame(1));
  reader.emit('tickend');
  reader.currentTick = 600;
  reader.emit('entitydeleted', 33);
  const smoke = finish(true);
  assert.ok(smoke);
  assert.equal(smoke.length, 1);
  assert.equal(smoke[0].entity, 33);
  assert.equal(smoke[0].serial, 8);
  assert.deepEqual(smoke[0].updates, [
    [4, 7],
    [10, 14],
  ]);
  assert.equal(smoke[0].end, 43);
  assert.equal(validSmokeTracks(smoke, 1000), true);
  assert.equal(validSmokeTracks([{ ...smoke[0], updates: [[4, 15]] }], 1000), false);
});

test('changed journal prefixes and unsupported layouts preserve fallback', () => {
  const { reader, properties, finish } = recording();
  reader.currentTick = 10;
  properties[prefix + 'm_VoxelFrameData'] = Uint8Array.of(...frame(1), ...frame(0));
  reader.emit('tickend');
  assert.equal(finish(true), undefined);
});
