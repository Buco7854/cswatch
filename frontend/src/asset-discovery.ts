import { readMapJSON } from './demo-map-assets';

export const assetDiscoveryLimits = Object.freeze({
  durationMs: 45 * 60 * 1000,
  requestMs: 10000,
  delaysMs: [2000, 5000, 15000, 30000] as readonly number[],
});

class AssetDiscoveryDenied extends Error {}

/** Only compile-time fixed local catalog paths are supplied by callers. */
export async function readAssetJSON(path: string, bytes: number, signal: AbortSignal) {
  const response = await fetch(path, {
    signal,
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  });
  if (response.status === 401 || response.status === 403)
    throw new AssetDiscoveryDenied('Asset discovery requires access');
  if (!response.ok) throw new Error('Asset discovery unavailable');
  return readMapJSON(response, bytes);
}

/** One mounted identity owns one finite read-only observation lease. Valid
 * partial values belong to the caller and are never erased by a later failure. */
export function observeAssets<Value>({
  read,
  complete,
  changed,
  failed,
}: {
  read: (signal: AbortSignal) => Promise<Value>;
  complete: (value: Value) => boolean;
  changed: (value: Value) => void;
  failed?: () => void;
}) {
  let active = true;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let request: AbortController | undefined;
  let attempts = 0;
  const started = performance.now();
  const current = () => active && performance.now() - started < assetDiscoveryLimits.durationMs;
  async function refresh() {
    if (!current()) return;
    const controller = new AbortController();
    request = controller;
    deadline = setTimeout(() => controller.abort(), assetDiscoveryLimits.requestMs);
    let finished = false;
    try {
      const value = await read(controller.signal);
      if (!current() || controller.signal.aborted) return;
      changed(value);
      finished = complete(value);
    } catch (error) {
      if (!current()) return;
      failed?.();
      finished = error instanceof AssetDiscoveryDenied;
    } finally {
      clearTimeout(deadline);
      deadline = undefined;
      if (request === controller) request = undefined;
      if (current() && !finished) {
        const wait =
          assetDiscoveryLimits.delaysMs[
            Math.min(attempts++, assetDiscoveryLimits.delaysMs.length - 1)
          ];
        const remaining = assetDiscoveryLimits.durationMs - (performance.now() - started);
        if (wait < remaining) retry = setTimeout(() => void refresh(), wait);
      }
    }
  }
  void refresh();
  return () => {
    active = false;
    clearTimeout(retry);
    clearTimeout(deadline);
    request?.abort();
    request = undefined;
  };
}
