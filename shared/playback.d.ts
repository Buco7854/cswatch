/** Versioned browser/server contract. Coordinates are Source units, Z up. IDs are strings. */
import type { VoicePacket, ChatMessage, CaptionCue, CommunicationInfo } from './communications.js';
export type Player = { id: string; name: string; team: number };
/** Recorded actions, independent of the player's physical keyboard layout/binds. */
export type RecordedInput = {
  source: 'usercmd' | 'network';
  /** Unsigned 64-bit masks are decimal strings, never rounded JavaScript numbers. */
  buttons?: string;
  pressedButtons?: string;
  releasedButtons?: string;
  forward?: boolean;
  back?: boolean;
  left?: boolean;
  right?: boolean;
  jump?: boolean;
  duck?: boolean;
  walk?: boolean;
  attack?: boolean;
  attack2?: boolean;
  reload?: boolean;
  use?: boolean;
  /** Actual command mouse counts, not deltas inferred from view angles. */
  mouseDx?: number;
  mouseDy?: number;
};
export type ReplayCapabilities = {
  economy: boolean;
  equipment: boolean;
  inventory: boolean;
  inputButtons: 'usercmd' | 'network' | 'unavailable';
  mouseInput: boolean;
  utilityThrows: boolean;
};
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
  helmet?: boolean;
  defuser?: boolean;
  scoped?: boolean;
  defusing?: boolean;
  equipmentValue?: number;
  startMoney?: number;
  spentThisRound?: number;
  inventory?: string[];
  input?: RecordedInput;
};
export type Frame = { tick: number; players: Position[] };
export type GameEvent = {
  type: string;
  tick: number;
  attacker_name?: string;
  user_name?: string;
  attacker_steamid?: string | null;
  user_steamid?: string | null;
  assister_steamid?: string | null;
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
  capabilities?: ReplayCapabilities;
  voice?: VoicePacket[];
  chat?: ChatMessage[];
  captions?: CaptionCue[];
  communications?: CommunicationInfo;
  /** Global Source-coordinate bounds keep cameras and plots stable while time slices change. */
  worldBounds?: {
    minX: number;
    minY: number;
    minZ: number;
    maxX: number;
    maxY: number;
    maxZ: number;
  };
};

/** Version 2 transport keeps the version 1 rendering domain, but streams bounded time slices. */
export type ReplayChunkInfo = {
  index: number;
  startTick: number;
  firstFrameTick: number;
  endTick: number;
  frames: number;
  /** Decoded JSON byte length, bounded independently of compressed transfer size. */
  bytes: number;
};
export type PlaybackManifest = Omit<Playback, 'version' | 'frames' | 'grenades' | 'voice'> & {
  version: 2;
  firstTick: number;
  lastTick: number;
  chunks: ReplayChunkInfo[];
};
export type PlaybackChunk = {
  version: 2;
  index: number;
  frames: Frame[];
  grenades: Grenade[];
  voice?: VoicePacket[];
};
