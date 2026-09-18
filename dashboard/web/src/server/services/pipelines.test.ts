import { beforeEach, expect, it, vi } from 'vitest';
import { MemoryKV } from '../store/dynamo';
import type { Project } from '../auth/projects';
import type { Session } from '../auth/session';
import { assertPipelineAccess, assertTrainingJobAccess, projectExecution, startProjectPipeline, stopProjectPipeline, reconcilePipelineIntents, type PipelineDeps } from './pipelines';

const arn = 'arn:aws:sagemaker:us-east-1:123456789012:pipeline/groot/execution/test1';
const pipelineArn = 'arn:aws:sagemaker:us-east-1:123456789012:pipeline/groot';
const alice: Session = { user: 'alice', subject: 'alice-sub', email: '', role: 'researcher' };
const bob: Session = { ...alice, user: 'bob', subject: 'bob-sub' };
const project: Project = { id: 'lab', name: 'Lab', namespace: 'hyperpod-ns-lab', queue: 'default', credentialRefs: [], members: { 'alice-sub': 'researcher', 'bob-sub': 'researcher' }, createdAt: '', updatedAt: '' };
let d: PipelineDeps;
beforeEach(() => {
  d = {
    kv: new MemoryKV(),
    aws: {
      pipelineName: () => 'groot',
      describePipeline: vi.fn().mockResolvedValue({ PipelineArn: pipelineArn, parameters: [{ Name: 'MaxSteps', Type: 'Integer' }] }),
      startExecution: vi.fn().mockResolvedValue(arn),
      stopExecution: vi.fn().mockResolvedValue({}),
      describeExecution: vi.fn().mockResolvedValue({
        execution: { PipelineExecutionArn: arn, PipelineExecutionStatus: 'Executing' },
        steps: [{ StepName: 'Train', Metadata: { TrainingJob: { Arn: 'arn:aws:sagemaker:us-east-1:123456789012:training-job/owned-job' } } }],
        parameters: [],
      }),
    },
  };
});
it('adopts a repeated request and rejects changed parameters under the same key', async () => {
  const first = await startProjectPipeline(alice, project, { parameters: { MaxSteps: '100' } }, 'request', d);
  expect(await startProjectPipeline(alice, project, { parameters: { MaxSteps: '100' } }, 'request', d)).toEqual(first);
  expect(d.aws.startExecution).toHaveBeenCalledTimes(1);
  await expect(startProjectPipeline(alice, project, { parameters: { MaxSteps: '101' } }, 'request', d)).rejects.toMatchObject({ status: 409 });
});
it('rejects a changed owner before validation or reservation without issuing a not-submitted receipt', async () => {
  const input = { parameters: { Unknown: '1' }, expectedOwnerSubject: 'alice-sub' };
  const get = vi.spyOn(d.kv, 'get'), put = vi.spyOn(d.kv, 'put');
  const failure = await startProjectPipeline(bob, project, input, 'owner-changed', d).catch(error => error);
  expect(failure).toMatchObject({ status: 403, code: 'pipeline_owner_changed' });
  expect(failure).not.toHaveProperty('details.submissionState');
  expect(get).not.toHaveBeenCalled();
  expect(put).not.toHaveBeenCalled();
  expect(d.aws.describePipeline).not.toHaveBeenCalled();
  expect(d.aws.startExecution).not.toHaveBeenCalled();
});
it.each(['uncertain', 'completed'])('keeps an %s Alice intent unchanged when Bob retries her frozen request', async state => {
  const input = { parameters: { MaxSteps: '0' }, displayName: 'frozen-owner',
    expectedPipelineArn: pipelineArn, expectedOwnerSubject: 'alice-sub' };
  if (state === 'uncertain') {
    vi.mocked(d.aws.startExecution).mockRejectedValueOnce(new Error('response lost'));
    await expect(startProjectPipeline(alice, project, input, 'owner-retry', d)).rejects.toThrow('response lost');
  } else {
    await startProjectPipeline(alice, project, input, 'owner-retry', d);
  }
  const saved = structuredClone(await d.kv.query(`PROJECT#${project.id}`, 'PIPELINE#'));
  const failure = await startProjectPipeline(bob, project, input, 'owner-retry', d).catch(error => error);
  expect(failure).toMatchObject({ status: 403, code: 'pipeline_owner_changed' });
  expect(failure).not.toHaveProperty('details.submissionState');
  expect(await d.kv.query(`PROJECT#${project.id}`, 'PIPELINE#')).toEqual(saved);
  expect(d.aws.startExecution).toHaveBeenCalledTimes(1);
  expect(await startProjectPipeline(alice, project, input, 'owner-retry', d)).toMatchObject({ arn });
  expect(d.aws.startExecution).toHaveBeenCalledTimes(state === 'uncertain' ? 2 : 1);
  if (state === 'uncertain') {
    expect(vi.mocked(d.aws.startExecution).mock.calls[1]).toEqual(vi.mocked(d.aws.startExecution).mock.calls[0]);
  }
  expect(await d.kv.get(`PIPELINE_EXECUTION#${arn}`, 'META')).toMatchObject({ ownerSubject: 'alice-sub' });
});
it('accepts the authenticated user fallback and replays legacy requests without changing their hash', async () => {
  const session = { ...alice, subject: undefined };
  const input = { parameters: { MaxSteps: '100' } };
  const receipt = await startProjectPipeline(session, project, input, 'legacy-owner', d);
  expect(await startProjectPipeline(session, project, { ...input, expectedOwnerSubject: 'alice' }, 'legacy-owner', d)).toEqual(receipt);
  expect(await startProjectPipeline(session, project, input, 'legacy-owner', d)).toEqual(receipt);
  expect(d.aws.startExecution).toHaveBeenCalledTimes(1);
});
it('reconciles an accepted cloud request using exactly the persisted client token', async () => {
  vi.mocked(d.aws.startExecution).mockRejectedValueOnce(new Error('response lost'));
  await expect(startProjectPipeline(alice, project, { parameters: { MaxSteps: '100' } }, 'request', d)).rejects.toThrow('response lost');
  await reconcilePipelineIntents(d);
  expect(vi.mocked(d.aws.startExecution).mock.calls[1][2]).toEqual(vi.mocked(d.aws.startExecution).mock.calls[0][2]);
  expect(await d.kv.get(`PIPELINE_EXECUTION#${arn}`, 'META')).toMatchObject({ projectId: project.id });
});
it('returns a saved receipt even when the current pipeline definition is unavailable', async () => {
  const input = { parameters: { MaxSteps: '100' } };
  const receipt = await startProjectPipeline(alice, project, input, 'saved-receipt', d);
  vi.mocked(d.aws.describePipeline).mockRejectedValue(new Error('definition unavailable'));
  expect(await startProjectPipeline(alice, project, input, 'saved-receipt', d)).toEqual(receipt);
  expect(d.aws.startExecution).toHaveBeenCalledTimes(1);
  await expect(startProjectPipeline(alice, project, { parameters: { MaxSteps: '101' } }, 'saved-receipt', d))
    .rejects.toMatchObject({ status: 409 });
});
it('retries the saved parameters and server identity after a lost response and definition change', async () => {
  vi.mocked(d.aws.describePipeline).mockResolvedValue({ PipelineArn: pipelineArn, parameters: [
    { Name: 'MaxSteps', Type: 'Integer' }, { Name: 'DashboardProjectId', Type: 'String' }, { Name: 'DashboardOwnerSubject', Type: 'String' },
  ] } as Awaited<ReturnType<typeof d.aws.describePipeline>>);
  const input = { parameters: { MaxSteps: '0' }, displayName: 'frozen-request' };
  vi.mocked(d.aws.startExecution).mockRejectedValueOnce(new Error('response lost'));
  await expect(startProjectPipeline(alice, project, input, 'frozen', d)).rejects.toThrow('response lost');
  vi.mocked(d.aws.describePipeline).mockResolvedValue({ PipelineArn: pipelineArn, PipelineDefinition: undefined, $metadata: {}, parameters: [] });
  expect(await startProjectPipeline(alice, project, input, 'frozen', d)).toMatchObject({ arn });
  expect(vi.mocked(d.aws.startExecution).mock.calls[1]).toEqual(vi.mocked(d.aws.startExecution).mock.calls[0]);
  expect(vi.mocked(d.aws.startExecution).mock.calls[1][0]).toEqual({
    DashboardOwnerSubject: 'alice-sub', DashboardProjectId: 'lab', MaxSteps: '0',
  });
  await expect(startProjectPipeline(alice, project, { ...input, displayName: 'changed' }, 'frozen', d))
    .rejects.toMatchObject({ status: 409 });
});
it('denies cross-project reads and peer cancellation while permitting the project manager', async () => {
  await startProjectPipeline(alice, project, { parameters: {} }, 'request', d);
  await expect(assertPipelineAccess(alice, { ...project, id: 'other' }, arn, false, d)).rejects.toMatchObject({ status: 403 });
  await expect(stopProjectPipeline(bob, project, arn, d)).rejects.toMatchObject({ status: 403 });
  expect(d.aws.stopExecution).not.toHaveBeenCalled();
  await stopProjectPipeline(bob, { ...project, members: { ...project.members, 'bob-sub': 'project-admin' } }, arn, d);
  expect(d.aws.stopExecution).toHaveBeenCalledWith(arn, expect.any(String));
});
it('derives training-job access from backend execution steps', async () => {
  await startProjectPipeline(alice, project, { parameters: {} }, 'request', d);
  await expect(assertTrainingJobAccess(alice, project, 'unrelated-job', d)).rejects.toMatchObject({ status: 404 });
  await projectExecution(alice, project, arn, d);
  await expect(assertTrainingJobAccess(alice, project, 'owned-job', d)).resolves.toBeUndefined();
  await expect(assertTrainingJobAccess(alice, { ...project, id: 'other' }, 'owned-job', d)).rejects.toMatchObject({ status: 403 });
});
it('validates declared parameters before creating an execution intent', async () => {
  await expect(startProjectPipeline(alice, project, { parameters: { Unknown: '1' } }, 'request', d)).rejects.toMatchObject({ status: 400 });
  await expect(startProjectPipeline(alice, project, { parameters: { MaxSteps: '-1' } }, 'invalid-number', d)).rejects.toMatchObject({ status: 400 });
  expect(d.aws.startExecution).not.toHaveBeenCalled();
});
it('records a definitive rejection without an executable intent and keeps the rejected key terminal', async () => {
  const input = { parameters: { Unknown: '1' } };
  const rejection = { status: 400, code: 'pipeline_not_submitted',
    details: { submissionState: 'not_submitted', requestId: 'rejected', projectId: 'lab', ownerSubject: 'alice-sub' } };
  await expect(startProjectPipeline(alice, project, input, 'rejected', d)).rejects.toMatchObject(rejection);
  expect(await d.kv.queryGsi1('TYPE#PIPELINE_INTENT')).toHaveLength(0);
  vi.mocked(d.aws.describePipeline).mockRejectedValue(new Error('definition unavailable'));
  await expect(startProjectPipeline(alice, project, input, 'rejected', d)).rejects.toMatchObject(rejection);
  await expect(startProjectPipeline(alice, project, { parameters: { MaxSteps: '1' } }, 'rejected', d))
    .rejects.toMatchObject({ status: 409 });
  await reconcilePipelineIntents(d);
  expect(d.aws.startExecution).not.toHaveBeenCalled();
});
it('never labels an AWS error after intent persistence as definitively not submitted', async () => {
  const failure = new Error('AWS rejected or lost response');
  vi.mocked(d.aws.startExecution).mockRejectedValue(failure);
  await expect(startProjectPipeline(alice, project, { parameters: { MaxSteps: '1' } }, 'uncertain', d)).rejects.toBe(failure);
  expect(await d.kv.queryGsi1('TYPE#PIPELINE_INTENT')).toHaveLength(1);
});
it('cannot issue a not-submitted receipt when a concurrent request already reserved that key', async () => {
  let release!: (value: Awaited<ReturnType<typeof d.aws.describePipeline>>) => void;
  vi.mocked(d.aws.describePipeline).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const delayed = startProjectPipeline(alice, project, { parameters: { Unknown: '1' } }, 'raced-key', d);
  const rejected = expect(delayed).rejects.toMatchObject({ status: 409, code: 'error' });
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  await startProjectPipeline(alice, project, { parameters: { MaxSteps: '1' } }, 'raced-key', d);
  release({ PipelineArn: pipelineArn, parameters: [{ Name: 'MaxSteps', Type: 'Integer' }] } as Awaited<ReturnType<typeof d.aws.describePipeline>>);
  await rejected;
  expect(d.aws.startExecution).toHaveBeenCalledTimes(1);
  expect((await d.kv.queryGsi1('TYPE#PIPELINE_INTENT'))[0].arn).toBe(arn);
});
it('cannot dispatch a concurrent acceptance after a not-submitted receipt reserved the key', async () => {
  let release!: (value: Awaited<ReturnType<typeof d.aws.describePipeline>>) => void;
  vi.mocked(d.aws.describePipeline).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const input = { parameters: { MaxSteps: '1' } };
  const delayed = startProjectPipeline(alice, project, input, 'rejection-wins', d);
  const rejected = expect(delayed).rejects.toMatchObject({ status: 400, code: 'pipeline_not_submitted' });
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  vi.mocked(d.aws.describePipeline).mockResolvedValue({ parameters: [] } as unknown as Awaited<ReturnType<typeof d.aws.describePipeline>>);
  await expect(startProjectPipeline(alice, project, input, 'rejection-wins', d)).rejects.toMatchObject({ code: 'pipeline_not_submitted' });
  release({ PipelineArn: pipelineArn, parameters: [{ Name: 'MaxSteps', Type: 'Integer' }] } as Awaited<ReturnType<typeof d.aws.describePipeline>>);
  await rejected;
  expect(d.aws.startExecution).not.toHaveBeenCalled();
  expect(await d.kv.queryGsi1('TYPE#PIPELINE_INTENT')).toHaveLength(0);
});
it.each(['name', 'arn'])('pins the target and prevents wrong-target starts after %s drift on retry and reconciliation', async drift => {
  vi.mocked(d.aws.startExecution).mockRejectedValueOnce(new Error('response lost'));
  const input = { parameters: { MaxSteps: '1' }, expectedPipelineArn: pipelineArn };
  await expect(startProjectPipeline(alice, project, input, 'pinned-target', d)).rejects.toThrow('response lost');
  const saved = (await d.kv.queryGsi1('TYPE#PIPELINE_INTENT'))[0];
  expect(saved.pipelineArn).toBe(pipelineArn);
  vi.mocked(d.aws.startExecution).mockClear();
  if (drift === 'name') d.aws.pipelineName = () => 'replacement';
  vi.mocked(d.aws.describePipeline).mockResolvedValue({
    PipelineArn: drift === 'name' ? pipelineArn.replace('/groot', '/replacement') : pipelineArn.replace('123456789012', '222222222222'),
    parameters: [{ Name: 'MaxSteps', Type: 'Integer' }],
  } as Awaited<ReturnType<typeof d.aws.describePipeline>>);
  await expect(startProjectPipeline(alice, project, input, 'pinned-target', d)).rejects.toMatchObject({ status: 409, code: 'pipeline_target_changed' });
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try { await reconcilePipelineIntents(d); } finally { log.mockRestore(); }
  expect(d.aws.startExecution).not.toHaveBeenCalled();
  expect((await d.kv.queryGsi1('TYPE#PIPELINE_INTENT'))[0]).toEqual(saved);
});
it('rejects a stale expected target before reserving an executable intent', async () => {
  await expect(startProjectPipeline(alice, project, {
    parameters: { MaxSteps: '1' }, expectedPipelineArn: pipelineArn.replace('/groot', '/other'),
  }, 'stale-target', d)).rejects.toMatchObject({ status: 400, code: 'pipeline_not_submitted' });
  expect(d.aws.startExecution).not.toHaveBeenCalled();
  expect(await d.kv.queryGsi1('TYPE#PIPELINE_INTENT')).toHaveLength(0);
});
it('replays completed legacy receipts under config drift but never guesses a target for unresolved legacy intents', async () => {
  const input = { parameters: { MaxSteps: '1' }, expectedPipelineArn: pipelineArn };
  const receipt = await startProjectPipeline(alice, project, input, 'legacy', d);
  const saved = (await d.kv.queryGsi1('TYPE#PIPELINE_INTENT'))[0];
  delete saved.pipelineArn; await d.kv.put(saved);
  d.aws.pipelineName = () => 'replacement';
  vi.mocked(d.aws.describePipeline).mockRejectedValue(new Error('new configuration unavailable'));
  vi.mocked(d.aws.startExecution).mockClear();
  expect(await startProjectPipeline(alice, project, input, 'legacy', d)).toEqual(receipt);
  delete saved.arn; await d.kv.put(saved);
  await expect(startProjectPipeline(alice, project, input, 'legacy', d)).rejects.toMatchObject({ status: 409, code: 'pipeline_target_unverified' });
  expect(d.aws.startExecution).not.toHaveBeenCalled();
});
it('injects project tracking identity from the server and rejects client overrides', async () => {
  vi.mocked(d.aws.describePipeline).mockResolvedValue({ PipelineArn: pipelineArn, parameters: [
    { Name: 'MaxSteps', Type: 'Integer' }, { Name: 'DashboardProjectId', Type: 'String' }, { Name: 'DashboardOwnerSubject', Type: 'String' },
  ] } as Awaited<ReturnType<typeof d.aws.describePipeline>>);
  await expect(startProjectPipeline(alice, project, { parameters: { DashboardProjectId: 'other' } }, 'spoof', d)).rejects.toMatchObject({ status: 400 });
  await startProjectPipeline(alice, project, { parameters: { MaxSteps: '100' } }, 'scoped', d);
  expect(d.aws.startExecution).toHaveBeenCalledWith({
    DashboardOwnerSubject: 'alice-sub', DashboardProjectId: 'lab', MaxSteps: '100',
  }, expect.any(String), expect.any(String), pipelineArn);
});
it('does no discovery or dispatch when reconciliation starts after shutdown', async () => {
  const shutdown = new AbortController(); shutdown.abort();
  const query = vi.spyOn(d.kv, 'queryGsi1');
  await reconcilePipelineIntents(d, shutdown.signal);
  expect(query).not.toHaveBeenCalled();
  expect(d.aws.startExecution).not.toHaveBeenCalled();
});
it('does not dispatch queued intents when shutdown arrives during discovery', async () => {
  vi.mocked(d.aws.startExecution).mockRejectedValueOnce(new Error('lost response'));
  await expect(startProjectPipeline(alice, project, { parameters: {} }, 'shutdown', d)).rejects.toThrow('lost response');
  vi.mocked(d.aws.startExecution).mockClear();
  const shutdown = new AbortController(), original = d.kv.queryGsi1.bind(d.kv);
  vi.spyOn(d.kv, 'queryGsi1').mockImplementation(async (...args) => {
    const rows = await original(...args); shutdown.abort(); return rows;
  });
  await reconcilePipelineIntents(d, shutdown.signal);
  expect(d.aws.startExecution).not.toHaveBeenCalled();
  expect(await d.kv.get(`PIPELINE_EXECUTION#${arn}`, 'META')).toBeUndefined();
});
it('retains an accepted dispatch receipt if shutdown happens while its reply arrives', async () => {
  vi.mocked(d.aws.startExecution).mockRejectedValueOnce(new Error('lost response'));
  await expect(startProjectPipeline(alice, project, { parameters: {} }, 'accepted', d)).rejects.toThrow('lost response');
  const shutdown = new AbortController();
  vi.mocked(d.aws.startExecution).mockImplementationOnce(async () => { shutdown.abort(); return arn; });
  await reconcilePipelineIntents(d, shutdown.signal);
  expect(await d.kv.get(`PIPELINE_EXECUTION#${arn}`, 'META')).toMatchObject({ projectId: project.id, ownerSubject: 'alice-sub' });
  expect(d.aws.stopExecution).not.toHaveBeenCalled();
});
