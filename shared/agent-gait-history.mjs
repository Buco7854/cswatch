import equipment from './equipment-models.json' with { type: 'json' };
import { canonicalEquipmentKey } from './equipment-key.mjs';
import { strideDisplacement } from './stride-distance.mjs';

const classes = ['rifle', 'pistol', 'knife'];
// End tick, span, distance in millimetres, relative bearing, duck, class and world bearing.
const bytesPerStep = 12;
const maxSteps = 240000;
const maxTick = 64 * 60 * 180;
export function agentWeaponClass(weapon) {
  const key = canonicalEquipmentKey(weapon);
  const item = Object.hasOwn(equipment.items, key) ? equipment.items[key] : undefined;
  if (item?.resource.includes('/weapon_pist_')) return 'pistol';
  if (item?.kind === 'weapon') return 'rifle';
  return item ||
    key.startsWith('knife') ||
    /^(?:incendiary|incendiarygrenade|decoygrenade|\w+knife)$/.test(key)
    ? 'knife'
    : 'rifle';
}

function gaitStep(from, to, elapsed) {
  const displacement = strideDisplacement(from, to, elapsed);
  if (!displacement || !Number.isFinite(from.yaw) || !Number.isFinite(to.yaw)) return;
  const meters = displacement.horizontal * 0.0254;
  const distance = meters / elapsed > 0.05 ? Math.round(meters * 1000) : 0;
  const yaw = from.yaw + (((((to.yaw - from.yaw) % 360) + 540) % 360) - 180) / 2;
  const worldBearing = Math.atan2(to.y - from.y, to.x - from.x);
  const bearing = worldBearing - (yaw * Math.PI) / 180;
  const duck = Math.max(0, Math.min(1, ((from.duck ?? 0) + (to.duck ?? from.duck ?? 0)) / 2));
  return { distance, bearing, worldBearing, duck, weapon: agentWeaponClass(from.weapon) };
}

/** An ordered sequence of recorded movement intervals, independent of any installed pack. */
export function encodeGaitHistory({ frames, players, rounds, tickRate }) {
  if (players.length > 128 || !Number.isFinite(tickRate) || tickRate <= 0) return;
  const actors = new Set(players.map(({ id }) => id).filter((id) => /^\d{1,20}$/.test(id)));
  if (!actors.size) return;
  const starts = rounds.map(({ tick }) => tick).sort((a, b) => a - b);
  const records = new Map();
  let count = 0,
    round = 0;
  for (let i = 1; i < frames.length; i++) {
    const from = frames[i - 1],
      to = frames[i];
    while (starts[round] <= from.tick) round++;
    const ticks = to.tick - from.tick;
    if (ticks <= 0 || ticks > 255 || starts[round] <= to.tick) continue;
    const positions = new Map(from.players.map((p) => [p.id, p]));
    for (const p of to.players) {
      if (!actors.has(p.id)) continue;
      const step = gaitStep(positions.get(p.id), p, ticks / tickRate);
      if (!step) continue;
      let rows = records.get(p.id);
      if (!rows) records.set(p.id, (rows = []));
      const previous = rows.at(-1);
      // Consecutive idle records represent the same zero displacement. Keep the
      // run continuous and stay inside the wire's maximum interval duration.
      if (
        !step.distance &&
        previous?.[2] === 0 &&
        previous[0] === from.tick &&
        previous[1] + ticks <= Math.min(255, tickRate * 0.25)
      ) {
        previous[0] = to.tick;
        previous[1] += ticks;
        continue;
      }
      if (++count > maxSteps) return;
      rows.push([
        to.tick,
        ticks,
        step.distance,
        Math.round((step.bearing * 256) / (2 * Math.PI)) & 255,
        Math.round(step.duck * 255),
        classes.indexOf(step.weapon),
        Math.round((step.worldBearing * 65536) / (2 * Math.PI)) & 65535,
      ]);
    }
  }
  return {
    version: 2,
    players: [...records].map(([id, rows]) => {
      const bytes = new Uint8Array(rows.length * bytesPerStep);
      const view = new DataView(bytes.buffer);
      for (let i = 0; i < rows.length; i++) {
        const [end, ticks, distance, angle, duck, weapon, worldBearing] = rows[i];
        const offset = i * bytesPerStep;
        view.setUint32(offset, end, true);
        view.setUint8(offset + 4, ticks);
        view.setUint16(offset + 5, distance, true);
        view.setUint8(offset + 7, angle);
        view.setUint8(offset + 8, duck);
        view.setUint8(offset + 9, weapon);
        view.setUint16(offset + 10, worldBearing, true);
      }
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 8192)
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      return [id, btoa(binary)];
    }),
  };
}

function unbox(text) {
  const binary = atob(text);
  return new DataView(Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer);
}

