import type { Frame, Position } from './playback.js';

export type AgentDeathAnchor = Pick<Position, 'id' | 'x' | 'y' | 'z' | 'yaw' | 'team'> & {
  tick: number;
};
export function deathAnchor(
  frames: readonly Frame[],
  id: string,
  tick: number,
  roundStart: number,
  rate: number,
): AgentDeathAnchor | undefined;
export const agentDeathLimit: number;
export function validAgentDeaths(value: unknown): value is AgentDeathAnchor[];
