import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { Channel, InputOf, OutputOf } from '../../shared/api';

export interface ApiError {
  code: string;
  message: string;
}

export function toApiError(err: unknown): ApiError {
  const e = err as { code?: string; message?: string };
  const message = (e?.message ?? 'Error inesperado').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  return { code: e?.code ?? 'INTERNAL', message };
}

/** Typed call to the main process through the preload bridge. */
export function api<C extends Channel>(channel: C, input?: InputOf<C>): Promise<OutputOf<C>> {
  return (window.hormiga.invoke as (c: C, i?: InputOf<C>) => Promise<OutputOf<C>>)(channel, input);
}

/** Global data version: every mutation bumps it so visible queries refetch. */
export const DataVersionContext = createContext<{ version: number; invalidate: () => void }>({ version: 0, invalidate: () => {} });

export function useInvalidate(): () => void {
  return useContext(DataVersionContext).invalidate;
}

export interface QueryState<T> {
  data: T | undefined;
  error: ApiError | null;
  loading: boolean;
  reload: () => void;
}

export function useQuery<T>(fn: () => Promise<T>, deps: unknown[]): QueryState<T> {
  const { version } = useContext(DataVersionContext);
  const [state, setState] = useState<{ data: T | undefined; error: ApiError | null; loading: boolean }>({ data: undefined, error: null, loading: true });
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    fnRef.current().then(
      (data) => alive && setState({ data, error: null, loading: false }),
      (err) => alive && setState((s) => ({ data: s.data, error: toApiError(err), loading: false })),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, version, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}
