'use client';
import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string, public details?: unknown) {
    super(message);
  }
}

export type ApiRequestInit = RequestInit & { json?: unknown };

export async function api<T = unknown>(path: string, init: ApiRequestInit = {}): Promise<T> {
  const { json, ...request } = init;
  const headers = new Headers(request.headers);
  let body = request.body;
  if (json !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(json);
  }
  const res = await fetch(path, { ...request, headers, body, cache: 'no-store' });
  const text = await res.text();
  let data: unknown = undefined;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const e = data as { error?: string; code?: string; details?: unknown } | undefined;
    throw new ApiError(res.status, e?.error ?? `${res.status} ${res.statusText}`, e?.code, e?.details);
  }
  return data as T;
}

type ApiQueryOptions<T> = {
  refetch?: number;
  enabled?: boolean;
  // Query bodies must be serializable for caching; binary uploads use api().
  init?: Omit<ApiRequestInit, 'body'> & { body?: string };
} & Omit<UseQueryOptions<T, ApiError>, 'queryKey' | 'queryFn'>;

/** Shared by useApi and multi-run useQueries. Keep ['api', path] invalidation compatible. */
export function apiQueryOptions<T = unknown>(path: string | null, opts: ApiQueryOptions<T> = {}) {
  const { refetch = 0, enabled = true, init = {}, ...rest } = opts;
  const { signal: callerSignal, headers, ...request } = init;
  const identity = {
    ...request,
    method: (request.method ?? 'GET').toUpperCase(),
    headers: Array.from(new Headers(headers).entries()),
    ...(request.json !== undefined ? { body: undefined } : {}),
  };
  const hasOptions = Object.keys(request).length > 0 || headers !== undefined;
  return {
    enabled: enabled && path !== null,
    refetchInterval: refetch || (false as const),
    retry: (count: number, err: ApiError) => err.status >= 500 && count < 1,
    ...rest,
    queryKey: hasOptions ? ['api', path, identity] : ['api', path],
    queryFn: ({ signal }: { signal: AbortSignal }) => api<T>(path!, {
      ...init,
      signal: callerSignal ? AbortSignal.any([signal, callerSignal]) : signal,
    }),
  } satisfies UseQueryOptions<T, ApiError>;
}

/** Polling query helper. `refetch` in ms (0 = off). */
export function useApi<T>(path: string | null, opts: ApiQueryOptions<T> = {}) {
  return useQuery<T, ApiError>(apiQueryOptions<T>(path, opts));
}

export function useApiMutation<TIn, TOut = unknown>(fn: (input: TIn) => Promise<TOut>, invalidate: string[] = []) {
  const qc = useQueryClient();
  return useMutation<TOut, ApiError, TIn>({
    mutationFn: fn,
    onSuccess: () => {
      for (const p of invalidate) void qc.invalidateQueries({ queryKey: ['api', p], exact: false });
      if (!invalidate.length) void qc.invalidateQueries({ queryKey: ['api'] });
    },
  });
}

export interface Me {
  user: string;
  subject?: string;
  email: string;
  role: 'admin' | 'researcher' | 'viewer';
  region: string;
  accountId: string;
  features: Record<'eks' | 'slurm' | 'amp' | 'mlflow' | 'pipeline' | 'dcv' | 'fsx' | 'edge' | 'cognito', boolean>;
  clusters: { eks?: string; slurm?: string; eksName?: string };
  buckets: { data?: string; artifacts?: string };
  defaultNamespace: string;
  project?: { id: string; name: string; role: 'viewer' | 'researcher' | 'project-admin' };
}
export const useMe = () => useApi<Me>('/api/me', { staleTime: 60_000 });
export const can = (me: Me | undefined, role: 'admin' | 'researcher' | 'viewer') => {
  const rank = { viewer: 0, researcher: 1, admin: 2 };
  return me ? rank[me.role] >= rank[role] : false;
};
