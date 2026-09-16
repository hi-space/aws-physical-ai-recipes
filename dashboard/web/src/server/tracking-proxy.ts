import type { IncomingMessage, ServerResponse } from 'node:http';
import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { HttpError } from './errors';
import { validateMetricsCapability } from './runtime';
import { mlflowApi, type MlRun } from './aws/mlflow';
import { s3 } from './aws/clients';
import { config } from './config';
import { getRepo } from './store/repo';
import type { AuthContext } from './runtime/ledger';

const MAX_BODY = 32 * 1024 * 1024;
async function bytes(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const part = Buffer.from(chunk); size += part.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Tracking request is too large');
    chunks.push(part);
  }
  return Buffer.concat(chunks);
}
const experimentName = (context: AuthContext) => `pai/${context.claims.projectId}/${context.workflow.name}`;
async function experiment(context: AuthContext) {
  const repo = getRepo();
  const pk = `TRACKING#${context.claims.projectId}`;
  const sk = `EXPERIMENT#${context.workflow.name}`;
  const existing = await repo.kv.get(pk, sk);
  if (existing?.id) return String(existing.id);
  const name = experimentName(context);
  let id: string;
  try {
    id = (await mlflowApi<{ experiment: { experiment_id: string } }>('GET', 'experiments/get-by-name', undefined, { experiment_name: name })).experiment.experiment_id;
  } catch (error) {
    if (!String((error as Error).message).includes('404')) throw error;
    try {
      id = (await mlflowApi<{ experiment_id: string }>('POST', 'experiments/create', { name, tags: [{ key: 'pai.project_id', value: context.claims.projectId }] })).experiment_id;
    } catch (creationError) {
      if (!/RESOURCE_ALREADY_EXISTS|already exists/.test(String((creationError as Error).message))) throw creationError;
      id = (await mlflowApi<{ experiment: { experiment_id: string } }>('GET', 'experiments/get-by-name', undefined, { experiment_name: name })).experiment.experiment_id;
    }
  }
  await repo.kv.put({ pk, sk, id }, 'not_exists');
  return id;
}
function runKey(context: AuthContext) {
  return { pk: `WF#${context.workflow.id}`, sk: `MLFLOW#${context.claims.task}#${context.claims.attempt}` };
}
async function run(context: AuthContext): Promise<MlRun> {
  const repo = getRepo(), key = runKey(context);
  const existing = await repo.kv.get(key.pk, key.sk);
  if (existing?.runId) return (await mlflowApi<{ run: MlRun }>('GET', 'runs/get', undefined, { run_id: String(existing.runId) })).run;
  const experimentId = await experiment(context);
  const tags = [
    { key: 'pai.project_id', value: context.claims.projectId }, { key: 'pai.workflow_id', value: context.workflow.id },
    { key: 'pai.task', value: context.claims.task }, { key: 'pai.attempt', value: String(context.claims.attempt) },
    { key: 'pai.owner_subject', value: context.workflow.ownerSubject ?? '' },
    { key: 'mlflow.runName', value: `${context.workflow.name}/${context.claims.task}/${context.claims.attempt}` },
  ];
  const filter = `tags.\`pai.workflow_id\` = '${context.workflow.id}' AND tags.\`pai.task\` = '${context.claims.task}' AND tags.\`pai.attempt\` = '${context.claims.attempt}'`;
  const found = await mlflowApi<{ runs?: MlRun[] }>('POST', 'runs/search', { experiment_ids: [experimentId], filter, max_results: 10, order_by: ['attributes.start_time ASC'] });
  const created = found.runs?.[0] ?? (await mlflowApi<{ run: MlRun }>('POST', 'runs/create', { experiment_id: experimentId, start_time: Date.now(), tags })).run;
  if (!await repo.kv.put({ ...key, runId: created.info.run_id }, 'not_exists')) {
    const winner = await repo.kv.get(key.pk, key.sk);
    if (winner?.runId !== created.info.run_id) {
      await mlflowApi('POST', 'runs/update', { run_id: created.info.run_id, status: 'KILLED', end_time: Date.now() });
      return (await mlflowApi<{ run: MlRun }>('GET', 'runs/get', undefined, { run_id: String(winner!.runId) })).run;
    }
  }
  return created;
}
const clientRun = (value: MlRun) => ({ ...value, info: { ...value.info, artifact_uri: `mlflow-artifacts:/${value.info.run_id}` } });

