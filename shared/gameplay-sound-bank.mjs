import { createHash } from 'node:crypto';
import registry from './gameplay-sounds.json' with { type: 'json' };
import { gameplayAudioLimits } from './gameplay-sound-files.mjs';

// Only the approved PCM inputs and the bounds that admit them determine the generation.
// Event aliases and mixing rules can change without installing another copy of the same
// native assets; a bound that admits a sample the previous one refused publishes a new bank.
const sources = Object.keys(registry.items)
  .sort()
  .map((id) => [id, registry.items[id].source]);
const admission = [gameplayAudioLimits.bytes, gameplayAudioLimits.durationMs];
export const managedSoundDirectory =
  'sounds-' +
  createHash('sha256')
    .update(JSON.stringify([...sources, admission]))
    .digest('hex');
