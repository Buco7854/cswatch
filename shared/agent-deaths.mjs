/** Require a nearby, recorded living pose from the same round as the death. */
export function deathAnchor(frames, id, tick, roundStart, rate) {
  let lo = 0,
    hi = frames.length;
  while (lo < hi) {
    const middle = (lo + hi) >>> 1;
    if (frames[middle].tick <= tick) lo = middle + 1;
    else hi = middle;
  }
  for (let i = lo - 1; i >= 0 && i >= lo - 16; i--) {
    const frame = frames[i];
    if (frame.tick < roundStart || tick - frame.tick > rate * 0.25) break;
    const pose = frame.players.find((player) => player.id === id);
    if (
      !pose?.alive ||
      (pose.team !== 2 && pose.team !== 3) ||
      ![pose.x, pose.y, pose.z, pose.yaw].every(
        (value) => Number.isFinite(value) && Math.abs(value) <= 1e7,
      )
    )
      continue;
    const { x, y, z, yaw, team } = pose;
    return { id, tick, x, y, z, yaw, team };
  }
}

export const agentDeathLimit = 4096;

export function validAgentDeaths(records) {
  if (!Array.isArray(records) || records.length > agentDeathLimit) return false;
  const keys = new Set();
  for (const anchor of records) {
    if (
      !anchor ||
      typeof anchor !== 'object' ||
      Object.keys(anchor).length !== 7 ||
      typeof anchor.id !== 'string' ||
      !/^\d{1,20}$/.test(anchor.id) ||
      anchor.id === '0' ||
      !Number.isSafeInteger(anchor.tick) ||
      anchor.tick < 0 ||
      anchor.tick > 64 * 60 * 180 ||
      (anchor.team !== 2 && anchor.team !== 3) ||
      ![anchor.x, anchor.y, anchor.z, anchor.yaw].every(
        (value) => Number.isFinite(value) && Math.abs(value) <= 1e7,
      )
    )
      return false;
    const key = anchor.id + ':' + anchor.tick;
    if (keys.has(key)) return false;
    keys.add(key);
  }
  return true;
}
