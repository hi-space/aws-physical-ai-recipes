import { beforeEach, describe, expect, it, vi } from 'vitest';
const { sendState, sendDocument } = vi.hoisted(() => ({ sendState: vi.fn(), sendDocument: vi.fn() }));
vi.mock('@aws-sdk/client-sfn', async (original) => {
  const actual = await original<typeof import('@aws-sdk/client-sfn')>();
  return { ...actual, SFNClient: class { send = sendState; } };
});
vi.mock('@aws-sdk/lib-dynamodb', async (original) => {
  const actual = await original<typeof import('@aws-sdk/lib-dynamodb')>();
  return { ...actual, DynamoDBDocumentClient: { from: () => ({ send: sendDocument }) } };
});
vi.mock('../aws/clients', () => ({ dynamo: vi.fn() }));
import { completeWorkflow } from './dispatch';
import { Repo, setRepoForTests } from '../store/repo';
import { MemoryKV } from '../store/dynamo';
import { workflowSchema } from '../workflow/schema';
import type { Workflow } from '../store/types';
let repo: Repo;
let workflow: Workflow;
beforeEach(async () => {
  vi.stubEnv('WORKFLOW_CALLBACKS_TABLE', 'callbacks');
  repo = new Repo(new MemoryKV()); setRepoForTests(repo);
  workflow = {
    id: 'run-one', name: 'one', owner: 'alice', projectId: 'p', namespace: 'hyperpod-ns-a', status: 'SUCCEEDED',
    spec: workflowSchema.parse({ workflow: { name: 'one', resources: { cpu: { cpu: 1 } }, tasks: [{ name: 'task', resource: 'cpu', image: 'image', command: ['true'] }] } }),
    specYaml: '', vars: {}, createdAt: '2026-09-16T00:00:00Z', updatedAt: '2026-09-16T00:00:01Z', taskCount: 1, succeededCount: 1, failedCount: 0,
    executionArn: 'arn:aws:states:us-east-1:123456789012:execution:state:run-one',
  };
  await repo.putWorkflow(workflow);
  sendDocument.mockReset().mockImplementation(async (command) => command.constructor.name === 'GetCommand'
    ? { Item: { pk: 'CALLBACK', sk: workflow.id, token: 'private-fixture', tokenHash: 'hash', executionArn: workflow.executionArn } } : {});
  sendState.mockReset().mockImplementation(async (command) => {
    if (command.constructor.name === 'SendTaskSuccessCommand') throw Object.assign(new Error('closed'), { name: 'TaskTimedOut' });
    return { status: 'TIMED_OUT', error: 'States.Timeout' };
  });
});
describe('orchestration completion', () => {
  it('records timeout as a failed outer execution, not an accepted successful callback', async () => {
    const lease = await repo.acquireRunLease(workflow.id);
    await completeWorkflow(workflow, { signal: new AbortController().signal, lease });
    expect(await repo.getWorkflow(workflow.id)).toMatchObject({ status: 'FAILED', orchestrationStatus: 'TIMED_OUT', computeResultBeforeOrchestrationFailure: 'SUCCEEDED' });
    const receipt = sendDocument.mock.calls.find(([command]) => command.constructor.name === 'PutCommand')?.[0].input.Item;
    expect(receipt).toMatchObject({ callbackAccepted: false, observedStatus: 'TIMED_OUT', requestedStatus: 'SUCCEEDED' });
  });
  it('keeps a closed callback pending when the execution is still running', async () => {
    sendState.mockImplementation(async (command) => {
      if (command.constructor.name === 'SendTaskSuccessCommand') throw Object.assign(new Error('closed'), { name: 'InvalidToken' });
      return { status: 'RUNNING' };
    });
    await expect(completeWorkflow(workflow, { signal: new AbortController().signal, lease: await repo.acquireRunLease(workflow.id) })).rejects.toThrow(/does not establish/);
    expect(sendDocument.mock.calls.some(([command]) => ['PutCommand', 'DeleteCommand'].includes(command.constructor.name))).toBe(false);
  });
  it('accepts an already-completed callback only when its actual result matches', async () => {
    sendState.mockImplementation(async (command) => {
      if (command.constructor.name === 'SendTaskSuccessCommand') throw Object.assign(new Error('closed'), { name: 'TaskDoesNotExist' });
      return { status: 'SUCCEEDED', output: JSON.stringify({ result: { workflowId: workflow.id, status: 'SUCCEEDED' } }) };
    });
    await completeWorkflow(workflow, { signal: new AbortController().signal, lease: await repo.acquireRunLease(workflow.id) });
    expect(await repo.getWorkflow(workflow.id)).toMatchObject({ status: 'SUCCEEDED', orchestrationStatus: 'SUCCEEDED' });
  });
});
