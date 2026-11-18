import { useEffect, useState } from 'react';
import type { AssetStatus } from './map-assets';

export type AgentAssets = { ct: string | null; t: string | null };
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
    let active = true;
    const controller = new AbortController(),
      timeout = window.setTimeout(() => controller.abort(), 10000);
    setState({ identity, value: pending });
    void (async () => {
      try {
        const response = await fetch('/api/assets/agents', {
          credentials: 'same-origin',
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) throw new Error('Agent discovery failed');
        const text = await response.text();
        if (text.length > 1024) throw new Error('Agent discovery exceeded its bound');
        const assets = validateAgentAssets(JSON.parse(text));
        if (active && !controller.signal.aborted)
          setState({
            identity,
            value: { status: assets.ct || assets.t ? 'ready' : 'missing', assets },
          });
      } catch {
        if (active) setState({ identity, value: { status: 'error', assets: empty } });
      } finally {
        window.clearTimeout(timeout);
      }
    })();
    return () => {
      active = false;
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [identity, enabled]);
  return !enabled
    ? { status: 'missing', assets: empty }
    : state.identity === identity
      ? state.value
      : pending;
}
