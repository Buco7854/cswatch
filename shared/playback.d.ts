/** Versioned browser/server contract. Coordinates are Source units, Z up. IDs are strings. */
export type Player = { id: string; name: string; team: number };
export type Position = {
  id: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  health: number;
  team: number;
  alive: boolean;
  weapon: string;
  armor?: number;
  money?: number;
  ammo?: number;
  duck?: number;
  flash?: number;
};
export type Frame = { tick: number; players: Position[] };
export type GameEvent = {
  type: string;
  tick: number;
  attacker_name?: string;
  user_name?: string;
  weapon?: string;
  winner?: number;
  x?: number;
  y?: number;
  z?: number;
  [key: string]: unknown;
};
export type DeadTime = { start: number; end: number; kind: 'freeze' | 'timeout' | 'technical' };
export type GrenadePoint = { tick: number; x: number; y: number; z: number };
export type Grenade = { id: string; kind: string; points: GrenadePoint[] };
export type Playback = {
  version: 1;
  map: string;
  tickRate: number;
  sample: boolean;
  players: Player[];
  rounds: { number: number; tick: number; liveTick?: number; endTick?: number; winner?: number }[];
  events: GameEvent[];
  frames: Frame[];
  deadTimes?: DeadTime[];
  grenades?: Grenade[];
  warnings?: string[];
};
