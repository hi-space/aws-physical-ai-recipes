import { createHash, randomUUID } from 'node:crypto';
import type { Project } from '../auth/projects';
import type { Session } from '../auth/session';
import * as sm from '../aws/sagemaker';
import { badRequest, HttpError, forbidden, notFound } from '../errors';
import { getRepo, Repo } from '../store/repo';
import { reconcilePipelineArchives } from './pipeline-archives';
import type { KV, Item } from '../store/dynamo';

interface PipelineIntent extends Item {
  state?: 'ACCEPTED';
  pipelineArn?: string; // Absent only on legacy records.
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
interface PipelineRejection extends Item {
  state: 'REJECTED';
  operationId: string;
  projectId: string;
  ownerSubject: string;
  inputHash: string;
  reason: string;
  expectedPipelineArn?: string;
}
type PipelineRequestRecord = PipelineIntent | PipelineRejection;
interface PipelineInput {
  parameters: Record<string, string>;
  displayName?: string;
  expectedPipelineArn?: string;
  expectedOwnerSubject?: string;
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
const sortedParameters = (parameters: Record<string, string>) =>
  Object.fromEntries(Object.entries(parameters).sort(([a], [b]) => a.localeCompare(b)));
const inputHash = (input: PipelineInput) => digest(JSON.stringify([sortedParameters(input.parameters), input.displayName ?? '']));
const targetName = (arn: string) => /^arn:aws[a-z-]*:sagemaker:[a-z0-9-]+:\d{12}:pipeline\/([A-Za-z0-9-]+)$/.exec(arn)?.[1];
const matchesConfiguredTarget = (arn: string, configured: string) => configured === arn || configured === targetName(arn);
const targetChanged = () => new HttpError(409, '저장된 실행 대상과 현재 파이프라인 구성이 다릅니다. 기존 대상을 복원한 뒤 동일 요청으로 확인하세요.', 'pipeline_target_changed');

async function replayPipelineRequest(record: PipelineRequestRecord, input: PipelineInput, requestId: string, d: PipelineDeps) {
  if (record.state === 'REJECTED') {
    if (record.inputHash !== inputHash(input) || record.expectedPipelineArn !== undefined && record.expectedPipelineArn !== input.expectedPipelineArn) {
      throw new HttpError(409, '같은 실행 요청 키에 다른 파라미터를 사용할 수 없습니다.');
    }
    throw new HttpError(400, record.reason, 'pipeline_not_submitted', {
      submissionState: 'not_submitted', requestId, projectId: record.projectId, ownerSubject: record.ownerSubject,
    });
  }
  for (const name of PIPELINE_IDENTITY_PARAMETERS) {
    if (Object.hasOwn(input.parameters, name)) throw badRequest('Project identity parameters are server controlled');
  }
  const recordedTarget = record.pipelineArn ?? record.arn?.split('/execution/')[0];
  if (input.expectedPipelineArn && recordedTarget && input.expectedPipelineArn !== recordedTarget) throw targetChanged();
  // Replay the intent validated on the first attempt. A refreshed definition must
  // not prevent receipt recovery or change server-controlled identity parameters.
  const selected = { ...input.parameters };
  for (const name of PIPELINE_IDENTITY_PARAMETERS) {
    if (Object.hasOwn(record.parameters, name)) selected[name] = record.parameters[name];
  }
  if (record.hash !== inputHash({ ...input, parameters: selected })) throw new HttpError(409, '같은 실행 요청 키에 다른 파라미터를 사용할 수 없습니다.');
  return dispatch(record, d);
}

export async function startProjectPipeline(session: Session, project: Project, input: PipelineInput, requestId = randomUUID() as string, d = deps()) {
  if (input.expectedOwnerSubject !== undefined && input.expectedOwnerSubject !== subject(session)) {
    // The original owner may already have an accepted intent. Do not reserve a
    // new owner's key or issue a rejection receipt that could unlock that draft.
    throw new HttpError(403, '로그인 계정이 실행 요청을 만든 계정과 다릅니다. 원래 계정으로 로그인한 뒤 동일 요청을 확인하세요.', 'pipeline_owner_changed');
  }
  if (!requestId.trim() || requestId.length > 256) throw badRequest('Invalid idempotency key');
  const operationId = digest(JSON.stringify([project.id, subject(session), requestId]));
  const key = { pk: `PROJECT#${project.id}`, sk: `PIPELINE#${operationId}` };
  const existing = await d.kv.get(key.pk, key.sk) as PipelineRequestRecord | undefined;
  if (existing) return replayPipelineRequest(existing, input, requestId, d);
  async function reserve(record: PipelineRequestRecord) {
    await d.kv.put(record, 'not_exists');
    // The atomic winner is authoritative, including a concurrent acceptance/rejection.
    const saved = await d.kv.get(key.pk, key.sk) as PipelineRequestRecord | undefined;
    if (!saved) throw new HttpError(503, '실행 요청 상태를 확인하지 못했습니다. 동일 요청으로 다시 확인하세요.');
    return replayPipelineRequest(saved, input, requestId, d);
  }
  function rejectBeforeSubmission(reason: string) {
    // A terminal rejection receipt reserves the key without creating an executable intent.
    return reserve({
      ...key, state: 'REJECTED', operationId, projectId: project.id, ownerSubject: subject(session),
      inputHash: inputHash(input), reason,
      ...(input.expectedPipelineArn !== undefined ? { expectedPipelineArn: input.expectedPipelineArn } : {}),
    });
  }
  const pipeline = await d.aws.describePipeline();
  if (input.expectedPipelineArn && input.expectedPipelineArn !== pipeline.PipelineArn) {
    return rejectBeforeSubmission('화면에서 선택한 파이프라인 대상이 변경되었습니다. 미제출 초안을 버리고 현재 대상을 확인하세요.');
  }
  const allowed = new Map(pipeline.parameters.map((parameter) => [parameter.Name, parameter]));
  for (const [name, value] of Object.entries(input.parameters)) {
    const parameter = allowed.get(name);
    const identityOverride = PIPELINE_IDENTITY_PARAMETERS.includes(name as typeof PIPELINE_IDENTITY_PARAMETERS[number]);
    if (identityOverride || !parameter || value.length > 1024 || (parameter.Type === 'Integer' && !/^[1-9]\d*$|^0$/.test(value))) {
      // This terminal receipt cannot be dispatched or reconciled. Keep it under
      // the operation key so no late/concurrent caller can turn it into an intent.
      return rejectBeforeSubmission(identityOverride ? 'Project identity parameters are server controlled' : `파라미터를 확인해 주세요: ${name}`);
    }
  }
  if (!pipeline.PipelineArn || !targetName(pipeline.PipelineArn)) throw new HttpError(503, '파이프라인 대상 ARN을 확인하지 못했습니다.');
  if (!matchesConfiguredTarget(pipeline.PipelineArn, d.aws.pipelineName())) {
    return rejectBeforeSubmission('파이프라인 구성이 변경되었습니다. 미제출 초안을 버리고 현재 대상을 확인하세요.');
  }
  const selected = { ...input.parameters };
  if (allowed.has('DashboardProjectId')) selected.DashboardProjectId = project.id;
  if (allowed.has('DashboardOwnerSubject')) selected.DashboardOwnerSubject = subject(session);
  const parameters = sortedParameters(selected);
  const hash = inputHash({ ...input, parameters });
  const created: PipelineIntent = {
    ...key, gsi1pk: 'TYPE#PIPELINE_INTENT', gsi1sk: `${Date.now()}#${operationId}`,
    operationId, projectId: project.id, ownerSubject: subject(session), owner: session.user, pipelineArn: pipeline.PipelineArn,
    parameters, hash, displayName: input.displayName || `pai-${project.id}-${operationId.slice(0, 16)}`,
    createdAt: new Date().toISOString(),
  };
  return reserve(created);
}

async function dispatch(intent: PipelineIntent, d: PipelineDeps) {
  let arn = intent.arn;
  if (!arn) {
    if (!intent.pipelineArn || !targetName(intent.pipelineArn)) {
      throw new HttpError(409, '이전 실행 요청에 대상 ARN이 기록되지 않았습니다. 기존 AWS 실행을 확인해야 합니다.', 'pipeline_target_unverified');
    }
    if (!matchesConfiguredTarget(intent.pipelineArn, d.aws.pipelineName())) throw targetChanged();
    const current = await d.aws.describePipeline();
    if (current.PipelineArn !== intent.pipelineArn || !matchesConfiguredTarget(intent.pipelineArn, d.aws.pipelineName())) throw targetChanged();
    // Pass the ARN all the way to the SDK; a config read inside the adapter cannot retarget the call.
    arn = await d.aws.startExecution(intent.parameters, intent.displayName, intent.operationId, intent.pipelineArn);
  }
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