export function validGaitHistory(history, actors, first = 0, last = maxTick, rate = 64) {
  if (
    !Number.isFinite(rate) ||
    rate <= 0 ||
    history?.version !== 2 ||
    !Array.isArray(history.players) ||
    history.players.length > 128
  )
    return false;
  const seen = new Set();
  let count = 0;
  for (const pair of history.players) {
    if (!Array.isArray(pair) || pair.length !== 2) return false;
    const [id, text] = pair;
    if (
      typeof id !== 'string' ||
      !actors.has(id) ||
      !/^\d{1,20}$/.test(id) ||
      seen.has(id) ||
      typeof text !== 'string' ||
      !text.length ||
      text.length > Math.ceil(((maxSteps - count) * bytesPerStep) / 3) * 4 ||
      text.length % 4 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(text)
    )
      return false;
    seen.add(id);
    let view;
    try {
      view = unbox(text);
    } catch {
      return false;
    }
    if (view.byteLength % bytesPerStep || (count += view.byteLength / bytesPerStep) > maxSteps)
      return false;
    let previousEnd = first;
    for (let i = 0; i < view.byteLength; i += bytesPerStep) {
      const end = view.getUint32(i, true),
        ticks = view.getUint8(i + 4);
      const distance = view.getUint16(i + 5, true);
      if (
        end > last ||
        end - ticks < previousEnd ||
        !ticks ||
        ticks > rate * 0.25 ||
        distance > Math.ceil(Math.max(128, (4096 * ticks) / rate) * 25.4) ||
        view.getUint8(i + 9) >= classes.length
      )
        return false;
      previousEnd = end;
    }
  }
  return true;
}

/** Prefix sums are built once per actor and installed stride profile. Pauses are gaps in this table. */
export function integrateGait(text, rate, strideAt) {
  if (!text) return () => 0;
  const view = unbox(text);
  const length = view.byteLength / bytesPerStep;
  const ends = new Uint32Array(length);
  const spans = new Uint8Array(length);
  const phases = new Float64Array(length + 1);
  for (let i = 0; i < length; i++) {
    const offset = i * bytesPerStep;
    ends[i] = view.getUint32(offset, true);
    spans[i] = view.getUint8(offset + 4);
    const distance = view.getUint16(offset + 5, true) / 1000;
    const bearing = view.getUint8(offset + 7) * (360 / 256);
    const duck = view.getUint8(offset + 8) / 255;
    const weapon = classes[view.getUint8(offset + 9)];
    const stride = distance && strideAt(weapon, (distance * rate) / spans[i], duck, bearing);
    phases[i + 1] = phases[i] + (stride > 0 ? distance / stride : 0);
  }
  return (tick) => {
    const lo = firstEndAfter(ends, tick);
    if (lo === length) return phases[lo];
    const progress = Math.max(0, (tick - ends[lo] + spans[lo]) / spans[lo]);
    return phases[lo] + (phases[lo + 1] - phases[lo]) * progress;
  };
}

function firstEndAfter(ends, tick) {
  let lo = 0,
    hi = ends.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (ends[mid] <= tick) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const stationary = Object.freeze({ speed: 0, velocityX: 0, velocityY: 0, coherence: 0 });

/** Centred secant of the recorded horizontal trajectory, clipped to a continuous run.
 * The full-match history supplies both sides even at a cold playback-chunk boundary. */
export function centeredGaitMotion(text, rate) {
  if (!text) return () => stationary;
  const view = unbox(text);
  const count = view.byteLength / bytesPerStep;
  const ends = new Uint32Array(count),
    spans = new Uint8Array(count);
  const vx = new Float32Array(count),
    vy = new Float32Array(count),
    speeds = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const offset = i * bytesPerStep;
    ends[i] = view.getUint32(offset, true);
    spans[i] = view.getUint8(offset + 4);
    const angle = view.getUint16(offset + 10, true) * ((2 * Math.PI) / 65536);
    const speed = (view.getUint16(offset + 5, true) * rate) / (1000 * spans[i]);
    vx[i] = speed * Math.cos(angle);
    vy[i] = speed * Math.sin(angle);
    speeds[i] = speed;
  }
  const radius = rate * 0.1;
  const start = (index) => ends[index] - spans[index];
  return (tick) => {
    let middle = firstEndAfter(ends, tick);
    if (middle === count || tick < start(middle)) {
      // Keep the old run's last sample at its exact endpoint. The open gap is idle.
      if (middle === 0 || ends[middle - 1] !== tick) return stationary;
      middle--;
    }
    const left = tick - radius,
      right = tick + radius;
    let from = middle;
    while (from > 0 && start(from) > left && ends[from - 1] === start(from)) from--;
    let x = 0,
      y = 0,
      travel = 0,
      duration = 0;
    for (let i = from; i < count && start(i) < right; i++) {
      if (i > from && ends[i - 1] !== start(i)) break;
      const span = Math.min(ends[i], right) - Math.max(start(i), left);
      x += vx[i] * span;
      y += vy[i] * span;
      travel += speeds[i] * span;
      duration += span;
    }
    if (duration <= 0 || travel <= 0) return stationary;
    const length = Math.hypot(x, y);
    return {
      speed: length / duration,
      velocityX: x / duration,
      velocityY: y / duration,
      coherence: Math.min(1, length / travel),
    };
  };
}
