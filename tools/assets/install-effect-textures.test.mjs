import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSheet, effectTextureIds } from './install-effect-textures.mjs';
import {
  managedEffectDirectory,
  effectTextureRegistry,
} from '../../shared/effect-texture-bank.mjs';

test('decompiled sheets parse into bounded sequences of the texture’s own frames', () => {
  const sheet = parseSheet(
    'sequence 0\nclamp-extendlastframe\nframe fire-ground_seq0_0.png 1\nframe fire-ground_seq0_1.png 1\n\nsequence 1\nframe fire-ground_seq1_0.png 1\n',
    'fire-ground',
  );
  assert.deepEqual(sheet, [
    { frames: ['fire-ground_seq0_0.png', 'fire-ground_seq0_1.png'], clamp: true },
    { frames: ['fire-ground_seq1_0.png'], clamp: false },
  ]);
  assert.throws(() => parseSheet('sequence 0\nframe ../other_seq0_0.png 1\n', 'fire-ground'));
  assert.throws(() => parseSheet('sequence 0\n', 'fire-ground'));
  assert.throws(() =>
    parseSheet(
      Array.from({ length: 300 }, (_, i) => `sequence ${i}\nframe fire-ground_seq${i}.png 1`).join(
        '\n',
      ),
      'fire-ground',
    ),
  );
});

test('the effect bank is fixed official resources under a registry-hashed directory', () => {
  assert.match(managedEffectDirectory, /^effects-[a-f0-9]{64}$/);
  assert.deepEqual(effectTextureIds, Object.keys(effectTextureRegistry.items));
  for (const id of effectTextureIds)
    assert.match(effectTextureRegistry.items[id].source, /^materials\/[a-z0-9_/-]+\.vtex_c$/);
});
