import { beforeEach, expect, it, vi } from 'vitest';
import { MemoryKV } from '../store/dynamo';
import type { Project } from '../auth/projects';
import type { Session } from '../auth/session';
import { assertPipelineAccess, assertTrainingJobAccess, projectExecution, startProjectPipeline, stopProjectPipeline, reconcilePipelineIntents, type PipelineDeps } from './pipelines';

const arn = 'arn:aws:sagemaker:us-east-1:123456789012:pipeline/groot/execution/test1';
const alice: Session = { user: 'alice', subject: 'alice-sub', email: '', role: 'researcher' };
const bob: Session = { ...alice, user: 'bob', subject: 'bob-sub' };
const project: Project = { id: 'lab', name: 'Lab', namespace: 'hyperpod-ns-lab', queue: 'default', credentialRefs: [], members: { 'alice-sub': 'researcher', 'bob-sub': 'researcher' }, createdAt: '', updatedAt: '' };
let d: PipelineDeps;
beforeEach(() => {
  d = {
    kv: new MemoryKV(),
    aws: {
      pipelineName: () => 'groot',
      describePipeline: vi.fn().mockResolvedValue({ parameters: [{ Name: 'MaxSteps', Type: 'Integer' }] }),
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
it('reconciles an accepted cloud request using exactly the persisted client token', async () => {
  vi.mocked(d.aws.startExecution).mockRejectedValueOnce(new Error('response lost'));
  await expect(startProjectPipeline(alice, project, { parameters: { MaxSteps: '100' } }, 'request', d)).rejects.toThrow('response lost');
  await reconcilePipelineIntents(d);
  expect(vi.mocked(d.aws.startExecution).mock.calls[1][2]).toEqual(vi.mocked(d.aws.startExecution).mock.calls[0][2]);
  expect(await d.kv.get(`PIPELINE_EXECUTION#${arn}`, 'META')).toMatchObject({ projectId: project.id });
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
  await expect(startProjectPipeline(alice, project, { parameters: { MaxSteps: '-1' } }, 'request', d)).rejects.toMatchObject({ status: 400 });
  expect(d.aws.startExecution).not.toHaveBeenCalled();
});
