import type { GameEvent, Grenade, Playback } from './types';
import { frameAt } from './playback';
import { projectileEquipment } from './projectile-equipment';
import { tacticalPalette } from './tactical-palette';

export type GrenadePathsMode = 'all' | 'selected' | 'off';

const fadeSeconds = 5;
const maxPaths = 32;
const maxPoints = 512;
const maxBounces = 8;
const kinds: Readonly<Record<string, { color: string; detonation: string }>> = {
  smokegrenade: { color: '#c1e0c7', detonation: 'smokegrenade_detonate' },
  flashbang: { color: '#fff3a6', detonation: 'flashbang_detonate' },
  hegrenade: { color: '#ff806c', detonation: 'hegrenade_detonate' },
  molotov: { color: '#ffab63', detonation: 'inferno_startburn' },
  incgrenade: { color: '#ffab63', detonation: 'inferno_startburn' },
  decoy: { color: '#ccb3ff', detonation: 'decoy_started' },
};
const fire = kinds.molotov;
const neutral = '#d4dce0';

export type GrenadePath = {
  id: string;
  points: Grenade['points'];
  start: number;
  end: number;
  owner?: string;
  color: string;
  marker: string;
  bounces: number[];
};

function bounceIndices(points: Grenade['points']) {
  const indices: number[] = [];
  for (let i = 1; i + 1 < points.length && indices.length < maxBounces; i++) {
    const a = points[i - 1],
      b = points[i],
      c = points[i + 1];
    if (b.tick - a.tick > 8 || c.tick - b.tick > 8) continue;
    const ux = b.x - a.x,
      uy = b.y - a.y,
      uz = b.z - a.z;
    const vx = c.x - b.x,
      vy = c.y - b.y,
      vz = c.z - b.z;
    const lengths = Math.hypot(ux, uy, uz) * Math.hypot(vx, vy, vz);
    // A sharp turn between consecutive recorded segments marks the intervening sample.
    if (lengths >= 18 && ux * vx + uy * vy + uz * vz <= lengths * 0.42) indices.push(i);
  }
  return indices;
}

export function grenadePathEvents(events: Playback['events']) {
  const byEntity = new Map<number, GameEvent[]>();
  const eventKinds = new Set(Object.values(kinds).map((kind) => kind.detonation));
  eventKinds.add('grenade_thrown');
  for (const event of events) {
    if (!eventKinds.has(event.type)) continue;
    const entity = event.entityid;
    if (typeof entity !== 'number' || !Number.isSafeInteger(entity) || entity <= 0) continue;
    const list = byEntity.get(entity);
    if (list) list.push(event);
    else byEntity.set(entity, [event]);
  }
  return byEntity;
}

export function indexGrenadePaths(
  paths: Grenade[] | undefined,
  events: ReturnType<typeof grenadePathEvents>,
  players: Playback['players'],
  rate: number,
  frames?: Playback['frames'],
): GrenadePath[] {
  if (!paths || !Number.isFinite(rate) || rate <= 0) return [];
  const byId = new Map(players.map((player) => [player.id, player]));
  const result: GrenadePath[] = [];
  for (const path of paths) {
    if (!path.points.length || path.points.length > maxPoints) continue;
    const first = path.points[0].tick,
      last = path.points.at(-1)!.tick;
    const nativeId = /^(\d{1,10})-(\d{1,9})$/.exec(path.id);
    const related = nativeId ? events.get(Number(nativeId[1])) : undefined;
    const start = nativeId ? Math.min(first, Number(nativeId[2])) : first;
    const equipment = projectileEquipment(path.kind);
    const kind =
      path.kind === 'CMolotovProjectile' ? fire : equipment ? kinds[equipment] : undefined;
    const detonations = related?.filter(
      (event) =>
        event.type === kind?.detonation &&
        event.tick >= start &&
        event.tick <= Math.min(start + 12 * rate, last + rate / 4),
    );
    const detonation = detonations?.length === 1 ? detonations[0] : undefined;
    const throws = related?.filter(
      (event) => event.type === 'grenade_thrown' && Math.abs(event.tick - start) <= rate / 4,
    );
    const release = throws?.length === 1 ? throws[0] : undefined;
    const throwId = release?.user_steamid;
    const detonationId = detonation?.user_steamid;
    const ownerId =
      throwId && detonationId && throwId !== detonationId ? undefined : throwId || detonationId;
    const owner = typeof ownerId === 'string' ? byId.get(ownerId) : undefined;
    const end = detonation?.tick ?? last;
    const eventTeam = release?.user_team_num ?? detonation?.user_team_num;
    const team =
      owner &&
      (eventTeam === 2 || eventTeam === 3
        ? eventTeam
        : frames?.length
          ? frameAt({ frames }, Math.max(first, frames[0].tick)).frame.players.find(
              (pawn) => pawn.id === owner.id,
            )?.team
          : owner.team);
    const points = path.points.slice(0, revealedPoints(path.points, end));
    if (!points.length) continue;
    result.push({
      id: path.id,
      points,
      start: first,
      end,
      owner: owner?.id,
      color: team === 3 ? tacticalPalette.ct : team === 2 ? tacticalPalette.t : neutral,
      marker: kind?.color ?? neutral,
      bounces: bounceIndices(points),
    });
  }
  return result.sort((a, b) => b.start - a.start || a.id.localeCompare(b.id));
}

export function revealedPoints(points: GrenadePath['points'], tick: number) {
  let low = 0,
    high = points.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (points[middle].tick <= tick) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function grenadePathOpacity(path: GrenadePath, tick: number, rate: number, steady = false) {
  if (tick < path.start || tick >= path.end + rate * fadeSeconds) return 0;
  return steady ? 1 : 1 - Math.max(0, tick - path.end) / (rate * fadeSeconds);
}

export function visibleGrenadePaths(
  paths: GrenadePath[],
  tick: number,
  rate: number,
  mode: GrenadePathsMode,
  selected: string,
) {
  if (mode === 'off') return [];
  const visible: GrenadePath[] = [];
  for (const path of paths) {
    if (mode === 'selected' && path.owner !== selected) continue;
    if (!grenadePathOpacity(path, tick, rate)) continue;
    visible.push(path);
    if (visible.length === maxPaths) break;
  }
  return visible;
}
