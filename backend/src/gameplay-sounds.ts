/** Optional event audio evidence, observed inside the existing disposable parser only. */
import type { DemoReader } from 'cs2parser';
import type { GameEvent } from '../../shared/playback.js';
import type {
  GameplaySoundCue,
  GameplaySoundInfo,
  GameplaySoundCategory,
} from '../../shared/gameplay-sounds.js';
import { gameplaySoundRegistry } from './gameplay-sound-registry.js';
import { observeShotContacts } from './shot-contacts.js';
import { packedSoundPosition, soundPosition, soundTokenHash } from './sound-event-tokens.js';
export const gameplaySoundLimits = {
  samples: 100000,
  chunkSamples: 4096,
  tick: 64 * 60 * 180,
} as const;
const categories: GameplaySoundCategory[] = [
  'weapon',
  'footstep',
  'reload',
  'utility',
  'objective',
  'round',
];
const known = gameplaySoundRegistry.items;
const silentBulletImpact = soundTokenHash('Silent.BulletImpact');
const weaponAliases: Record<string, string> = {
  m4a1_silencer: 'm4a1silencer',
  usp_silencer: 'uspsilencer',
  p2000: 'hkp2000',
};
const positionKey = (position: NonNullable<GameplaySoundCue['position']>) =>
  `${position.x},${position.y},${position.z}`;

/** Index recorded evidence without quadratic scans for dense, optional sound streams.
 * Known different locations or actors never establish the same occurrence. Missing
 * evidence retains the existing fallback policy rather than inventing an identity. */
export function indexNativeSoundEvidence(sounds: GameplaySoundCue[]) {
  type Actors = Set<string | undefined>;
  const buckets = new Map<
    string,
    { actors: Actors; unpositioned: Actors; positions: Map<string, Actors> }
  >();
  for (const cue of sounds) {
    const key = `${cue.soundId}:${Math.floor(cue.tick)}`;
    let bucket = buckets.get(key);
    if (!bucket)
      buckets.set(
        key,
        (bucket = { actors: new Set(), unpositioned: new Set(), positions: new Map() }),
      );
    bucket.actors.add(cue.actor);
    if (!cue.position) bucket.unpositioned.add(cue.actor);
    else {
      const at = positionKey(cue.position);
      let actors = bucket.positions.get(at);
      if (!actors) bucket.positions.set(at, (actors = new Set()));
      actors.add(cue.actor);
    }
  }
  const matchesActor = (actors: Actors | undefined, actor: string | undefined) =>
    Boolean(actors?.size && (actor === undefined || actors.has(undefined) || actors.has(actor)));
  return (cue: GameplaySoundCue, tick: number) => {
    const bucket = buckets.get(`${cue.soundId}:${tick}`);
    if (!bucket) return false;
    return cue.position
      ? matchesActor(bucket.positions.get(positionKey(cue.position)), cue.actor) ||
          matchesActor(bucket.unpositioned, cue.actor)
      : matchesActor(bucket.actors, cue.actor);
  };
}
/** Valve picks one authored variation per occurrence; the recording carries its seed.
 * The same seed always selects the same file, so a replay sounds the same on every seek. */
