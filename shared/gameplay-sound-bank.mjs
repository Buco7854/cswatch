import { createHash } from 'node:crypto';
import registry from './gameplay-sounds.json' with { type: 'json' };

// Only the approved PCM inputs determine the generation. Event aliases and mixing
// rules can change without installing another copy of the same native assets.
const sources = Object.keys(registry.items)
  .sort()
  .map((id) => [id, registry.items[id].source]);
export const managedSoundDirectory =
  'sounds-' + createHash('sha256').update(JSON.stringify(sources)).digest('hex');
