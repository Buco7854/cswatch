import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reviewEventArtwork } from '../../frontend/src/review-event-artwork.js';

test('review artwork preserves native demo kill/death and distinct recorded objective meanings', () => {
  const registry = JSON.parse(
    readFileSync(new URL('../../shared/equipment-icons.json', import.meta.url), 'utf8'),
  ).items;
  assert.equal(registry[reviewEventArtwork({ type: 'kill' })!], 'icons/ui/crosshair_circle.svg');
  assert.equal(registry[reviewEventArtwork({ type: 'death' })!], 'icons/ui/kill.svg');
  assert.equal(reviewEventArtwork({ type: 'elimination' }), 'demodeath');
  const plant = reviewEventArtwork({ type: 'plant' }),
    defuse = reviewEventArtwork({ type: 'defuse' }),
    explosion = reviewEventArtwork({ type: 'explosion' });
  assert.equal(registry[plant!], 'hud/teamcounter/teamcounter_bomb-planted.svg');
  assert.equal(registry[defuse!], 'hud/teamcounter/teamcounter_bomb-planted-defused.svg');
  assert.equal(registry[explosion!], 'hud/teamcounter/killtype_blast.svg');
  assert.equal(new Set([plant, defuse, explosion]).size, 3);
});

test('round winners and recorded utility select only supported semantic artwork', () => {
  assert.equal(reviewEventArtwork({ type: 'round-end', team: 3 }), 'teamct');
  assert.equal(reviewEventArtwork({ type: 'round-end', team: 2 }), 'teamt');
  assert.equal(reviewEventArtwork({ type: 'round-end' }), 'roundmarker');
  assert.equal(reviewEventArtwork({ type: 'throw', weapon: 'weapon_flashbang' }), 'flashbang');
  assert.equal(reviewEventArtwork({ type: 'throw', weapon: 'SmokeGrenade' }), 'smokegrenade');
  assert.equal(reviewEventArtwork({ type: 'throw' }), undefined);
  assert.equal(reviewEventArtwork({ type: 'throw', weapon: 'weapon_ak47' }), undefined);
});
