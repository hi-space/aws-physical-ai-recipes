'use client';
import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string, public details?: unknown) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  let body = init.body;
  if (init.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(init.json);
  }
  const res = await fetch(path, { ...init, headers, body, cache: 'no-store' });
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

/** Polling query helper. `refetch` in ms (0 = off). */
export function useApi<T>(path: string | null, opts: { refetch?: number; enabled?: boolean } & Omit<UseQueryOptions<T, ApiError>, 'queryKey' | 'queryFn'> = {}) {
  const { refetch = 0, enabled = true, ...rest } = opts;
  return useQuery<T, ApiError>({
    queryKey: ['api', path],
    queryFn: () => api<T>(path!),
    enabled: enabled && path !== null,
    refetchInterval: refetch || false,
    retry: (count, err) => err.status >= 500 && count < 1,
    ...rest,
  });
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
  email: string;
  role: 'admin' | 'researcher' | 'viewer';
  region: string;
  accountId: string;
  features: Record<'eks' | 'slurm' | 'amp' | 'mlflow' | 'pipeline' | 'dcv' | 'fsx' | 'edge' | 'cognito', boolean>;
  clusters: { eks?: string; slurm?: string; eksName?: string };
  buckets: { data?: string; artifacts?: string };
  defaultNamespace: string;
}
export const useMe = () => useApi<Me>('/api/me', { staleTime: 60_000 });
export const can = (me: Me | undefined, role: 'admin' | 'researcher' | 'viewer') => {
  const rank = { viewer: 0, researcher: 1, admin: 2 };
  return me ? rank[me.role] >= rank[role] : false;
};
