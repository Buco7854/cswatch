export const smokeLimits = Object.freeze({
  tracks: 192,
  active: 12,
  journalBytes: 8192,
  recordingsBytes: 512 * 1024,
  frames: 256,
  updates: 20000,
  coordinate: 100000,
});

const integer = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max;
const origin = (value) =>
  Array.isArray(value) &&
  value.length === 3 &&
  value.every(
    (coordinate) => Number.isFinite(coordinate) && Math.abs(coordinate) <= smokeLimits.coordinate,
  );
const color = (value) =>
  Array.isArray(value) && value.length === 3 && value.every((channel) => integer(channel, 255));

/** Validate before base64 decoding or allocating a voxel grid. Old replays omit the bank. */
export function validSmokeTracks(value, lastTick) {
  if (!Array.isArray(value) || value.length > smokeLimits.tracks) return false;
  const identities = new Set();
  let bytes = 0,
    updates = 0,
    previous = -1;
  for (const track of value) {
    if (
      !track ||
      typeof track !== 'object' ||
      Object.keys(track).length !== 8 ||
      !integer(track.entity, 16382) ||
      !integer(track.serial, 131071) ||
      !integer(track.start, lastTick) ||
      !integer(track.end, lastTick + 1) ||
      track.start < previous ||
      track.start >= track.end ||
      !origin(track.origin) ||
      !color(track.color) ||
      typeof track.journal !== 'string' ||
      track.journal.length > 4 * Math.ceil(smokeLimits.journalBytes / 3) ||
      track.journal.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(track.journal) ||
      !Array.isArray(track.updates) ||
      !track.updates.length ||
      track.updates.length > smokeLimits.frames
    )
      return false;
    const identity = `${track.entity}:${track.serial}:${track.start}`;
    if (identities.has(identity)) return false;
    identities.add(identity);
    previous = track.start;
    const padding = track.journal.endsWith('==') ? 2 : Number(track.journal.endsWith('='));
    const size = (track.journal.length / 4) * 3 - padding;
    bytes += size;
    updates += track.updates.length;
    if (
      size > smokeLimits.journalBytes ||
      bytes > smokeLimits.recordingsBytes ||
      updates > smokeLimits.updates
    )
      return false;
    let tick = track.start - 1,
      offset = 0;
    for (const entry of track.updates) {
      if (
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        !integer(entry[0], track.end - 1) ||
        entry[0] <= tick ||
        !integer(entry[1], size) ||
        entry[1] - offset < 4
      )
        return false;
      [tick, offset] = entry;
    }
    if (track.updates[0][0] !== track.start || offset !== size) return false;
  }
  return true;
}
