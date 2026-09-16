import { DescribeClusterCommand } from '@aws-sdk/client-eks';
import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';
import { config } from '../config';
import { eks } from '../aws/clients';
import { HttpError, badRequest, notConfigured } from '../errors';
import { mintEksToken } from './token';

export const SYSTEM_NAMESPACES = new Set([
  'kube-system',
  'kube-public',
  'kube-node-lease',
  'kueue-system',
  'kubeflow',
  'mpi-operator',
  'hyperpod-observability',
  'aws-hyperpod',
  'grafana',
]);

export function assertWritableNamespace(ns: string): void {
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(ns) || ns.length > 63) throw badRequest(`Invalid namespace ${ns}`);
  if (SYSTEM_NAMESPACES.has(ns)) throw badRequest(`Namespace ${ns} is a system namespace`);
}

interface ClusterInfo { endpoint: string; ca: string; name: string; region: string }
let info: Promise<ClusterInfo> | undefined;
let dispatcher: Dispatcher | undefined;

async function clusterInfo(): Promise<ClusterInfo> {
  if (info) return info;
  const c = config();
  if (!c.eks) throw notConfigured('HyperPod EKS');
  info = eks()
    .send(new DescribeClusterCommand({ name: c.eks.eksClusterName }))
    .then((out) => {
      const endpoint = out.cluster?.endpoint;
      const ca = out.cluster?.certificateAuthority?.data;
      if (!endpoint || !ca) throw new Error('EKS cluster has no endpoint/CA');
      dispatcher = new Agent({ connect: { ca: Buffer.from(ca, 'base64').toString('utf8') } });
      return { endpoint, ca, name: c.eks!.eksClusterName, region: c.region };
    });
  info.catch(() => (info = undefined));
  return info;
}

export interface K8sRequestInit { method?: string; body?: unknown; headers?: Record<string, string>; raw?: boolean }

export class K8sError extends HttpError {
  constructor(status: number, message: string, public readonly reason?: string) {
    super(status, message, 'k8s_error');
  }
}

/** Low-level request. `path` starts with `/api` or `/apis`. */
export async function k8sRequest(path: string, init: K8sRequestInit = {}): Promise<Response> {
  const ci = await clusterInfo();
  const { token } = await mintEksToken(ci.name, ci.region);
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: 'application/json', ...(init.headers ?? {}) };
  let body: string | undefined;
  if (init.body !== undefined) {
    body = typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
    headers['content-type'] ??= init.method === 'PATCH' ? 'application/merge-patch+json' : 'application/json';
  }
  const res = await undiciFetch(ci.endpoint + path, { method: init.method ?? 'GET', headers, body, dispatcher });
  if (!res.ok && !init.raw) {
    const text = await res.text();
    let reason: string | undefined;
    let message = text;
    try {
      const j = JSON.parse(text) as { reason?: string; message?: string };
      reason = j.reason;
      message = j.message ?? text;
    } catch {
      /* not json */
    }
    throw new K8sError(res.status, `Kubernetes ${init.method ?? 'GET'} ${path}: ${message}`, reason);
  }
  return res as unknown as Response;
}

export async function k8sJson<T>(path: string, init: K8sRequestInit = {}): Promise<T> {
  const res = await k8sRequest(path, init);
  return (await res.json()) as T;
}

export async function k8sGetOrNull<T>(path: string): Promise<T | null> {
  try {
    return await k8sJson<T>(path);
  } catch (e) {
    if (e instanceof K8sError && e.status === 404) return null;
    throw e;
  }
}

/**
 * Join URL path segments for a proxy target, rejecting traversal and encoded
 * separators. Returns null when any segment is unsafe.
 */
export function sanitizeProxyPath(segments: string[]): string | null {
  const out: string[] = [];
  for (const raw of segments) {
    if (raw === '' || raw === '.' || raw === '..') return null;
    if (/%2f|%5c|%2e%2e/i.test(raw) || raw.includes('\\')) return null;
    if (!/^[A-Za-z0-9._~!$&'()*+,;=:@%-]+$/.test(raw)) return null;
    out.push(raw);
  }
  return out.join('/');
}

/** Proxy an HTTP request to an in-cluster Service through the API server. */
export async function serviceProxy(namespace: string, service: string, port: number | string, subPath: string, init: { method?: string; headers?: Record<string, string>; body?: ArrayBuffer | string } = {}): Promise<Response> {
  if (!/^[a-z0-9-]+$/.test(namespace) || !/^[a-z0-9-]+$/.test(service)) throw badRequest('invalid proxy target');
  const prefix = `/api/v1/namespaces/${namespace}/services/${service}:${port}/proxy`;
  const path = `${prefix}${subPath.startsWith('/') ? subPath : '/' + subPath}`;
  if (!path.startsWith(prefix + '/') && path !== prefix + '/') throw badRequest('invalid proxy path');
  if (/\/\.\.(\/|$)/.test(path.split('?')[0])) throw badRequest('invalid proxy path');
  const ci = await clusterInfo();
  const { token } = await mintEksToken(ci.name, ci.region);
  const headers: Record<string, string> = { ...(init.headers ?? {}), authorization: `Bearer ${token}` };
  delete headers.host;
  delete headers.connection;
  const res = await undiciFetch(ci.endpoint + path, { method: init.method ?? 'GET', headers, body: init.body as never, dispatcher, redirect: 'manual' });
  return res as unknown as Response;
}
