import type { GameplaySoundCue } from '../../shared/gameplay-sounds';
import registry from '../../shared/gameplay-sounds.json';
import type { Playback } from './types';

/** The official silencer sounds (volume 0.3), played where the recorded silencer state of a held
 * M4A1-S or USP-S changes between consecutive samples. CS2 plays them from the client's
 * animation, so the network recording does not carry them. */
const events = registry.events as Record<string, { soundId: string; volume?: number } | undefined>;
const sounds = {
  'M4A1-S': { on: 'Weapon_M4A1.Silencer_On', off: 'Weapon_M4A1.Silencer_Off' },
  'USP-S': { on: 'Weapon_USP.AttachSilencer', off: 'Weapon_USP.DetachSilencer' },
} as const;
const maxCues = 1024;

export function silencerCues(data: Pick<Playback, 'frames'>): GameplaySoundCue[] {
  const cues: GameplaySoundCue[] = [];
  const last = new Map<string, { weapon: string; silencer: boolean }>();
  for (const frame of data.frames) {
    for (const player of frame.players) {
      const pair = sounds[player.weapon as keyof typeof sounds];
      if (!player.alive || !pair || typeof player.silencer !== 'boolean') {
        last.delete(player.id);
        continue;
      }
      const before = last.get(player.id);
      last.set(player.id, { weapon: player.weapon, silencer: player.silencer });
      if (!before || before.weapon !== player.weapon || before.silencer === player.silencer)
        continue;
      const name = player.silencer ? pair.on : pair.off;
      const event = events[name];
      if (!event || cues.length >= maxCues) continue;
      cues.push({
        id: `silencer-${player.id}-${frame.tick}`,
        tick: frame.tick,
        soundId: event.soundId,
        category: 'reload',
        evidence: 'recorded-state',
        selection: 'representative',
        eventName: name,
        actor: player.id,
        position: { x: player.x, y: player.y, z: player.z },
        volume: event.volume,
      });
    }
  }
  return cues;
}
