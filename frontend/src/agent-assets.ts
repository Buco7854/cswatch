import { useEffect, useState } from 'react';
import type { AssetStatus } from './map-assets';
import { observeAssets, readAssetJSON } from './asset-discovery';

type AgentAssets = { ct: string | null; t: string | null };
const empty: AgentAssets = Object.freeze({ ct: null, t: null });
type State = { status: AssetStatus; assets: AgentAssets };
const pending: State = { status: 'pending', assets: empty };
export function validateAgentAssets(value: unknown): AgentAssets {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid agent assets');
  const input = value as Record<string, unknown>;
  if (
    (input.ct !== null && input.ct !== '/map-assets/agents/ct.glb') ||
    (input.t !== null && input.t !== '/map-assets/agents/t.glb')
  )
    throw new Error('Invalid agent assets');
  return { ct: input.ct as string | null, t: input.t as string | null };
}
/** Installed actors are fixed local assets. Discovery never survives a different viewer identity. */
export function useAgentAssets(identity: string, enabled: boolean): State {
  const [state, setState] = useState<{ identity: string; value: State }>({
    identity,
    value: pending,
  });
  useEffect(() => {
    if (!enabled) return;
    setState({ identity, value: pending });
    return observeAssets({
      read: async (signal) =>
        validateAgentAssets(await readAssetJSON('/api/assets/agents', 1024, signal)),
      complete: (assets) => Boolean(assets.ct && assets.t),
      changed: (assets) =>
        setState((previous) => {
          const status = assets.ct || assets.t ? 'ready' : 'missing';
          if (
            previous.identity === identity &&
            previous.value.status === status &&
            previous.value.assets.ct === assets.ct &&
            previous.value.assets.t === assets.t
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
  }, [identity, enabled]);
  return !enabled
    ? { status: 'missing', assets: empty }
    : state.identity === identity
      ? state.value
      : pending;
}
