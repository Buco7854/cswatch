import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { DemoReader } from 'cs2parser';
import type { Frame, Position } from '../../shared/playback.js';
import { observeRecordedEye } from '../src/recorded-eye.js';

test('recorded eye samples require the same controller, pawn, location and demo tick', () => {
  const player: Position = {
    id: '76561198000000001',
    x: 12,
    y: 32,
    z: 9,
    yaw: 0,
    pitch: 0,
    health: 100,
    team: 2,
    alive: true,
    weapon: 'Glock-18',
  };
  const frames: Frame[] = [4, 8, 12].map((tick) => ({ tick, players: [{ ...player }] }));
  const properties = {
    'CCSPlayerPawn.m_vecViewOffset.m_vecX': 0,
    'CCSPlayerPawn.m_vecViewOffset.m_vecY': 0,
    'CCSPlayerPawn.m_vecViewOffset.m_vecZ': 64,
  };
  const pawn = {
    isAlive: true,
    controller: { entityId: 3 },
    position: { x: 12, y: 32, z: 9 },
    entity: { properties },
  };
  const controller = { steamId: player.id, entityId: 3, pawn };
  const reader = Object.assign(new EventEmitter(), {
    currentTick: 4,
    playerControllers: [controller],
  });
  observeRecordedEye(reader as unknown as DemoReader, frames);
  reader.emit('tickend');
  assert.deepEqual(frames[0].players[0].eyeOffset, [64]);
  properties['CCSPlayerPawn.m_vecViewOffset.m_vecX'] = 0.125;
  properties['CCSPlayerPawn.m_vecViewOffset.m_vecZ'] = 46;
  reader.currentTick = 8;
  reader.emit('tickend');
  assert.deepEqual(frames[1].players[0].eyeOffset, [0.125, 0, 46]);
  reader.currentTick = 12;
  pawn.controller.entityId = 4;
  reader.emit('tickend');
  assert.equal(frames[2].players[0].eyeOffset, undefined);
});
