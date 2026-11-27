import type { GaitHistory } from './agent-gait-history.mjs';
import type { AimChunk } from './aim-track.mjs';
/** Versioned browser/server contract. Coordinates are Source units, Z up. IDs are strings. */
import type { VoicePacket, ChatMessage, CaptionCue, CommunicationInfo } from './communications.js';
import type { ObjectiveData } from './objectives.js';
import type { MatchStateData, EventAvailability } from './match-state.js';
import type { ThrowInputSnapshot } from './throw-input.js';
import type { CrosshairData } from './crosshairs.js';
import type { ItemSample, ItemStateInfo } from './item-state.js';
import type { GameplaySoundCue, GameplaySoundInfo } from './gameplay-sounds.js';
import type { MapIdentity } from './map-acquisition.js';
import type { AgentDeathAnchor } from './agent-deaths.mjs';
import type { SmokeTrack } from './smoke-state.mjs';
import type { MapBreakable, MapDoor, MapVisibility } from './map-breakables.mjs';
import type { InfernoBank } from './inferno-state.mjs';
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
/** Actual cumulative controller counters at this frame, including earlier
 * match history when the recording begins late. Missing fields stay unknown. */
export type RecordedPlayerStats = {
  kills?: number;
  deaths?: number;
  assists?: number;
  headshotKills?: number;
  damage?: number;
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
  /** First observed active-weapon reload sample after a contiguous recorded false sample. */
  reloadStarted?: number;
  duck?: number;
  flash?: number;
  helmet?: boolean;
  defuser?: boolean;
  scoped?: boolean;
  /** M4A1-S and USP-S: whether the recorded silencer is attached. */
  silencer?: boolean;
  /** FAMAS and Glock-18: whether the recorded burst mode is on. */
  burst?: boolean;
  /** Narrow field of view reported by the recorded player camera service. */
  scopeFov?: number;
  /** Recorded eye offset in Source inches. The short form has zero XY. */
  eyeOffset?: [height: number] | [x: number, y: number, height: number];
  defusing?: boolean;
  equipmentValue?: number;
  startMoney?: number;
  spentThisRound?: number;
  inventory?: string[];
  input?: RecordedInput;
  stats?: RecordedPlayerStats;
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
type GrenadePoint = { tick: number; x: number; y: number; z: number };
export type Grenade = { id: string; kind: string; points: GrenadePoint[] };
export type Playback = {
  map: string;
  mapIdentity?: MapIdentity;
  tickRate: number;
  sample: boolean;
  players: Player[];
  rounds: { number: number; tick: number; liveTick?: number; endTick?: number; winner?: number }[];
  events: GameEvent[];
  frames: Frame[];
  deadTimes?: DeadTime[];
  grenades?: Grenade[];
  smokeTracks?: SmokeTrack[];
  infernos?: InfernoBank;
  mapBreakables?: MapBreakable[];
  mapDoors?: MapDoor[];
  mapVisibility?: MapVisibility[];
  warnings?: string[];
  capabilities?: ReplayCapabilities;
  voice?: VoicePacket[];
  sounds?: GameplaySoundCue[];
  chat?: ChatMessage[];
  captions?: CaptionCue[];
  communications?: CommunicationInfo;
  gameplaySounds?: GameplaySoundInfo;
  objectives?: ObjectiveData;
  matchState?: MatchStateData;
  eventAvailability?: EventAvailability;
  throwInputs?: ThrowInputSnapshot[];
  crosshairs?: CrosshairData;
  itemSamples?: ItemSample[];
  itemState?: ItemStateInfo;
  strideAnchor?: { tick: number; players: [id: string, centimeters: number][] };
  /** Last nearby living pose for a recorded death when recorded within budget. */
  agentDeaths?: AgentDeathAnchor[];
  /** Pack-independent movement intervals for deterministic directional gait. */
  gaitHistory?: GaitHistory;
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

/** Version 3 transport streams bounded time slices. */
export type ReplayChunkInfo = {
  index: number;
  startTick: number;
  firstFrameTick: number;
  endTick: number;
  frames: number;
  /** Decoded JSON byte length, bounded independently of compressed transfer size. */
  bytes: number;
  /** Observed distance at the first primary sample, when it fits the manifest budget. */
  stride?: [id: string, centimeters: number][];
};
type RequiredReplayMetadata =
  | 'deadTimes'
  | 'warnings'
  | 'chat'
  | 'communications'
  | 'gameplaySounds'
  | 'objectives'
  | 'matchState'
  | 'crosshairs'
  | 'itemState'
  | 'eventAvailability'
  | 'throwInputs'
  | 'capabilities'
  | 'worldBounds';
export type PlaybackManifest = Omit<
  Playback,
  'frames' | 'grenades' | 'voice' | 'sounds' | 'itemSamples' | 'strideAnchor' | 'captions'
> &
  Required<Pick<Playback, RequiredReplayMetadata>> & {
    version: 3;
    firstTick: number;
    lastTick: number;
    chunks: ReplayChunkInfo[];
  };
export type PlaybackChunk = {
  aim?: AimChunk;
  version: 3;
  index: number;
  frames: Frame[];
  grenades: Grenade[];
  voice: VoicePacket[];
  sounds: GameplaySoundCue[];
  /** First live state before this slice plus changes. Tombstones close entity lifetimes. */
  itemSamples: ItemSample[];
};
