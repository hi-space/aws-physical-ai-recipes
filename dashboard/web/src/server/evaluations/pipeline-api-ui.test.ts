import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const transport = vi.hoisted(() => ({ s3: vi.fn(), sm: vi.fn(), responses: new Map<string, unknown>(), api: vi.fn() }));
vi.mock('../aws/clients', () => ({ s3: () => ({ send: transport.s3 }), sagemaker: () => ({ send: transport.sm }) }));
vi.mock('@/lib/api-client', () => ({
  api: transport.api, useMe: () => ({ data: { role: 'researcher', subject: 'alice-sub', project: { role: 'project-admin' } } }),
  useApi: (path: string | null) => ({ data: path ? transport.responses.get(path) : undefined, isLoading: false, error: undefined, refetch: async () => undefined }),
}));
import { pipelineFixture, pipelineAdmin, executionArn } from './pipeline-fixtures';
import { GET as listArchives, POST as requestArchive } from '../../app/api/pipelines/executions/[arn]/archives/route';
import { POST as startPipeline } from '../../app/api/pipelines/executions/route';
import { GET as readArchive } from '../../app/api/pipelines/archives/[id]/route';
import { POST as approveRegistry } from '../../app/api/models/[id]/registry-approval/route';
import * as archiveServices from '../services/pipeline-archives';
import * as modelServices from '../services/models';
import { setRepoForTests } from '../store/repo';
import { resetConfigForTests } from '../config';
import { ModelsPage } from '../../components/pages/ModelsPage';
import { PipelineArchivePanel } from '../../components/pages/PipelineExecutionPage';
import { assertEvaluationModel, readEvaluationQuery, initializeWorkflowYaml } from '../../components/pages/NewWorkflowPage';
import { BUILTIN_TEMPLATES } from '../workflow/builtin-templates';
import { parseWorkflowYaml } from '../workflow/template';

