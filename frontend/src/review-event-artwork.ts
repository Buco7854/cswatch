import { equipmentKey } from './equipment-key';
import type { ReviewEvent } from './review-events';

export type ReviewGlyphEvent = Pick<ReviewEvent, 'type' | 'team' | 'weapon'>;

/** Kill/death match CS2's demo controller. Objectives use distinct native HUD art. */
export function reviewEventArtwork(event: ReviewGlyphEvent) {
  if (event.type === 'kill') return 'demokill';
  if (event.type === 'death' || event.type === 'elimination') return 'demodeath';
  if (event.type === 'plant') return 'bombplanted';
  if (event.type === 'defuse') return 'bombdefused';
  if (event.type === 'explosion') return 'bombexploded';
  if (event.type === 'round-end')
    return event.team === 3 ? 'teamct' : event.team === 2 ? 'teamt' : 'roundmarker';
  const utility = event.weapon ? equipmentKey(event.weapon) : '';
  return ['flashbang', 'smokegrenade', 'hegrenade', 'molotov', 'incgrenade', 'decoy'].includes(
    utility,
  )
    ? utility
    : undefined;
}
