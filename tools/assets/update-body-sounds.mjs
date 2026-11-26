#!/usr/bin/env node
/** Operator maintenance: add Valve's authored variations and distance curves for footstep,
 * landing, jump, body-hit and death sound events to the fixed registry. Reads S2V text
 * decompiles of the pinned official soundevent files (`--vpk_filepath
 * soundevents/game_sounds_{footsteps,physics,player}.vsndevts_c -d`). Weapon and utility
 * events are left untouched. */
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { soundTokenHash } from '../../backend/dist/sound-event-tokens.js';

/** The flat top-level events of a decompiled .vsndevts (KV3 text). */
export function parseSoundEvents(text) {
  const events = {};
  const header = /^\t([A-Za-z0-9_.:-]+) = \n\t\{\n/gm;
  let match;
  while ((match = header.exec(text))) {
    const end = text.indexOf('\n\t}\n', match.index);
    if (end < 0) break;
    const body = text.slice(match.index + match[0].length, end);
    const files = [...body.matchAll(/"(sounds\/[a-z0-9_/-]+\.vsnd)"/g)].map((m) => m[1]);
    const base = /^\t\tbase = "([^"]+)"/m.exec(body)?.[1];
    const volume = /^\t\tvolume = ([0-9.]+)$/m.exec(body)?.[1];
    const curve = /^\t\tdistance_volume_mapping_curve = \n\t\t\[\n([\s\S]*?)\n\t\t\]/m.exec(body);
    const points = curve
      ? [...curve[1].matchAll(/\[\s*([-0-9.e]+),\s*([-0-9.e]+),/g)].map((m) => [
          Number(m[1]),
          Number(m[2]),
        ])
      : [];
    events[match[1]] = { files, base, points, volume: volume && Number(volume) };
  }
  return events;
}

function resolved(events, name, key, depth = 0) {
  const event = events[name];
  if (!event || depth > 8) return;
  if (event[key]?.length) return event[key];
  return event.base ? resolved(events, event.base, key, depth + 1) : undefined;
}

const bodySources = /^sounds\/(?:player\/|physics\/flesh\/)/;
const itemId = (source) => {
  const name = basename(source, '.vsnd_c').replace(/_/g, '-');
  const prefix = source.startsWith('sounds/player/footsteps/')
    ? 'footstep'
    : source.startsWith('sounds/physics/flesh/')
      ? 'impact'
      : 'hit';
  return `${prefix}-${name}`.slice(0, 60);
};
/** Events the viewer plays for players: everything already in the footstep category, body
 * hits and deaths, plus the recorded death cry. */
const added = { 'Player.Death': 'weapon' };

export function updateBodySounds(registry, events) {
  const bySource = new Map(Object.entries(registry.items).map(([id, item]) => [item.source, id]));
  const owned = Object.entries(registry.events).filter(([, event]) => {
    const item = registry.items[event.soundId];
    return item.category === 'footstep' || bodySources.test(item.source);
  });
  for (const [name, category] of Object.entries(added))
    if (!registry.events[name]) owned.push([name, { channel: 'sos', category }]);
  for (const [name, event] of owned) {
    const files = resolved(events, name, 'files');
    const points = resolved(events, name, 'points');
    if (!files?.length) throw Error(`No official variations for ${name}.`);
    const category = event.category ?? registry.items[event.soundId].category;
    const variants = files.map((file) => {
      const source = file + '_c';
      let id = bySource.get(source);
      if (!id) {
        id = itemId(source);
        if (registry.items[id]) throw Error(`Sound id collision: ${id}.`);
        registry.items[id] = { source, category };
        bySource.set(source, id);
      }
      return id;
    });
    const { category: _, ...rest } = event;
    registry.events[name] = {
      ...rest,
      soundId: rest.soundId ?? variants[0],
      ...(rest.channel === 'sos' ? { hash: soundTokenHash(name) } : {}),
      ...(rest.volume === undefined && events[name]?.volume !== undefined
        ? { volume: events[name].volume }
        : {}),
      ...(variants.length > 1 ? { variants } : {}),
      ...(points?.length >= 2 ? { distance: points.map(([d, g]) => [round(d), round(g)]) } : {}),
    };
  }
  return registry;
}
const round = (value) => Math.round(value * 1000) / 1000;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.log('Usage: node update-body-sounds.mjs DECOMPILED.vsndevts...');
    process.exit(1);
  }
  const events = {};
  for (const file of files) Object.assign(events, parseSoundEvents(await readFile(file, 'utf8')));
  const path = new URL('../../shared/gameplay-sounds.json', import.meta.url);
  const registry = updateBodySounds(JSON.parse(await readFile(path, 'utf8')), events);
  await writeFile(path, JSON.stringify(registry, null, 2) + '\n');
  console.log(
    JSON.stringify({
      items: Object.keys(registry.items).length,
      events: Object.keys(registry.events).length,
    }),
  );
}
