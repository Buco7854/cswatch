/** Recorded aim. Each player has a base64 stream of (tick gap and continuity flag,
 * zigzag yaw, zigzag pitch) canonical unsigned LEB128 triples. Discontinuities
 * encode absolute angles. All angles are in 1/128 degree units modulo one turn. */
const units = 128;
const halfTurn = 180 * units;
const turn = 2 * halfTurn;
const maxTick = 64 * 60 * 180;
const maxTracks = 128;
export const aimChunkBytes = 256 * 1024;
const actorId = /^[1-9][0-9]{0,19}$/;
const wrap = (value) => ((((value + halfTurn) % turn) + turn) % turn) - halfTurn;
const zigzag = (value) => (value < 0 ? -2 * value - 1 : 2 * value);
const unzigzag = (value) => (value & 1 ? -(value + 1) / 2 : value / 2);
const angle = (value) => Number.isInteger(value) && value >= -halfTurn && value < halfTurn;
const validTick = (tick) => Number.isSafeInteger(tick) && tick >= 0 && tick <= maxTick;

export function quantizeAim(value) {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 360
    ? wrap(Math.round(value * units))
    : undefined;
}

function invalid() {
  throw new Error('Invalid recorded aim track');
}

/** undefined is empty. null asks the writer to try a smaller chunk. */
export function encodeAimChunk(start, end, players) {
  if (!validTick(start) || !validTick(end) || start > end || players.size > maxTracks) invalid();
  const tracks = [];
  let remaining = aimChunkBytes;
  for (const id of [...players.keys()].sort()) {
    if (typeof id !== 'string' || !actorId.test(id)) invalid();
    let previous = start - 1;
    let yaw = 0;
    let pitch = 0;
    const bytes = [];
    const write = (value) => {
      while (value >= 128) {
        bytes.push((value & 127) | 128);
        value >>>= 7;
      }
      bytes.push(value);
    };
    for (const [tick, y, p, continuous] of players.get(id)) {
      if (
        !validTick(tick) ||
        tick <= previous ||
        tick > end ||
        !angle(y) ||
        !angle(p) ||
        typeof continuous !== 'boolean'
      )
        invalid();
      const gap = tick - previous;
      const connected = continuous && previous >= start && gap === 1;
      write(gap * 2 + Number(connected));
      write(zigzag(connected ? wrap(y - yaw) : y));
      write(zigzag(connected ? wrap(p - pitch) : p));
      if (bytes.length > remaining) return null;
      previous = tick;
      yaw = y;
      pitch = p;
    }
    if (!bytes.length) continue;
    remaining -= bytes.length;
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 4096)
      binary += String.fromCharCode(...bytes.slice(offset, offset + 4096));
    tracks.push([id, btoa(binary)]);
  }
  return tracks.length ? { version: 1, tracks } : undefined;
}

/** The same bounded decoder is used before publication and in the browser. */
export function decodeAimChunk(value, start, end, actors) {
  const decoded = new Map();
  if (value === undefined) return decoded;
  if (
    !validTick(start) ||
    !validTick(end) ||
    start > end ||
    !value ||
    typeof value !== 'object' ||
    Object.keys(value).length !== 2 ||
    value.version !== 1 ||
    !Array.isArray(value.tracks) ||
    value.tracks.length < 1 ||
    value.tracks.length > maxTracks
  )
    invalid();
  let remaining = aimChunkBytes;
  let previousId = '';
  for (const entry of value.tracks) {
    if (!Array.isArray(entry) || entry.length !== 2) invalid();
    const [id, data] = entry;
    if (
      typeof id !== 'string' ||
      !actorId.test(id) ||
      id <= previousId ||
      !actors.has(id) ||
      typeof data !== 'string' ||
      data.length < 4 ||
      data.length > Math.ceil(remaining / 3) * 4 ||
      data.length % 4 !== 0
    )
      invalid();
    previousId = id;
    let binary;
    try {
      binary = atob(data);
    } catch {
      invalid();
    }
    if (binary.length < 3 || binary.length > remaining || btoa(binary) !== data) invalid();
    remaining -= binary.length;

    // Three varints per sample. Bound decoded storage before reading any sample.
    const capacity = Math.min(Math.floor(binary.length / 3), end - start + 1);
    const ticks = new Int32Array(capacity);
    const angles = new Int16Array(capacity * 2);
    const connected = new Uint8Array(capacity);
    let offset = 0;
    let length = 0;
    let tick = start - 1;
    let yaw = 0;
    let pitch = 0;
    const read = () => {
      let number = 0;
      for (let shift = 0; shift <= 14; shift += 7) {
        if (offset === binary.length) invalid();
        const byte = binary.charCodeAt(offset++);
        number |= (byte & 127) << shift;
        if (byte < 128) {
          if (shift && byte === 0) invalid();
          return number;
        }
      }
      invalid();
    };
    while (offset < binary.length) {
      const code = read();
      const gap = code >>> 1;
      const link = code & 1;
      tick += gap;
      if (!gap || tick > end || length >= capacity || (link && (!length || gap !== 1))) invalid();
      const y = unzigzag(read());
      const p = unzigzag(read());
      if (!angle(y) || !angle(p)) invalid();
      yaw = link ? wrap(yaw + y) : y;
      pitch = link ? wrap(pitch + p) : p;
      ticks[length] = tick;
      angles[length * 2] = yaw;
      angles[length * 2 + 1] = pitch;
      connected[length++] = link;
    }
    decoded.set(id, {
      ticks: ticks.subarray(0, length),
      angles: angles.subarray(0, length * 2),
      connected: connected.subarray(0, length),
    });
  }
  return decoded;
}

export function sampleAim(track, tick) {
  if (!Number.isFinite(tick)) return;
  const floor = Math.floor(tick);
  const { ticks, angles, connected } = track;
  let low = 0;
  let high = ticks.length - 1;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (ticks[mid] < floor) low = mid + 1;
    else high = mid;
  }
  if (ticks[low] !== floor) return;
  let yaw = angles[low * 2];
  let pitch = angles[low * 2 + 1];
  if (tick !== floor) {
    if (ticks[low + 1] !== floor + 1) return;
    if (connected[low + 1]) {
      yaw += wrap(angles[low * 2 + 2] - yaw) * (tick - floor);
      pitch += wrap(angles[low * 2 + 3] - pitch) * (tick - floor);
    }
  }
  return { yaw: yaw / units, pitch: pitch / units };
}

export function aimBoundary(tracks, tick) {
  const entries = [];
  for (const [id, track] of tracks) {
    const pose = sampleAim(track, tick);
    if (pose) entries.push([id, pose.yaw, pose.pitch]);
  }
  return JSON.stringify(entries);
}
