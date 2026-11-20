import type { DemoReader } from 'cs2parser';
import type { Frame } from '../../shared/playback.js';

/** Overlay camera evidence onto the existing sampled frames by exact demo tick and controller ID. */
export function observeRecordedEye(reader: DemoReader, frames: Frame[]) {
  let cursor = 0;
  if (!frames.length) return;
  reader.on('tickend', () => {
    while (cursor < frames.length && frames[cursor].tick < reader.currentTick) cursor++;
    const frame = frames[cursor];
    if (frame?.tick !== reader.currentTick) return;
    for (const controller of reader.playerControllers) {
      const player = frame.players.find((position) => position.id === controller.steamId);
      if (!player?.alive || player.id === '0') continue;
      const pawn = controller.pawn;
      const properties = pawn?.entity?.properties;
      if (!pawn?.isAlive || !properties || pawn.controller?.entityId !== controller.entityId)
        continue;
      const location = pawn.position;
      if (!(Math.hypot(location.x - player.x, location.y - player.y, location.z - player.z) <= 1))
        continue;
      const x = properties['CCSPlayerPawn.m_vecViewOffset.m_vecX'];
      const y = properties['CCSPlayerPawn.m_vecViewOffset.m_vecY'];
      const z = properties['CCSPlayerPawn.m_vecViewOffset.m_vecZ'];
      if (
        typeof x !== 'number' ||
        typeof y !== 'number' ||
        typeof z !== 'number' ||
        !(Math.abs(x) <= 32) ||
        !(Math.abs(y) <= 32) ||
        !(z >= 1 && z <= 96)
      )
        continue;
      const rounded = (value: number) => Math.round(value * 128) / 128;
      player.eyeOffset = x === 0 && y === 0 ? [rounded(z)] : [rounded(x), rounded(y), rounded(z)];
    }
    cursor++;
  });
}
