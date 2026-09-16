import { createHash, randomUUID } from 'node:crypto';
import type { Project } from '../auth/projects';
import type { Session } from '../auth/session';
import * as sm from '../aws/sagemaker';
import { badRequest, HttpError, forbidden, notFound } from '../errors';
import { getRepo, Repo } from '../store/repo';
import { reconcilePipelineArchives } from './pipeline-archives';
import type { KV, Item } from '../store/dynamo';

interface PipelineIntent extends Item {
  operationId: string;
  projectId: string;
  ownerSubject: string;
  owner: string;
  parameters: Record<string, string>;
  displayName: string;
  hash: string;
  createdAt: string;
  arn?: string;
}
export interface PipelineDeps {
  kv: KV;
  aws: Pick<typeof sm, 'startExecution' | 'stopExecution' | 'describeExecution' | 'describePipeline' | 'pipelineName'>;
}
const deps = (): PipelineDeps => ({ kv: getRepo().kv, aws: sm });
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const subject = (session: Session) => session.subject ?? session.user;
const execKey = (arn: string) => ({ pk: `PIPELINE_EXECUTION#${arn}`, sk: 'META' });
export const PIPELINE_IDENTITY_PARAMETERS = ['DashboardProjectId', 'DashboardOwnerSubject'] as const;

export async function startProjectPipeline(session: Session, project: Project, input: { parameters: Record<string, string>; displayName?: string }, requestId = randomUUID() as string, d = deps()) {
  if (!requestId.trim() || requestId.length > 256) throw badRequest('Invalid idempotency key');
  const pipeline = await d.aws.describePipeline();
  const allowed = new Map(pipeline.parameters.map((parameter) => [parameter.Name, parameter]));
  for (const [name, value] of Object.entries(input.parameters)) {
    if (PIPELINE_IDENTITY_PARAMETERS.includes(name as typeof PIPELINE_IDENTITY_PARAMETERS[number])) throw badRequest('Project identity parameters are server controlled');
    const parameter = allowed.get(name);
    if (!parameter || value.length > 1024 || (parameter.Type === 'Integer' && !/^[1-9]\d*$|^0$/.test(value))) throw badRequest(`파라미터를 확인해 주세요: ${name}`);
  }
  const selected = { ...input.parameters };
  if (allowed.has('DashboardProjectId')) selected.DashboardProjectId = project.id;
  if (allowed.has('DashboardOwnerSubject')) selected.DashboardOwnerSubject = subject(session);
  const parameters = Object.fromEntries(Object.entries(selected).sort(([a], [b]) => a.localeCompare(b)));
  const hash = digest(JSON.stringify([parameters, input.displayName ?? '']));
  const operationId = digest(JSON.stringify([project.id, subject(session), requestId]));
  const key = { pk: `PROJECT#${project.id}`, sk: `PIPELINE#${operationId}` };
  let intent = await d.kv.get(key.pk, key.sk) as PipelineIntent | undefined;
  if (!intent) {
    const created: PipelineIntent = {
      ...key, gsi1pk: 'TYPE#PIPELINE_INTENT', gsi1sk: `${Date.now()}#${operationId}`,
      operationId, projectId: project.id, ownerSubject: subject(session), owner: session.user,
      parameters, hash, displayName: input.displayName || `pai-${project.id}-${operationId.slice(0, 16)}`,
      createdAt: new Date().toISOString(),
    };
    await d.kv.put(created, 'not_exists');
    intent = await d.kv.get(key.pk, key.sk) as PipelineIntent;
  }
  if (intent.hash !== hash) throw new HttpError(409, '같은 실행 요청 키에 다른 파라미터를 사용할 수 없습니다.');
  return dispatch(intent, d);
}

async function dispatch(intent: PipelineIntent, d: PipelineDeps) {
  const arn = intent.arn ?? await d.aws.startExecution(intent.parameters, intent.displayName, intent.operationId);
  // The AWS client token adopts an already accepted request after a process crash.
  const updated = { ...intent, arn };
  const recorded = await d.kv.transaction([
    { kind: 'put', item: updated, condition: { equals: { hash: intent.hash } } },
    { kind: 'put', item: { ...execKey(arn), projectId: intent.projectId, ownerSubject: intent.ownerSubject, owner: intent.owner, operationId: intent.operationId, createdAt: intent.createdAt } },
  ]);
  if (!recorded) throw new HttpError(503, '실행 기록을 저장 중입니다. 동일한 요청 키로 다시 확인해 주세요.');
  return { arn, operationId: intent.operationId };
}

