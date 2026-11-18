import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  pendingDemoMap,
  failedDemoMap,
  readMapJSON,
  validateDemoMapAssets,
  retryableMapFailures,
  type DemoMapState,
} from './demo-map-assets';

const delays = [1000, 2000, 5000, 10000];
/** One viewer lease observes a durable job. Cleanup cancels HTTP, never the shared job. */
export function useDemoMapAssets(
  id: string | undefined,
  map: string | undefined,
  userId: string | undefined,
) {
  const identity = useMemo(() => ({ id, map, userId }), [id, map, userId]);
  const [snapshot, setSnapshot] = useState<{ identity: object; state: DemoMapState }>();
  const lease = useRef<{ identity: object; retry: () => void } | undefined>(undefined);
  const current = useRef(identity);
  current.current = identity;
  useEffect(() => {
    if (!id || !map || !/^[a-zA-Z0-9_-]{1,80}$/.test(map)) return;
    let active = true,
      timeout: ReturnType<typeof setTimeout> | undefined,
      request: AbortController | undefined;
    let attempted = false,
      poll = 0,
      cooldownChecks = 0,
      uncertain = false,
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
        const response = await fetch(path, {
          ...init,
          credentials: 'same-origin',
          redirect: 'error',
          signal: controller.signal,
          headers: { Accept: 'application/json', ...init.headers },
        });
        if (!response.ok && response.status !== 503) throw new Error('Map discovery failed');
        return await readMapJSON(response);
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
    function schedule(state: DemoMapState) {
      if (!live()) return;
      if (Date.now() - started >= 45 * 60 * 1000) {
        publish({ ...state, pollingEnded: true });
        return;
      }
      timeout = setTimeout(() => void check(), delays[Math.min(poll++, delays.length - 1)]);
    }
    function observe(state: DemoMapState) {
      if (state.acquisition && ['queued', 'processing'].includes(state.acquisition.acquisition))
        schedule(state);
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
    async function requestAcquisition(state: DemoMapState) {
      attempted = true;
      retryBusy = true;
      publish({ ...state, requesting: true, requestUnconfirmed: false });
      try {
        const result = await acquire();
        if (!live()) return;
        const next = validateDemoMapAssets(result, map!);
        uncertain = false;
        retryBusy = false;
        publish(next);
        observe(next);
      } catch {
        // A lost POST may already be accepted. Observe, never replay it.
        uncertain = true;
        if (live()) schedule(state);
      }
    }
    async function check() {
      try {
        let state = validateDemoMapAssets(
          await fetchJSON(`/api/demos/${encodeURIComponent(id!)}/map-assets`),
          map!,
        );
        if (!live()) return;
        retryBusy = false;
        if (uncertain && state.acquisition?.canAcquire)
          state = { ...state, requestUnconfirmed: true };
        publish(state);
        if (
          state.acquisition?.canAcquire &&
          state.acquisition.acquisition === 'unavailable' &&
          !attempted
        ) {
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
  }, [identity, id, map, userId]);
  const state = snapshot?.identity === identity ? snapshot.state : pendingDemoMap;
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
  return { ...state, reportOverview, retryAcquisition };
}
