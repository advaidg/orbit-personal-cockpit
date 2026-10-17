import { useCallback, useEffect, useRef, useState } from 'react';
import { describeError } from './api';

export interface Loaded<T> {
  data: T | null;
  error: string;
  loading: boolean;
  reload: () => Promise<void>;
  setData: (value: T | null) => void;
}

/** Loads data once (and again on `reload`). Errors are kept as readable text, never thrown into render. */
export function useLoad<T>(fetcher: () => Promise<T>, deps: unknown[] = []): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const reload = useCallback(async () => {
    try {
      setData(await fetcherRef.current());
      setError('');
    } catch (failure) {
      setError(describeError(failure).message);
    } finally {
      setLoading(false);
    }
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void reload(); }, deps);
  return { data, error, loading, reload, setData };
}

/** Calls `tick` every `ms` while `active`. Stops on unmount or when the tab is hidden. */
export function usePoll(tick: () => void | Promise<void>, ms: number, active = true): void {
  const ref = useRef(tick);
  ref.current = tick;
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => { if (!document.hidden) void ref.current(); }, ms);
    return () => clearInterval(timer);
  }, [ms, active]);
}

export function useHash(): [string, (value: string) => void] {
  const read = () => location.hash.replace(/^#\/?/, '');
  const [hash, setHash] = useState(read);
  useEffect(() => {
    const handler = () => setHash(read());
    addEventListener('hashchange', handler);
    return () => removeEventListener('hashchange', handler);
  }, []);
  return [hash, (value) => { location.hash = `/${value}`; }];
}

export const toLocalInput = (iso?: unknown): string => {
  if (typeof iso !== 'string' || Number.isNaN(Date.parse(iso))) return '';
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
export const fromLocalInput = (value: string): string | undefined => (value ? new Date(value).toISOString() : undefined);
