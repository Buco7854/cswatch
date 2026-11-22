export const infernoLimits = Object.freeze({
  slots: 64,
  scale: 32,
  coordinate: 100_000,
  tracks: 256,
  active: 32,
  trackUpdates: 256,
  updates: 8192,
  trackBytes: 12 * 1024,
  recordingBytes: 768 * 1024,
  trackOverhead: 128,
});

const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;

// The numeric tuples are ASCII. Include a comma per update and reserve fixed
// track/header overhead so accounting also bounds the complete compact JSON.
export const infernoUpdateBytes = (update) => JSON.stringify(update).length + 1;

/** Each slot is a world-space point in 1/32 Source inches, or a one-element removal. */
export function validInfernoBank(value, lastTick) {
  if (
    !integer(lastTick, 0, Number.MAX_SAFE_INTEGER - 1) ||
    !value ||
    typeof value !== 'object' ||
    Object.keys(value).length !== 2 ||
    value.version !== 1 ||
    !Array.isArray(value.tracks) ||
    !value.tracks.length ||
    value.tracks.length > infernoLimits.tracks
  )
    return false;
  const entityEnds = new Map();
  const activeEnds = [];
  const maxCoordinate = infernoLimits.coordinate * infernoLimits.scale;
  let bytes = 0;
  let updates = 0;
  let previousStart = -1;
  for (const track of value.tracks) {
    if (
      !track ||
      typeof track !== 'object' ||
      Object.keys(track).length !== 4 ||
      !integer(track.entity, 0, 16382) ||
      !integer(track.serial, 0, 131071) ||
      !integer(track.end, 1, lastTick + 1) ||
      !Array.isArray(track.updates) ||
      !track.updates.length ||
      track.updates.length > infernoLimits.trackUpdates
    )
      return false;
    const start = track.updates[0]?.[0];
    if (
      !integer(start, 0, track.end - 1) ||
      start < previousStart ||
      start < (entityEnds.get(track.entity) ?? 0)
    )
      return false;
    for (let i = activeEnds.length - 1; i >= 0; i--)
      if (activeEnds[i] <= start) activeEnds.splice(i, 1);
    if (activeEnds.length >= infernoLimits.active) return false;
    activeEnds.push(track.end);
    previousStart = start;
    entityEnds.set(track.entity, track.end);
    updates += track.updates.length;
    if (updates > infernoLimits.updates) return false;
    const slots = new Array(infernoLimits.slots);
    let previousTick = start - 1;
    let trackBytes = infernoLimits.trackOverhead;
    for (const update of track.updates) {
      if (
        !Array.isArray(update) ||
        update.length !== 2 ||
        !integer(update[0], previousTick + 1, track.end - 1) ||
        !Array.isArray(update[1]) ||
        !update[1].length ||
        update[1].length > infernoLimits.slots
      )
        return false;
      previousTick = update[0];
      let previousSlot = -1;
      for (const change of update[1]) {
        if (
          !Array.isArray(change) ||
          (change.length !== 1 && change.length !== 4) ||
          !integer(change[0], previousSlot + 1, infernoLimits.slots - 1)
        )
          return false;
        const slot = change[0];
        previousSlot = slot;
        const previous = slots[slot];
        if (change.length === 1) {
          if (!previous) return false;
          slots[slot] = undefined;
        } else {
          const [, x, y, z] = change;
          if (
            !integer(x, -maxCoordinate, maxCoordinate) ||
            !integer(y, -maxCoordinate, maxCoordinate) ||
            !integer(z, -maxCoordinate, maxCoordinate) ||
            (previous && x === previous[1] && y === previous[2] && z === previous[3])
          )
            return false;
          slots[slot] = change;
        }
      }
      trackBytes += infernoUpdateBytes(update);
      if (trackBytes > infernoLimits.trackBytes) return false;
    }
    bytes += trackBytes;
    if (bytes > infernoLimits.recordingBytes) return false;
  }
  return true;
}