/** Private, task-scoped MLflow API. Its token cannot control runtime state. */
export async function handleTrackingRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (!req.url?.startsWith('/tracking/')) return false;
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  try {
    const authorization = req.headers.authorization;
    if (!authorization?.startsWith('Bearer ')) throw new HttpError(401, 'Task tracking token required');
    const context = await validateMetricsCapability(authorization.slice(7));
    if (!context.workflow.spec.workflow.mlflow) throw new HttpError(403, 'Tracking is not enabled for this workflow');
    const url = new URL(req.url, 'http://tracking');
    const artifact = /^\/tracking\/api\/2\.0\/mlflow-artifacts\/artifacts\/([^/]+)\/(.+)$/.exec(url.pathname);
    if (artifact) {
      const owned = await run(context);
      if (artifact[1] !== owned.info.run_id) throw new HttpError(403, 'Tracking run mismatch');
      const relative = decodeURIComponent(artifact[2]);
      if (relative.startsWith('/') || relative.includes('\\') || relative.split('/').some((part) => !part || part === '.' || part === '..')) throw new HttpError(400, 'Invalid artifact path');
      const target = /^s3:\/\/([^/]+)\/(.*)$/.exec(owned.info.artifact_uri ?? '');
      if (!target || target[1] !== config().groot?.artifactsBucket) throw new HttpError(503, 'Tracking artifact store is not registered');
      const Key = target[2].replace(/\/?$/, '/') + relative;
      if (req.method === 'PUT') {
        const content = await bytes(req);
        await validateMetricsCapability(authorization.slice(7));
        await s3().send(new PutObjectCommand({ Bucket: target[1], Key, Body: content, ChecksumAlgorithm: 'SHA256' }));
        send(200, {});
      } else if (req.method === 'GET') {
        const response = await s3().send(new GetObjectCommand({ Bucket: target[1], Key }));
        res.writeHead(200, { 'content-type': response.ContentType ?? 'application/octet-stream' });
        for await (const part of response.Body as AsyncIterable<Uint8Array>) res.write(part);
        res.end();
      } else throw new HttpError(405, 'Unsupported artifact method');
      return true;
    }
    const path = url.pathname.replace(/^\/tracking\/api\/2\.0\/mlflow\//, '');
    if (path === url.pathname) throw new HttpError(404, 'Unknown tracking endpoint');
    const payload = req.method === 'POST' ? JSON.parse((await bytes(req)).toString() || '{}') as Record<string, unknown> : {};
    if (['experiments/get-by-name', 'experiments/get', 'experiments/create'].includes(path)) {
      const id = await experiment(context);
      send(200, path === 'experiments/create' ? { experiment_id: id } : { experiment: { experiment_id: id, name: experimentName(context), lifecycle_stage: 'active' } });
      return true;
    }
    const owned = await run(context);
    if (path === 'runs/create') { send(200, { run: clientRun(owned) }); return true; }
    const requested = payload.run_id ?? payload.run_uuid ?? url.searchParams.get('run_id');
    if (requested !== owned.info.run_id) throw new HttpError(403, 'Tracking run mismatch');
    if (path === 'runs/get' && req.method === 'GET') { send(200, { run: clientRun(owned) }); return true; }
    if (req.method !== 'POST' || !['runs/log-metric', 'runs/log-batch', 'runs/log-parameter', 'runs/set-tag', 'runs/delete-tag', 'runs/update'].includes(path)) throw new HttpError(403, 'Tracking operation is not allowed');
    if (['runs/set-tag', 'runs/delete-tag'].includes(path) && String(payload.key).startsWith('pai.')) throw new HttpError(403, 'Provenance tags are immutable');
    if (path === 'runs/log-batch' && Array.isArray(payload.tags) && payload.tags.some((tag: { key?: string }) => tag.key?.startsWith('pai.'))) throw new HttpError(403, 'Provenance tags are immutable');
    await validateMetricsCapability(authorization.slice(7));
    send(200, await mlflowApi('POST', path, { ...payload, run_id: owned.info.run_id }));
  } catch (error) {
    const known = error instanceof HttpError;
    send(known ? error.status : 503, { error_code: known ? 'INVALID_STATE' : 'TEMPORARILY_UNAVAILABLE', message: known ? error.message : 'Tracking service unavailable' });
  }
  return true;
}
