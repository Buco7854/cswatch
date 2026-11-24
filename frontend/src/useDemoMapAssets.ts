import { requestData } from './api';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  pendingDemoMap,
  failedDemoMap,
  readMapJSON,
  validateDemoMapAssets,
  retryableMapFailures,
  mapAcquisitionKey,
  type DemoMapState,
} from './demo-map-assets';

const delays = [1000, 2000, 5000, 10000];
const missingDemoMap: DemoMapState = {
  ...pendingDemoMap,
  status: 'missing',
  overviewStatus: 'missing',
};
/** One viewer lease observes a durable job. Cleanup cancels HTTP, never the shared job. */
export function useDemoMapAssets(
  id: string | undefined,
  map: string | undefined,
  userId: string | undefined,
  replayReady: boolean,
) {
  const discoverable = Boolean(id && map && /^[a-zA-Z0-9_-]{1,80}$/.test(map));
  const identity = useMemo(() => ({ id, map, userId }), [id, map, userId]);
  const [snapshot, setSnapshot] = useState<{ identity: object; state: DemoMapState }>();
  const lease = useRef<
    | { identity: object; retry: () => void; check: () => void; acquireIfReady: () => void }
    | undefined
  >(undefined);
  const canPrepare = useRef(replayReady);
  canPrepare.current = replayReady;
  const current = useRef(identity);
  current.current = identity;
  useEffect(() => {
    if (!discoverable) return;
    let active = true,
      timeout: ReturnType<typeof setTimeout> | undefined,
      request: AbortController | undefined;
    const attempted = new Set<string>(),
      uncertain = new Set<string>();
    let poll = 0,
      readinessPoll = 0,
      cooldownChecks = 0,
      retryBusy = false;
    let latest: DemoMapState = pendingDemoMap;
    const started = Date.now();
    const live = () => active && current.current === identity;
    const publish = (state: DemoMapState) => {
      if (live()) {
        latest = state;
        setSnapshot({ identity, state });
      }
    };
    async function fetchJSON(path: string, init: RequestInit = {}) {
      const controller = new AbortController();
      request = controller;
      const deadline = setTimeout(() => controller.abort(), 15000);
      try {
        return await requestData(
          path,
          {
            ...init,
            credentials: 'same-origin',
            redirect: 'error',
            signal: controller.signal,
            headers: { Accept: 'application/json', ...init.headers },
          },
          async (response) => {
            if (!response.ok && response.status !== 503) throw new Error('Map discovery failed');
            return readMapJSON(response);
          },
        );
      } finally {
        clearTimeout(deadline);
        if (request === controller) request = undefined;
      }
    }
    async function acquire() {
      // Fresh guest uploads can precede the shell's next auth refresh. Read the
      // current capability directly, without publishing or replacing auth state.
      const auth = (await fetchJSON('/api/auth/me')) as {
        user?: { id?: unknown; csrf?: unknown } | null;
        guest_session?: { csrf?: unknown } | null;
      };
      if (!live()) return;
      const token = userId
        ? auth.user?.id === userId
          ? auth.user.csrf
          : undefined
        : !auth.user
          ? auth.guest_session?.csrf
          : undefined;
      if (typeof token !== 'string' || !token || token.length > 1024)
        throw new Error('Map acquisition capability unavailable');
      return fetchJSON(`/api/demos/${encodeURIComponent(id!)}/map-assets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
        body: '{}',
      });
    }
    function schedule(state: DemoMapState, readiness = false) {
      if (!live()) return;
      if (Date.now() - started >= 45 * 60 * 1000) {
        publish({ ...state, pollingEnded: true });
        return;
      }
      const interval = readiness
        ? [2000, 5000, 15000, 30000][Math.min(readinessPoll++, 3)]
        : delays[Math.min(poll++, delays.length - 1)];
      timeout = setTimeout(() => void check(), interval);
    }
    function observe(state: DemoMapState) {
      if (state.acquisition && ['queued', 'processing'].includes(state.acquisition.acquisition))
        schedule(state);
      else if (
        state.acquisition?.acquisition === 'unavailable' &&
        ['worker_unavailable', 'inventory_unavailable', 'inventory_stale'].includes(
          state.acquisition.readinessReason || '',
        )
      )
        schedule(state, true);
      else if (
        state.acquisition?.acquisition === 'failed' &&
        !state.acquisition.canAcquire &&
        retryableMapFailures.has(state.acquisition.code || '') &&
        cooldownChecks++ < 6 &&
        live()
      ) {
        // Sparse, bounded read-only cooldown checks never enqueue a failed job.
        timeout = setTimeout(() => void check(), 60000);
      }
    }
    function accept(state: DemoMapState) {
      const key = mapAcquisitionKey(state.acquisition);
      const next =
        key && uncertain.has(key) && state.acquisition?.canAcquire
          ? { ...state, requestUnconfirmed: true }
          : state;
      publish(next);
      return next;
    }
    function needsAcquisition(state: DemoMapState) {
      const key = mapAcquisitionKey(state.acquisition);
      return Boolean(
        state.acquisition?.canAcquire &&
        state.acquisition.acquisition === 'unavailable' &&
        key &&
        !attempted.has(key),
      );
    }
    async function requestAcquisition(state: DemoMapState) {
      const key = mapAcquisitionKey(state.acquisition);
      if (!key) return;
      attempted.add(key);
      retryBusy = true;
      publish({ ...state, requesting: true, requestUnconfirmed: false });
      try {
        const result = await acquire();
        if (!live()) return;
        const next = validateDemoMapAssets(result, map!);
        uncertain.delete(key);
        retryBusy = false;
        const accepted = accept(next);
        // Selection can change while the server handles a POST. Observe it
        // through a bounded GET before authorizing one request for its new key.
        // Never recursively enqueue from a mutation response.
        if (needsAcquisition(accepted)) schedule(accepted);
        else observe(accepted);
      } catch {
        // A lost POST may already be accepted. Observe, never replay it.
        uncertain.add(key);
        if (live()) schedule(state);
      }
    }
    async function check() {
      try {
        const discovered = validateDemoMapAssets(
          await fetchJSON(`/api/demos/${encodeURIComponent(id!)}/map-assets`),
          map!,
        );
        if (!live()) return;
        retryBusy = false;
        const state = accept(discovered);
        if (canPrepare.current && needsAcquisition(state)) {
          await requestAcquisition(state);
          return;
        }
        observe(state);
      } catch {
        retryBusy = false;
        if (live()) publish(failedDemoMap);
      }
    }
    lease.current = {
      identity,
      acquireIfReady: () => {
        if (live() && !request && !retryBusy && needsAcquisition(latest))
          void requestAcquisition(latest);
      },
      check: () => {
        if (!live() || request || retryBusy) return;
        clearTimeout(timeout);
        void check();
      },
      retry: () => {
        if (
          !live() ||
          request ||
          retryBusy ||
          latest.acquisition?.acquisition !== 'failed' ||
          !latest.acquisition.canAcquire
        )
          return;
        clearTimeout(timeout);
        cooldownChecks = 0;
        void requestAcquisition(latest);
      },
    };
    void check();
    return () => {
      active = false;
      if (lease.current?.identity === identity) lease.current = undefined;
      clearTimeout(timeout);
      request?.abort();
    };
  }, [identity, id, map, userId, discoverable]);
  // An early GET may finish before the manifest and initial chunk are valid.
  // Enqueue only once normal replay initialization has actually succeeded.
  useEffect(() => {
    if (replayReady && lease.current?.identity === identity) lease.current.acquireIfReady();
  }, [identity, replayReady]);
  const state = !discoverable
    ? missingDemoMap
    : snapshot?.identity === identity
      ? snapshot.state
      : pendingDemoMap;
  const reportOverview = useCallback(
    (image: string, version: string, status: 'ready' | 'error') => {
      if (current.current !== identity) return;
      setSnapshot((previous) => {
        if (
          previous?.identity !== identity ||
          previous.state.assets.overview?.image !== image ||
          previous.state.assets.overview.assetVersion !== version ||
          previous.state.overviewStatus === status
        )
          return previous;
        return { identity, state: { ...previous.state, overviewStatus: status } };
      });
    },
    [identity],
  );
  const retryAcquisition = useCallback(() => {
    if (lease.current?.identity === current.current) lease.current.retry();
  }, []);
  const refreshAvailability = useCallback(() => {
    if (lease.current?.identity === current.current) lease.current.check();
  }, []);
  return useMemo(
    () => ({ ...state, reportOverview, retryAcquisition, refreshAvailability }),
    [state, reportOverview, retryAcquisition, refreshAvailability],
  );
}
