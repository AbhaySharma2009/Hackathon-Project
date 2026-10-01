"use client";

import { useCallback, useEffect, useState } from "react";

type Resource<T> = {
  data: T | null;
  loading: boolean;
  error: string | null;
  /** Refetch, showing the loading state again. */
  reload: () => Promise<void>;
};

/**
 * Loads one JSON resource on mount and exposes a reload.
 *
 * The initial fetch is written out inline in the effect rather than delegated to
 * `reload`, because `reload` sets loading synchronously and the
 * `react-hooks/set-state-in-effect` rule is right that doing so in an effect
 * causes a cascading render. `loading` already starts `true`, so the first load
 * does not need to set it.
 *
 * `fetcher` must be referentially stable — callers wrap it in `useCallback` —
 * since it is the effect's only dependency.
 *
 * The effect also guards against a late response landing after unmount, or after
 * a newer request has already started.
 */
export function useAdminResource<T>(fetcher: () => Promise<T>): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetcher()
      .then((value) => {
        if (cancelled) return;
        setData(value);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Unexpected error.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [fetcher]);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fetcher());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unexpected error.");
    } finally {
      setLoading(false);
    }
  }, [fetcher]);

  return { data, loading, error, reload };
}