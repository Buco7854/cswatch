import type { AgentWeaponClass } from './agent-animation.js';
import type { Playback } from './playback.js';

export type GaitHistory = { version: 2; players: [id: string, encoded: string][] };
export type AgentStrideAt = (
  weapon: AgentWeaponClass,
  speed: number,
  duck: number,
  bearing: number,
) => number;
export function agentWeaponClass(weapon: string): AgentWeaponClass;
export function encodeGaitHistory(data: Playback): GaitHistory | undefined;
export function validGaitHistory(
  history: unknown,
  actors: ReadonlySet<string>,
  first?: number,
  last?: number,
  rate?: number,
): history is GaitHistory;
export function integrateGait(
  encoded: string | undefined,
  rate: number,
  strideAt: AgentStrideAt,
  version: GaitHistory['version'],
): (tick: number) => number;

export type GaitMotion = { speed: number; velocityX: number; velocityY: number; coherence: number };
export type GaitMotionAt = ((tick: number) => GaitMotion) & { duckAt(tick: number): number };
export function centeredGaitMotion(encoded: string | undefined, rate: number): GaitMotionAt;
