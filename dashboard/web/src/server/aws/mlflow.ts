/**
 * SageMaker managed MLflow REST client.
 *
 * The tracking server front door requires SigV4 (service `sagemaker-mlflow`)
 * AND the routing header `x-mlflow-sm-tracking-server-arn` that the official
 * `sagemaker-mlflow` plugin adds; without the header every call is a 500.
 */
import { CreatePresignedMlflowTrackingServerUrlCommand, DescribeMlflowTrackingServerCommand } from '@aws-sdk/client-sagemaker';
import { config } from '../config';
import { notConfigured } from '../errors';
import { sagemaker } from './clients';
import { sigv4Fetch } from './sigv4';

let urlCache: { url: string; at: number } | undefined;

export function trackingServerArn(): string {
  const arn = config().groot?.mlflowTrackingServerArn;
  if (!arn) throw notConfigured('MLflow tracking server');
  return arn;
}
export function trackingServerName(): string {
  const arn = trackingServerArn();
  return config().groot?.mlflowTrackingServerName ?? arn.split('/').pop()!;
}

async function trackingUrl(): Promise<string> {
  if (urlCache && Date.now() - urlCache.at < 10 * 60_000) return urlCache.url;
  const out = await sagemaker().send(new DescribeMlflowTrackingServerCommand({ TrackingServerName: trackingServerName() }));
  if (!out.TrackingServerUrl) throw new Error('Tracking server has no URL (is it Active?)');
  urlCache = { url: out.TrackingServerUrl.replace(/\/$/, ''), at: Date.now() };
  return urlCache.url;
}

export function mlflowHeaders(arn: string): Record<string, string> {
  return { 'x-mlflow-sm-tracking-server-arn': arn, 'content-type': 'application/json' };
}

async function api<T>(method: 'GET' | 'POST', path: string, body?: unknown, query?: Record<string, string>): Promise<T> {
  const base = await trackingUrl();
  const url = new URL(`${base}/api/2.0/mlflow/${path}`);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
  const res = await sigv4Fetch({
    service: 'sagemaker-mlflow',
    region: config().region,
    url: url.toString(),
    method,
    headers: mlflowHeaders(trackingServerArn()),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`MLflow ${path}: ${res.status} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}
export { api as mlflowApi };

export interface MlExperiment { experiment_id: string; name: string; lifecycle_stage: string; last_update_time?: number; creation_time?: number; artifact_location?: string }
export interface MlRunInfo { run_id: string; run_name?: string; experiment_id: string; status: string; start_time: number; end_time?: number; artifact_uri?: string; user_id?: string }
export interface MlRun { info: MlRunInfo; data: { metrics?: { key: string; value: number; timestamp: number; step: number }[]; params?: { key: string; value: string }[]; tags?: { key: string; value: string }[] } }

export async function searchExperiments(filter = ''): Promise<MlExperiment[]> {
  const r = await api<{ experiments?: MlExperiment[] }>('POST', 'experiments/search', {
    max_results: 200, order_by: ['last_update_time DESC'], ...(filter ? { filter } : {}),
  });
  return r.experiments ?? [];
}
export async function getExperiment(experimentId: string): Promise<MlExperiment> {
  return (await api<{ experiment: MlExperiment }>('GET', 'experiments/get', undefined, { experiment_id: experimentId })).experiment;
}
export async function searchRuns(experimentIds: string[], filter = '', maxResults = 100): Promise<MlRun[]> {
  const r = await api<{ runs?: MlRun[] }>('POST', 'runs/search', {
    experiment_ids: experimentIds,
    filter,
    max_results: maxResults,
    order_by: ['attributes.start_time DESC'],
  });
  return r.runs ?? [];
}
export async function getRun(runId: string): Promise<MlRun> {
  return (await api<{ run: MlRun }>('GET', 'runs/get', undefined, { run_id: runId })).run;
}
export async function getMetricHistory(runId: string, key: string): Promise<{ key: string; value: number; timestamp: number; step: number }[]> {
  const r = await api<{ metrics?: { key: string; value: number; timestamp: number; step: number }[] }>('GET', 'metrics/get-history', undefined, {
    run_id: runId,
    metric_key: key,
    max_results: '5000',
  });
  return r.metrics ?? [];
}
export async function listArtifacts(runId: string, path?: string): Promise<{ path: string; is_dir: boolean; file_size?: number }[]> {
  const q: Record<string, string> = { run_id: runId };
  if (path) q.path = path;
  const r = await api<{ files?: { path: string; is_dir: boolean; file_size?: number }[] }>('GET', 'artifacts/list', undefined, q);
  return r.files ?? [];
}
export async function searchRegisteredModels(): Promise<{ name: string; latest_versions?: { version: string; current_stage?: string; run_id?: string; status?: string; creation_timestamp?: number }[] }[]> {
  const r = await api<{ registered_models?: never[] }>('GET', 'registered-models/search', undefined, { max_results: '100' });
  return (r.registered_models ?? []) as never;
}
export async function presignedUiUrl(): Promise<string> {
  const out = await sagemaker().send(
    new CreatePresignedMlflowTrackingServerUrlCommand({ TrackingServerName: trackingServerName(), ExpiresInSeconds: 300, SessionExpirationDurationInSeconds: 43200 }),
  );
  return out.AuthorizedUrl!;
}
