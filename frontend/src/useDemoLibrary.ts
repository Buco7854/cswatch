import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { Demo } from './types';

type DemoPage = { demos: Demo[]; total: number };
const pageSize = 50;
const unique = (demos: Demo[]) => [...new Map(demos.map((demo) => [demo.id, demo])).values()];

export function useDemoLibrary(userId: string | undefined, search: string, source = '') {
  const [query, setQuery] = useState(search.trim());
  const [demos, setDemos] = useState<Demo[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const rows = useRef<Demo[]>([]);
  const pages = useRef(1);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const load = useCallback(
    async (append = false, background = false) => {
      if (background && request.current) return;
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      setLoading(true);
      setError('');
      const getPage = (offset: number) =>
        api<DemoPage>(
          '/api/demos?' +
            new URLSearchParams({
              scope: 'mine',
              q: query,
              offset: String(offset),
              ...(source ? { source } : {}),
            }),
          { signal: controller.signal },
        );
      try {
        const first = await getPage(append ? rows.current.length : 0);
        let next = append ? unique([...rows.current, ...first.demos]) : first.demos;
        if (!append) {
          // A refresh/poll retains the loaded range instead of silently collapsing
          // a paged library back to the first 50 rows. Fetches remain sequential.
          const count = Math.min(pages.current, Math.max(1, Math.ceil(first.total / pageSize)));
          for (let page = 1; page < count; page++) {
            const more = await getPage(page * pageSize);
            next = unique([...next, ...more.demos]);
          }
        }
        if (controller.signal.aborted) return;
        rows.current = next;
        pages.current = Math.max(1, Math.ceil(next.length / pageSize));
        setDemos(next);
        setTotal(first.total);
      } catch (error) {
        if (!controller.signal.aborted) setError((error as Error).message);
      } finally {
        if (request.current === controller) {
          request.current = null;
          setLoading(false);
        }
      }
    },
    [userId, query, source],
  );

  useEffect(() => {
    pages.current = 1;
    rows.current = [];
    setDemos([]);
    setTotal(0);
    void load();
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [load]);
  useEffect(() => {
    if (!demos.some((demo) => ['queued', 'uploading', 'processing'].includes(demo.status))) return;
    const timer = setInterval(() => void load(false, true), 5000);
    return () => clearInterval(timer);
  }, [demos, load]);

  return {
    demos,
    total,
    loading: loading || query !== search.trim(),
    error,
    more: demos.length < total,
    load,
  };
}
