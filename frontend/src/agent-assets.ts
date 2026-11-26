import { useEffect, useState } from 'react';
import type { AssetStatus } from './map-assets';
import type { Playback } from '../../shared/playback';
import { observeAssets, readAssetJSON } from './asset-discovery';
import { agentModelLimits, officialAgentModels } from '../../shared/agent-models.mjs';

type AgentAssets = {
  ct: string | null;
  t: string | null;
  actions: string | null;
  /** Prepared official agents by recorded model handle. */
  models: Readonly<Record<string, string>>;
};
const empty: AgentAssets = Object.freeze({ ct: null, t: null, actions: null, models: {} });
type State = { status: AssetStatus; assets: AgentAssets };
const pending: State = { status: 'pending', assets: empty };
export function validateAgentAssets(value: unknown): AgentAssets {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid agent assets');
  const input = value as Record<string, unknown>;
  if (
    (input.ct !== null && input.ct !== '/map-assets/agents/ct.glb') ||
    (input.t !== null && input.t !== '/map-assets/agents/t.glb') ||
    (input.actions !== undefined &&
      input.actions !== null &&
      input.actions !== '/map-assets/agents/actions.glb')
  )
    throw new Error('Invalid agent assets');
  const models = input.models ?? {};
  if (
    !models ||
    typeof models !== 'object' ||
    Array.isArray(models) ||
    Object.keys(models).length > agentModelLimits.catalogue ||
    Object.entries(models).some(
      ([handle, url]) =>
        !officialAgentModels.has(handle) || url !== `/map-assets/agent-models/${handle}.glb`,
    )
  )
    throw new Error('Invalid agent assets');
  return {
    ct: input.ct as string | null,
    t: input.t as string | null,
    actions: (input.actions as string | null | undefined) ?? null,
    models: Object.freeze({ ...(models as Record<string, string>) }),
  };
}
/* Per-player official agent models. A recorded catalogue agent replaces the team model only once
 * it is prepared and resident; the team model stays meanwhile and whenever it is unavailable. The
 * variant is a skin: it borrows its team model's clips and the shared action bank. */
export type AgentModelChoice = { url: string; clips?: string };
type TeamModels = { ct: string | null; t: string | null };

/** The recorded variant URL a player would use, prepared or not. */
export function agentVariantUrl(
  team: number,
  handle: string | undefined,
  models: Readonly<Record<string, string>>,
) {
  const agent = handle ? officialAgentModels.get(handle) : undefined;
  return agent && agent.team === (team === 3 ? 'ct' : 't') ? models[agent.handle] : undefined;
}

export function agentModelChoice(
  team: number,
  handle: string | undefined,
  teams: TeamModels,
  models: Readonly<Record<string, string>>,
  ready: ReadonlySet<string>,
): AgentModelChoice | null {
  const teamUrl = team === 3 ? teams.ct : teams.t;
  if (!teamUrl) return null;
  const url = agentVariantUrl(team, handle, models);
  return url && ready.has(url) ? { url, clips: teamUrl } : { url: teamUrl };
}

const scanned = new WeakMap<Playback, Map<string, { frames: number; handle?: string }>>();
/** The handle a player last recorded while alive on a team: a corpse keeps its agent. A player's
 * agent is fixed for a team, so any living frame of the loaded replay answers. */
export function recordedAgentHandle(data: Playback, id: string, team: number) {
  let cache = scanned.get(data);
  if (!cache) scanned.set(data, (cache = new Map()));
  const key = id + ':' + team,
    known = cache.get(key);
  if (known && (known.handle || known.frames === data.frames.length)) return known.handle;
  let handle: string | undefined;
  for (let i = data.frames.length - 1; i >= 0 && !handle; i--)
    for (const player of data.frames[i].players)
      if (player.id === id && player.team === team && player.alive && player.agentModel) {
        handle = player.agentModel;
        break;
      }
  cache.set(key, { frames: data.frames.length, handle });
  return handle;
}

/** Catalogued official agents a replay recorded; other handles keep the team model. */
export function recordedAgentVariants(handles: readonly string[] | undefined): string[] {
  return [...new Set(handles ?? [])].filter((handle) => officialAgentModels.has(handle)).sort();
}
/** Installed actors are fixed local assets. Discovery never survives a different viewer identity. */
export function useAgentAssets(
  identity: string,
  enabled: boolean,
  /** Recorded catalogue handles: discovery continues until each one is prepared. */
  wanted: readonly string[] = [],
): State {
  const wantedKey = wanted.join(',');
  const [state, setState] = useState<{ identity: string; value: State }>({
    identity,
    value: pending,
  });
  useEffect(() => {
    if (!enabled) return;
    setState({ identity, value: pending });
    return observeAssets({
      read: async (signal) =>
        validateAgentAssets(await readAssetJSON('/api/assets/agents', 16384, signal)),
      complete: (assets) =>
        Boolean(assets.ct && assets.t) &&
        (!wantedKey || wantedKey.split(',').every((handle) => assets.models[handle])),
      fingerprint: JSON.stringify,
      changed: (assets) =>
        setState((previous) => {
          const status = assets.ct || assets.t ? 'ready' : 'missing';
          if (
            previous.identity === identity &&
            previous.value.status === status &&
            previous.value.assets.ct === assets.ct &&
            previous.value.assets.t === assets.t &&
            previous.value.assets.actions === assets.actions &&
            JSON.stringify(previous.value.assets.models) === JSON.stringify(assets.models)
          )
            return previous;
          return { identity, value: { status, assets } };
        }),
      failed: () =>
        setState((previous) =>
          previous.identity === identity &&
          (previous.value.status === 'error' || previous.value.assets.ct || previous.value.assets.t)
            ? previous
            : { identity, value: { status: 'error', assets: empty } },
        ),
    });
  }, [identity, enabled, wantedKey]);
  return !enabled
    ? { status: 'missing', assets: empty }
    : state.identity === identity
      ? state.value
      : pending;
}