let f: Awaited<ReturnType<typeof pipelineFixture>>;
const archivePath = `/api/pipelines/executions/${encodeURIComponent(executionArn)}/archives`;
// Membership mirrors the pipelineFixture project setup: alice-sub is project a's admin, peer-sub and
// bob-sub are plain researcher members of a/b respectively, and reader-sub is a viewer member of a.
const groupsFor = (subject: string) => ({
  'alice-sub': 'researchers,proj-a-admin', 'peer-sub': 'researchers,proj-a',
  'reader-sub': 'viewers,proj-a', 'bob-sub': 'researchers,proj-b',
} as Record<string, string>)[subject] ?? '';
function req(path: string, method = 'GET', body?: unknown, subject = 'alice-sub', project = 'a', origin = 'http://localhost') {
  return new NextRequest(`http://localhost${path}`, { method, headers: {
    origin, 'content-type': 'application/json', 'x-pai-user': subject, 'x-pai-subject': subject,
    'x-pai-role': 'researcher', 'x-pai-project': project, 'x-pai-groups': groupsFor(subject),
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
beforeEach(async () => {
  vi.restoreAllMocks(); transport.responses.clear(); transport.api.mockReset();
  vi.stubEnv('DASHBOARD_ORIGIN', 'http://localhost'); resetConfigForTests();
  f = await pipelineFixture(); setRepoForTests(f.repo);
  transport.s3.mockImplementation(command => f.storage.send(command));
  transport.sm.mockImplementation(command => f.aws.send(command));
  vi.spyOn(archiveServices, 'pipelineArchives').mockReturnValue(f.archives);
  vi.spyOn(modelServices, 'modelsService').mockReturnValue(f.models);
});
async function prepare() {
  const archive = await f.archives.request(pipelineAdmin, 'a', executionArn, { trainingStep: 'GR00TFinetune', reportSteps: ['SmokeEval'] });
  await f.archives.reconcile(archive);
  const ready = await f.archives.get(pipelineAdmin, 'a', archive.id);
  const model = await f.models.register(pipelineAdmin, 'a', { name: 'Fixture GR00T candidate', dataset: ready.datasetName, version: ready.version, checkpointPath: 'model/model.tar.gz' });
  return { archive: ready, model };
}
describe('pipeline archive HTTP boundaries and researcher UI', () => {
  it('rejects a changed expected owner over HTTP before reserving either acceptance or rejection', async () => {
    vi.stubEnv('ARTIFACTS_BUCKET', 'archive'); vi.stubEnv('SM_PIPELINE_NAME', 'groot'); resetConfigForTests();
    transport.sm.mockClear().mockImplementation(command => {
      if (command.constructor.name === 'DescribePipelineCommand') return {
        PipelineArn: 'arn:aws:sagemaker:us-east-1:123456789012:pipeline/groot',
        PipelineDefinition: JSON.stringify({ Parameters: [{ Name: 'MaxSteps', Type: 'Integer', DefaultValue: 100 }] }),
      };
      throw new Error(`Unexpected AWS command ${command.constructor.name}`);
    });
    const request = req('/api/pipelines/executions', 'POST', {
      parameters: { MaxSteps: '-1' }, expectedOwnerSubject: 'alice-sub',
    }, 'peer-sub');
    request.headers.set('idempotency-key', 'owner-http');
    const response = await startPipeline(request);
    expect(response.status).toBe(403);
    const result = await response.json();
    expect(result.code).toBe('pipeline_owner_changed');
    expect(result).not.toHaveProperty('details.submissionState');
    expect(await f.repo.kv.query('PROJECT#a', 'PIPELINE#')).toHaveLength(0);
    expect(transport.sm).not.toHaveBeenCalled();
  });
  it.each(['', 'a'.repeat(257)])('rejects an empty or oversized expected owner before calling AWS (%#)', async expectedOwnerSubject => {
    vi.stubEnv('ARTIFACTS_BUCKET', 'archive'); vi.stubEnv('SM_PIPELINE_NAME', 'groot'); resetConfigForTests();
    transport.sm.mockClear().mockImplementation(command => {
      if (command.constructor.name === 'DescribePipelineCommand') return {
        PipelineArn: 'arn:aws:sagemaker:us-east-1:123456789012:pipeline/groot',
        PipelineDefinition: JSON.stringify({ Parameters: [] }),
      };
      if (command.constructor.name === 'StartPipelineExecutionCommand') return { PipelineExecutionArn: executionArn };
      throw new Error(`Unexpected AWS command ${command.constructor.name}`);
    });
    const response = await startPipeline(req('/api/pipelines/executions', 'POST', {
      parameters: {}, expectedOwnerSubject,
    }));
    expect(response.status).toBe(400);
    const result = await response.json();
    expect(result.code).toBe('bad_request');
    expect(result).not.toHaveProperty('details.submissionState');
    expect(await f.repo.kv.query('PROJECT#a', 'PIPELINE#')).toHaveLength(0);
    expect(transport.sm).not.toHaveBeenCalled();
  });
  it('returns a scoped definitive rejection receipt over HTTP but never labels an authorization denial that way', async () => {
    vi.stubEnv('ARTIFACTS_BUCKET', 'archive'); vi.stubEnv('SM_PIPELINE_NAME', 'groot'); resetConfigForTests();
    transport.sm.mockImplementation(command => {
      if (command.constructor.name === 'DescribePipelineCommand') return {
        PipelineArn: 'arn:aws:sagemaker:us-east-1:123456789012:pipeline/groot',
        PipelineDefinition: JSON.stringify({ Parameters: [{ Name: 'MaxSteps', Type: 'Integer', DefaultValue: 100 }] }),
      };
      throw new Error(`Unexpected AWS command ${command.constructor.name}`);
    });
    const path = '/api/pipelines/executions', input = { parameters: { MaxSteps: '-1' } };
    const request = req(path, 'POST', input); request.headers.set('idempotency-key', 'rejected-http');
    const response = await startPipeline(request);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'pipeline_not_submitted', details: {
      submissionState: 'not_submitted', requestId: 'rejected-http', projectId: 'a', ownerSubject: 'alice-sub',
    } });
    expect(await f.repo.kv.queryGsi1('TYPE#PIPELINE_INTENT')).toHaveLength(0);
    const stale = req(path, 'POST', { parameters: { MaxSteps: '1' },
      expectedPipelineArn: 'arn:aws:sagemaker:us-east-1:123456789012:pipeline/other' });
    stale.headers.set('idempotency-key', 'stale-http');
    const staleResponse = await startPipeline(stale);
    expect(staleResponse.status).toBe(400);
    expect(await staleResponse.json()).toMatchObject({ code: 'pipeline_not_submitted' });
    expect(await f.repo.kv.queryGsi1('TYPE#PIPELINE_INTENT')).toHaveLength(0);
    const denied = await startPipeline(req(path, 'POST', input, 'reader-sub'));
    expect(denied.status).toBe(403);
    expect(await denied.json()).not.toHaveProperty('details.submissionState');
    expect(transport.sm.mock.calls.map(([command]) => command.constructor.name)).toEqual(['DescribePipelineCommand', 'DescribePipelineCommand']);
  });
  it('queues a project-scoped archive and exposes progress without starting another pipeline', async () => {
    const response = await requestArchive(req(archivePath, 'POST', { trainingStep: 'GR00TFinetune', reportSteps: ['SmokeEval'] }), { params: Promise.resolve({ arn: executionArn }) });
    expect(response.status).toBe(202);
    const record = await response.json();
    expect(record).toMatchObject({ status: 'PENDING', projectId: 'a', ownerSubject: 'alice-sub' });
    expect((await listArchives(req(archivePath), { params: Promise.resolve({ arn: executionArn }) })).status).toBe(200);
    expect(f.aws.commands.some(command => ['StartPipelineExecutionCommand', 'UpdateModelPackageCommand'].includes(command.name))).toBe(false);
  });
  it('rejects Origin, project-viewer, cross-project and arbitrary artifact URI requests', async () => {
    const input = { trainingStep: 'GR00TFinetune' }, context = { params: Promise.resolve({ arn: executionArn }) };
    expect((await requestArchive(req(archivePath, 'POST', input, 'alice-sub', 'a', 'https://foreign.invalid'), context)).status).toBe(403);
    expect((await requestArchive(req(archivePath, 'POST', input, 'reader-sub'), context)).status).toBe(403);
    expect((await requestArchive(req(archivePath, 'POST', input, 'bob-sub', 'b'), context)).status).toBe(403);
    expect((await requestArchive(req(archivePath, 'POST', { ...input, modelUri: 's3://foreign/private' }), context)).status).toBe(400);
    expect(f.aws.commands).toHaveLength(0);
  });
  it('keeps imported archive/model IDs scoped and never accepts Registry approval from smoke', async () => {
    const { archive, model } = await prepare();
    expect((await readArchive(req(`/api/pipelines/archives/${archive.id}`, 'GET', undefined, 'bob-sub', 'b'), { params: Promise.resolve({ id: archive.id }) })).status).toBe(404);
    await f.models.ingest(pipelineAdmin, 'a', { modelId: model.id, dataset: archive.datasetName, version: archive.version, reportPath: 'reports/SmokeEval/evaluation.json' });
    const response = await approveRegistry(req(`/api/models/${model.id}/registry-approval`, 'POST', { gateId: 'invented', confirm: true }), { params: Promise.resolve({ id: model.id }) });
    expect(response.status).toBe(400);
    expect(f.aws.commands.some(command => command.name === 'UpdateModelPackageCommand')).toBe(false);
  });
  it('shows real archive actions and distinct smoke-only versus quality states', async () => {
    const { archive, model } = await prepare();
    await f.models.ingest(pipelineAdmin, 'a', { modelId: model.id, dataset: archive.datasetName, version: archive.version, reportPath: 'reports/SmokeEval/evaluation.json' });
    transport.responses.set('/api/models', await f.models.list(pipelineAdmin, 'a'));
    transport.responses.set(`/api/models/${model.id}`, await f.models.get(pipelineAdmin, 'a', model.id));
    transport.responses.set(archivePath, [archive]);
    const modelHTML = renderToStaticMarkup(createElement(ModelsPage));
    expect(modelHTML).toContain('Smoke');
    expect(modelHTML).toContain('작업 평가 없음');
    expect(modelHTML).toContain('품질 미승인');
    expect(modelHTML).toContain('기존 smoke 승인은 로봇 작업 품질 승인이 아닙니다');
    expect(modelHTML).not.toContain('100.0%');
    expect(modelHTML).not.toContain('/workflows/undefined');
    expect(modelHTML).toMatch(/<button[^>]*disabled=""[^>]*>품질 승인을 SageMaker Registry에 반영<\/button>/);
    const panelHTML = renderToStaticMarkup(createElement(PipelineArchivePanel, { arn: executionArn, projectId: 'a', data: {
      canArchive: true, projectRecorded: true, execution: { PipelineExecutionStatus: 'Succeeded', PipelineExecutionDisplayName: 'Fixture', CreationTime: '', LastModifiedTime: '' },
      steps: [{ StepName: 'GR00TFinetune', StepStatus: 'Succeeded', Metadata: { TrainingJob: { Arn: 'fixture' } } }], parameters: [],
    } }));
    expect(panelHTML).toContain('완료 출력 검증·보관');
    expect(panelHTML).toContain('보관 출력에서 모델 등록');
    expect(panelHTML).toContain(archive.datasetName);
    expect(transport.api).not.toHaveBeenCalled();
  });
  it('binds the LeIsaac recipe link to the archived bundle and exact dataset version', async () => {
    const { model } = await prepare();
    const link = readEvaluationQuery(new URL(model.evaluationLaunch!.href, 'http://localhost').searchParams)!;
    expect(() => assertEvaluationModel(link, model)).not.toThrow();
    expect(() => assertEvaluationModel({ ...link, checkpointBundle: 'unrelated/model.tar.gz' }, model)).toThrow();
    const template = BUILTIN_TEMPLATES.find(template => template.id === 'leisaac-evaluate')!;
    const yaml = initializeWorkflowYaml(template, link);
    const { spec, vars } = parseWorkflowYaml(yaml);
    expect(vars.checkpoint_bundle).toBe('model/model.tar.gz');
    expect(vars.eval_seed).toBe('2042');
    expect(spec.workflow.tasks.every(task => task.inputs.some(input => 'dataset' in input && input.dataset.version === model.source.dataset.version))).toBe(true);
  });
});