export function recordedVariant(
  definition: { soundId: string; variants?: string[] },
  seed: unknown,
) {
  const variants = definition.variants;
  if (!variants?.length || typeof seed !== 'number' || !Number.isSafeInteger(seed) || seed < 0)
    return definition.soundId;
  const id = variants[seed % variants.length];
  return Object.hasOwn(known, id) ? id : definition.soundId;
}
export function eventGameplaySounds(events: GameEvent[], actors: ReadonlySet<string>) {
  const cues: GameplaySoundCue[] = [];
  const mapping: Record<string, string> = {
    hegrenade_detonate: 'he-explode',
    flashbang_detonate: 'flash-explode',
    inferno_startburn: 'fire-ignite',
    bomb_planted: 'bomb-plant',
    bomb_begindefuse: 'bomb-defuse-start',
    bomb_defused: 'bomb-defuse',
    bomb_exploded: 'bomb-explode',
  };
  for (const [index, event] of events.entries()) {
    const weapon = String(event.weapon || '')
      .replace(/^weapon_/, '')
      .toLowerCase();
    const canonicalWeapon = weaponAliases[weapon] || weapon;
    const soundId =
      event.type === 'round_end'
        ? event.winner === 3
          ? 'round-ct-win'
          : event.winner === 2
            ? 'round-t-win'
            : undefined
        : event.type === 'weapon_fire'
          ? event.silenced === false && canonicalWeapon === 'uspsilencer'
            ? 'uspsilencer-unsilenced-fire'
            : event.silenced === false && canonicalWeapon === 'm4a1silencer'
              ? 'm4a1-fire'
              : `${canonicalWeapon}-fire`
          : mapping[event.type];
    if (
      !soundId ||
      !Object.hasOwn(known, soundId) ||
      !Number.isFinite(event.tick) ||
      event.tick < 0 ||
      event.tick > gameplaySoundLimits.tick
    )
      continue;
    const actor =
      typeof event.user_steamid === 'string' && actors.has(event.user_steamid)
        ? event.user_steamid
        : undefined;
    const position =
      soundPosition(event.x, event.y, event.z) ??
      soundPosition(event.user_X, event.user_Y, event.user_Z);
    cues.push({
      id: `event-sound-${index}`,
      tick: event.tick,
      soundId,
      category: known[soundId].category,
      evidence: 'game-event',
      selection: 'representative',
      ...(actor ? { actor } : {}),
      ...(position ? { position } : {}),
    });
    if (cues.length >= gameplaySoundLimits.samples) break;
  }
  return cues;
}
export function observeGameplaySounds(
  reader: DemoReader,
  lastTick: number,
  actors: ReadonlySet<string>,
) {
  const sounds: GameplaySoundCue[] = [];
  let truncated = false;
  const tokenIds = new Map<
    string,
    { name: string; definition: NonNullable<typeof gameplaySoundRegistry.events>[string] }
  >();
  const hashes = new Map<
    number,
    { name: string; definition: NonNullable<typeof gameplaySoundRegistry.events>[string] }
  >();
  const stopped = new Map<number, GameplaySoundCue>();
  const shotContacts = observeShotContacts(reader, actors, lastTick, gameplaySoundLimits.samples);
  for (const [name, definition] of Object.entries(gameplaySoundRegistry.events || {})) {
    if (!Object.hasOwn(known, definition.soundId))
      throw Error('Unknown native sound event sample.');
    const record = { name, definition };
    if (definition.channel === 'weapon-sound') tokenIds.set(name.toLowerCase(), record);
    else {
      const hash = soundTokenHash(name);
      if (hash !== definition.hash || hashes.has(hash))
        throw Error('Ambiguous or incorrect fixed sound hash.');
      hashes.set(hash, record);
    }
  }
  const append = (cue: Omit<GameplaySoundCue, 'id'>) => {
    if (!Number.isFinite(cue.tick) || cue.tick < 0 || cue.tick > lastTick) return;
    if (sounds.length >= gameplaySoundLimits.samples) {
      truncated = true;
      return;
    }
    sounds.push({ id: `network-sound-${sounds.length}`, ...cue });
  };
  reader.on('CS_UM_WeaponSound', (message) => {
    const record =
      typeof message.sound === 'string' &&
      message.sound.length <= 128 &&
      tokenIds.get(message.sound.toLowerCase());
    if (!record) return;
    const { name, definition } = record,
      position = soundPosition(message.origin_x, message.origin_y, message.origin_z);
    append({
      tick: reader.currentTick,
      soundId: definition.soundId,
      category: known[definition.soundId].category,
      evidence: 'network-sound',
      selection: 'representative',
      eventName: name,
      ...(position ? { position } : {}),
      ...(definition.volume !== undefined ? { volume: definition.volume } : {}),
      ...(definition.pitch !== undefined ? { pitch: definition.pitch } : {}),
    });
  });
  reader.on('GE_SosStartSoundEvent', (message) => {
    if (!Number.isInteger(message.soundevent_hash)) return;
    if (message.soundevent_hash === silentBulletImpact) {
      shotContacts.silence();
      return;
    }
    const record = hashes.get(message.soundevent_hash!);
    if (!record) return;
    const position = packedSoundPosition(message.packed_params ?? new Uint8Array());
    if (!position.valid) return;
    const before = sounds.length,
      { name, definition } = record;
    const soundId = recordedVariant(definition, message.seed);
    append({
      tick: reader.currentTick,
      soundId,
      category: known[soundId].category,
      evidence: 'network-sound',
      selection: 'representative',
      eventName: name,
      ...(position.position ? { position: position.position } : {}),
      ...(definition.volume !== undefined ? { volume: definition.volume } : {}),
      ...(definition.pitch !== undefined ? { pitch: definition.pitch } : {}),
    });
    if (
      sounds.length > before &&
      Number.isSafeInteger(message.soundevent_guid) &&
      message.soundevent_guid! >= 0 &&
      stopped.size < gameplaySoundLimits.samples
    )
      stopped.set(message.soundevent_guid!, sounds.at(-1)!);
  });
  reader.on('GE_SosStopSoundEvent', (message) => {
    if (!Number.isSafeInteger(message.soundevent_guid)) return;
    const cue = stopped.get(message.soundevent_guid!);
    if (cue && reader.currentTick >= cue.tick && reader.currentTick <= lastTick)
      cue.endTick = reader.currentTick;
    stopped.delete(message.soundevent_guid!);
  });
  return (complete: boolean, events: GameEvent[]) => {
    const nativeAt = indexNativeSoundEvidence(sounds);
    // A completed plant has two recorded representations with different samples:
    // bomb_planted and native c4.plantquiet. Prefer the native occurrence only.
    // Explicitly different positions remain separate. No category-wide matching
    // is used: a grenade's throw/bounce and explosion can legitimately coincide.
    const plantAt = new Map<number, { unpositioned: boolean; positions: Set<string> }>();
    for (const cue of sounds) {
      if (cue.eventName?.toLowerCase() !== 'c4.plantquiet') continue;
      const tick = Math.floor(cue.tick);
      let bucket = plantAt.get(tick);
      if (!bucket) plantAt.set(tick, (bucket = { unpositioned: false, positions: new Set() }));
      if (cue.position) bucket.positions.add(positionKey(cue.position));
      else bucket.unpositioned = true;
    }
    const fallback = eventGameplaySounds(events, actors).filter(
      (cue) =>
        ![-2, -1, 0, 1, 2].some((delta) => {
          const tick = Math.floor(cue.tick) + delta;
          if (nativeAt(cue, tick)) return true;
          if (cue.soundId !== 'bomb-plant') return false;
          const plant = plantAt.get(tick);
          return Boolean(
            plant &&
            (!cue.position || plant.unpositioned || plant.positions.has(positionKey(cue.position))),
          );
        }),
    );
    if (shotContacts.apply(sounds, events, fallback)) truncated = true;
    let all = [...fallback, ...sounds].sort((a, b) => a.tick - b.tick || a.id.localeCompare(b.id));
    const buckets = new Map<number, number>();
    all = all.filter((cue) => {
      const bucket = Math.floor(cue.tick / 64),
        count = buckets.get(bucket) || 0;
      if (count >= 256) {
        truncated = true;
        return false;
      }
      buckets.set(bucket, count + 1);
      return true;
    });
    if (all.length > gameplaySoundLimits.samples) {
      all.length = gameplaySoundLimits.samples;
      truncated = true;
    }
    const coverage = Object.fromEntries(
      categories.map((category) => [
        category,
        all.some((c) => c.category === category) ? 'partial' : 'unavailable',
      ]),
    ) as GameplaySoundInfo['coverage'];
    // Even supported samples omit Source's layered/distant/occluded mix and optional unknown tokens.
    return {
      sounds: all,
      gameplaySounds: { coverage, truncated: truncated || !complete } satisfies GameplaySoundInfo,
    };
  };
}
