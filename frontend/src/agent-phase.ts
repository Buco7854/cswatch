import {
  integrateGait,
  centeredGaitMotion,
  type GaitMotionAt,
  type AgentStrideAt,
  type GaitHistory,
} from '../../shared/agent-gait-history.mjs';

type PhaseAt = (tick: number) => number;
const tables = new WeakMap<GaitHistory, Map<string, PhaseAt>>();

export function agentPhaseAt(
  history: GaitHistory,
  id: string,
  rate: number,
  profile: { key: string; strideAt: AgentStrideAt },
) {
  let actors = tables.get(history);
  if (!actors) tables.set(history, (actors = new Map()));
  const key = id + ':' + rate + ':' + profile.key;
  let sample = actors.get(key);
  if (!sample) {
    sample = integrateGait(
      history.players.find(([actor]) => actor === id)?.[1],
      rate,
      profile.strideAt,
      history.version,
    );
    actors.set(key, sample);
  }
  return sample;
}

const motionTables = new WeakMap<GaitHistory, Map<string, GaitMotionAt>>();

export function agentCenteredMotionAt(history: GaitHistory, id: string, rate: number) {
  if (history.version !== 2) return;
  let actors = motionTables.get(history);
  if (!actors) motionTables.set(history, (actors = new Map()));
  const key = id + ':' + rate;
  let sample = actors.get(key);
  if (!sample) {
    sample = centeredGaitMotion(history.players.find(([actor]) => actor === id)?.[1], rate);
    actors.set(key, sample);
  }
  return sample;
}
