import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import type { DemoReader } from 'cs2parser';
import type { CrosshairData } from '../../shared/crosshairs.js';
import { observeCrosshairs } from '../src/crosshairs.js';
import {
  recordedCrosshair,
  buildRecordedCrosshairTimeline,
  recordedCrosshairAt,
} from '../../frontend/src/recorded-crosshair.ts';
import { freeCameraAction } from '../../frontend/src/free-camera.ts';

const actor = '76561198000000001';
const code = 'CSGO-ZEw8O-KGXNu-4TTUU-VyXbD-SBCtG';
class Reader extends EventEmitter {
  currentTick = 0;
  entities: { properties: Record<string, unknown> }[] = [];
}
const timeline = (data: CrosshairData, actors = [actor]) =>
  buildRecordedCrosshairTimeline({
    players: actors.map((id) => ({ id, name: 'Same display name', team: 3 })),
    crosshairs: data,
  });

test('recorded crosshair evidence uses immutable identity and clears when a controller disappears', () => {
  const reader = new Reader();
  const finish = observeCrosshairs(reader as unknown as DemoReader, 12, new Set([actor]));
  reader.entities[1] = {
    properties: {
      'CCSPlayerController.m_steamID': BigInt(actor),
      'CCSPlayerController.m_szCrosshairCodes': code,
    },
  };
  reader.emit('entitycreated', [1, 0, 0, 'CCSPlayerController']);
  reader.emit('tickend');
  reader.currentTick = 4;
  reader.emit('tickend');
  reader.currentTick = 8;
  reader.emit('entitydeleted', 1);
  reader.emit('tickend');
  const result = finish(true);
  assert.deepEqual(result.samples, [
    { tick: 0, actor, code },
    { tick: 8, actor, code: null },
  ]);
  const index = timeline(result);
  assert.deepEqual(
    [0, 4, 8, 12].map((tick) => recordedCrosshairAt(index, actor, tick)),
    [code, code, undefined, undefined],
  );
});

test('incomplete or invalid crosshair evidence cannot become later settings', () => {
  const index = timeline({ samples: [{ tick: 4, actor, code }], complete: false });
  assert.deepEqual(
    [0, 4, 8, 12].map((tick) => recordedCrosshairAt(index, actor, tick)),
    [undefined, code, undefined, undefined],
  );
  const reader = new Reader(),
    finish = observeCrosshairs(reader as unknown as DemoReader, 12, new Set([actor]));
  reader.entities[1] = {
    properties: {
      'CCSPlayerController.m_steamID': Number(actor),
      'CCSPlayerController.m_szCrosshairCodes': code,
    },
  };
  reader.emit('entitycreated', [1, 0, 0, 'CCSPlayerController']);
  reader.emit('tickend');
  assert.deepEqual(finish(true).samples, []);
});

test('global crosshair lookup is seek-safe, identity-safe and honors explicit loss of evidence', () => {
  const other = '76561198000000002',
    current = 'CSvbPubOq37zTGqtsPTP5QTrp5CB4xFXiKRLfzJsm49ZRe';
  const index = timeline(
    {
      complete: true,
      samples: [
        { tick: 4, actor, code },
        { tick: 8, actor: other, code: current },
        { tick: 12, actor, code: null },
        { tick: 16, actor, code: current },
      ],
    },
    [actor, other],
  );
  assert.deepEqual(
    [16, 3, 4, 12, 8].map((tick) => recordedCrosshairAt(index, actor, tick)),
    [current, undefined, code, undefined, code],
  );
  assert.equal(recordedCrosshairAt(index, other, 7), undefined);
  assert.equal(recordedCrosshairAt(index, other, 8), current);
  assert.equal(recordedCrosshairAt(index, other, 999), current);
  assert.equal(recordedCrosshairAt(index, 'unknown', 16), undefined);
  assert.equal(recordedCrosshairAt(index, actor, NaN), undefined);
});

test('only declared crosshair identities consume the bounded change index', () => {
  const reader = new Reader(),
    finish = observeCrosshairs(reader as unknown as DemoReader, 10001, new Set([actor]));
  reader.entities[1] = {
    properties: {
      'CCSPlayerController.m_steamID': '76561198000000002',
      'CCSPlayerController.m_szCrosshairCodes': code,
    },
  };
  reader.emit('entitycreated', [1, 0, 0, 'CCSPlayerController']);
  reader.emit('tickend');
  reader.entities[1].properties['CCSPlayerController.m_steamID'] = BigInt(actor);
  for (let tick = 0; tick <= 10001; tick++) {
    reader.currentTick = tick;
    reader.entities[1].properties['CCSPlayerController.m_szCrosshairCodes'] = tick % 2 ? '' : code;
    reader.emit('tickend');
  }
  const result = finish(true);
  assert.equal(result.samples.length, 10000);
  assert.equal(result.complete, false);
  assert.ok(result.samples.every((sample) => sample.actor === actor));
  assert.equal(recordedCrosshairAt(timeline(result), actor, 10001), undefined);
});

test('malformed crosshair timelines fail closed rather than leaking future or foreign settings', () => {
  for (const samples of [
    [
      { tick: 8, actor, code },
      { tick: 4, actor, code: null },
    ],
    [{ tick: -1, actor, code }],
    [{ tick: Infinity, actor, code }],
    [{ tick: 64 * 60 * 180 + 1, actor, code }],
    [{ tick: 4, actor: '76561198000000002', code }],
    [{ tick: 4, actor, code: 'A'.repeat(65) }],
    Array.from({ length: 10001 }, () => ({ tick: 4, actor, code })),
  ])
    assert.equal(recordedCrosshairAt(timeline({ complete: true, samples }), actor, 16), undefined);
});

test('recorded crosshair decoder handles real legacy/current codes and rejects corrupt or oversized input', () => {
  const old = recordedCrosshair(code);
  assert.equal(old?.format, 'legacy-v1');
  assert.equal(old?.gap, 2.25);
  const current = recordedCrosshair('CSvbPubOq37zTGqtsPTP5QTrp5CB4xFXiKRLfzJsm49ZRe', 768);
  assert.equal(current?.format, 'cs2-v1');
  assert.equal(current?.color, 'rgb(255, 0, 0)');
  assert.equal(current?.length, 5);
  assert.equal(current?.dynamic, true);
  assert.equal(recordedCrosshair('CS8xK7tOdVQjm84G4EpdbEJB5OJChE8M2yN6CpiYjRbKRf'), null);
  for (const bad of [undefined, '', 'CSGO-' + 'A'.repeat(10000), code.slice(0, -1) + 'A', { code }])
    assert.equal(recordedCrosshair(bad), null);
});

test('free camera maps both AZERTY and QWERTY actions without a keyboard-layout preference', () => {
  for (const key of ['w', 'z']) assert.equal(freeCameraAction({ key, code: '' }), 'forward');
  for (const key of ['a', 'q']) assert.equal(freeCameraAction({ key, code: '' }), 'left');
  assert.equal(freeCameraAction({ key: 'd', code: 'KeyD' }), 'right');
  assert.equal(freeCameraAction({ key: 'é', code: 'KeyW' }), 'forward');
  assert.equal(freeCameraAction({ key: 'Tab', code: 'Tab' }), undefined);
});
