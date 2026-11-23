import { useEffect, useReducer, useState } from 'react';
import { api } from './api';

export function useResource<T>(path: string | null, headers?: Readonly<Record<string, string>>) {
  const [revision, reload] = useReducer((value: number) => value + 1, 0);
  const [state, setState] = useState<{
    path: string;
    headers?: Readonly<Record<string, string>>;
    revision: number;
    data?: T;
    error?: string;
  }>();
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    void api<T>(path, { headers, signal: controller.signal }).then(
      (data) => {
        if (!controller.signal.aborted) setState({ path, headers, revision, data });
      },
      (failure: Error) => {
        if (!controller.signal.aborted)
          setState({ path, headers, revision, error: failure.message });
      },
    );
    return () => controller.abort();
  }, [path, headers, revision]);
  const current = state?.path === path && state.headers === headers ? state : undefined;
  const loading = Boolean(path) && (!current || current.revision !== revision);
  return { data: current?.data, error: loading ? undefined : current?.error, loading, reload };
}
