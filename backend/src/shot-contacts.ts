import type { DemoReader } from 'cs2parser';
import type { GameplaySoundCue } from '../../shared/gameplay-sounds.js';
import type { GameEvent } from '../../shared/playback.js';
import { soundPosition } from './sound-event-tokens.js';
import { gameplaySoundRegistry } from './gameplay-sound-registry.js';

type Position = NonNullable<GameplaySoundCue['position']>;
export function observeShotContacts(
  reader: DemoReader,
  actors: ReadonlySet<string>,
  lastTick: number,
  limit: number,
) {
  const impacts = new Map<string, { position: Position; tick: number }>();
  let truncated = false;
  const silentTicks = new Set<number>();
  function validTick() {
    return (
      Number.isSafeInteger(reader.currentTick) &&
      reader.currentTick >= 0 &&
      reader.currentTick <= lastTick
    );
  }
  reader.gameEvents.on('bullet_impact', ({ x, y, z }) => {
    const position = soundPosition(x, y, z);
    if (!position || !validTick()) return;
    const key = [reader.currentTick, x, y, z].join(':');
    if (impacts.size < limit) impacts.set(key, { position, tick: reader.currentTick });
    else truncated = true;
  });
  type Shot = Required<Pick<GameplaySoundCue, 'position' | 'shotAngles'>>;
  const shotRays = new Map<string, Shot | null>();
  reader.on('GE_FireBulletsId', (message) => {
    const { player, angles, origin, spread, inaccuracy } = message;
    if (
      player === undefined ||
      !Number.isInteger(player) ||
      player < 0 ||
      player >= 0xffffff ||
      !angles ||
      angles.x === undefined ||
      angles.y === undefined ||
      !Number.isFinite(angles.x) ||
      Math.abs(angles.x) > 90 ||
      !Number.isFinite(angles.y) ||
      Math.abs(angles.y) > 360 ||
      spread === undefined ||
      inaccuracy === undefined ||
      !Number.isFinite(spread + inaccuracy) ||
      spread < 0 ||
      inaccuracy < 0 ||
      spread + inaccuracy > 0.04
    )
      return;
    if (!validTick()) return;
    const position = soundPosition(origin?.x, origin?.y, origin?.z);
    if (!position) return;
    // The message and controller property both carry the compact network handle.
    // Match its serial as well as the pawn index before binding an account.
    const controller = reader.getPawn(player & 0x3fff)?.controller;
    const properties = controller?.entity?.properties as Record<string, unknown> | undefined;
    if (
      !controller ||
      !actors.has(controller.steamId) ||
      properties?.['CCSPlayerController.m_hPlayerPawn'] !== player
    )
      return;
    const key = controller.steamId + ':' + reader.currentTick;
    // More than one message for the same shooter and tick has no unique ray.
    if (shotRays.has(key)) shotRays.set(key, null);
    else if (shotRays.size < limit)
      shotRays.set(key, { position, shotAngles: { pitch: angles.x, yaw: angles.y } });
    else truncated = true;
  });

  function silence() {
    if (!validTick()) return;
    if (silentTicks.size < limit) silentTicks.add(reader.currentTick);
    else truncated = true;
  }
  function apply(sounds: GameplaySoundCue[], events: GameEvent[], fallback: GameplaySoundCue[]) {
    // Be conservative for simultaneous fire: recorded impacts and player damage take
    // precedence over a local wall approximation, even without an attacker identity.
    const impactTicks = new Set(silentTicks);
    for (const cue of sounds)
      if (cue.eventName && /(?:\.bulletimpact|\.onlooker)$/i.test(cue.eventName))
        impactTicks.add(cue.tick);
    for (const event of events)
      if (event.type === 'player_hurt' || event.type === 'player_death')
        impactTicks.add(event.tick);
    const occupied = (ticks: Set<number>, tick: number) =>
      ticks.has(tick - 1) || ticks.has(tick) || ticks.has(tick + 1);
    const pointTicks = new Set<number>();
    const defaultImpact = gameplaySoundRegistry.events!['Default.BulletImpact'];
    for (const { position, tick } of impacts.values()) {
      pointTicks.add(tick);
      if (occupied(impactTicks, tick)) continue;
      if (fallback.length >= limit) {
        truncated = true;
        break;
      }
      fallback.push({
        id: 'bullet-contact-' + fallback.length,
        tick,
        position,
        category: 'weapon',
        evidence: 'game-event',
        selection: 'representative',
        eventName: 'bullet_impact',
        soundId: defaultImpact.soundId,
        volume: defaultImpact.volume,
        pitch: defaultImpact.pitch,
      });
    }
    for (const cue of fallback) {
      if (
        !cue.actor ||
        !cue.soundId.endsWith('-fire') ||
        occupied(impactTicks, cue.tick) ||
        occupied(pointTicks, cue.tick)
      )
        continue;
      const ray = shotRays.get(cue.actor + ':' + cue.tick);
      if (ray) Object.assign(cue, ray);
    }
    return truncated;
  }
  return { apply, silence };
}