export async function reconcilePipelineIntents(d = deps(), signal?: AbortSignal) {
  if (signal?.aborted) return;
  for (const item of await d.kv.queryGsi1('TYPE#PIPELINE_INTENT')) {
    if (signal?.aborted) return;
    if (item.arn) continue;
    try { await dispatch(item as PipelineIntent, d); }
    catch (error) {
      if (signal?.aborted) return;
      console.error('[pipeline] request reconciliation failed', item.operationId, (error as Error).name);
    }
  }
  if (!signal?.aborted) await reconcilePipelineArchives(new Repo(d.kv), signal);
}

export async function assertPipelineAccess(session: Session, project: Project, arn: string, write = false, d = deps()) {
  if (!/^arn:aws:sagemaker:[a-z0-9-]+:\d{12}:pipeline\/[A-Za-z0-9-]+\/execution\/[A-Za-z0-9-]+$/.test(arn) || !arn.includes(`:pipeline/${d.aws.pipelineName()}/execution/`)) throw forbidden('등록된 파이프라인 실행이 아닙니다.');
  const record = await d.kv.get(execKey(arn).pk, 'META');
  if (!record) {
    if (session.role === 'admin') return;
    throw notFound('pipeline execution');
  }
  if (record.projectId !== project.id) throw forbidden('다른 프로젝트의 실행입니다.');
  if (write && record.ownerSubject !== subject(session) && session.role !== 'admin' && project.members[subject(session)] !== 'project-admin') throw forbidden('실행 소유자 또는 프로젝트 관리자가 중단할 수 있습니다.');
}

export async function projectExecution(session: Session, project: Project, arn: string, d = deps()) {
  await assertPipelineAccess(session, project, arn, false, d);
  const execution = await d.aws.describeExecution(arn);
  const record = await d.kv.get(execKey(arn).pk, 'META');
  if (record) for (const step of execution.steps) {
    const jobArn = step.Metadata?.TrainingJob?.Arn;
    if (jobArn) await d.kv.put({ pk: `PIPELINE_JOB#${jobArn.split('/').pop()}`, sk: 'META', projectId: record.projectId, executionArn: arn });
  }
  return { ...execution,
    projectRecorded: Boolean(record),
    canArchive: Boolean(record) && execution.execution.PipelineExecutionStatus === 'Succeeded' &&
      (session.role === 'admin' || session.role === 'researcher' && ['researcher', 'project-admin'].includes(project.members[subject(session)])),
    canStop: Boolean(record) && (record?.ownerSubject === subject(session) || session.role === 'admin' || project.members[subject(session)] === 'project-admin') };
}

export async function projectPipelineList(session: Session, project: Project, d = deps()) {
  const records = (await d.kv.query(`PROJECT#${project.id}`, 'PIPELINE#')).filter((record) => record.arn).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 50);
  const values = await Promise.all(records.map((record) => projectExecution(session, project, String(record.arn), d)));
  return values.map(({ execution }) => ({
    PipelineExecutionArn: execution.PipelineExecutionArn,
    PipelineExecutionDisplayName: execution.PipelineExecutionDisplayName,
    PipelineExecutionStatus: execution.PipelineExecutionStatus,
    StartTime: execution.CreationTime,
    PipelineExecutionFailureReason: execution.FailureReason,
  }));
}

export async function stopProjectPipeline(session: Session, project: Project, arn: string, d = deps()) {
  await assertPipelineAccess(session, project, arn, true, d);
  const token = digest(`stop:${project.id}:${arn}`);
  await d.aws.stopExecution(arn, token);
  return { accepted: true, arn, message: '중단 요청을 접수했습니다. 실제 종료 상태는 실행 상세에서 확인하세요.' };
}

export async function assertTrainingJobAccess(session: Session, project: Project, name: string, d = deps()) {
  const record = await d.kv.get(`PIPELINE_JOB#${name}`, 'META');
  if (!record) { if (session.role === 'admin') return; throw notFound('training job'); }
  if (record.projectId !== project.id) throw forbidden('다른 프로젝트의 학습입니다.');
}
