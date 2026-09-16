import { createHash } from 'node:crypto';
import { SFNClient, StartExecutionCommand, SendTaskSuccessCommand, SendTaskFailureCommand, SendTaskHeartbeatCommand, DescribeExecutionCommand, type DescribeExecutionCommandOutput } from '@aws-sdk/client-sfn';
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { dynamo } from '../aws/clients';
import { config } from '../config';
import { TERMINAL_WF, type Workflow, type RunLease } from '../store/types';
import { getRepo } from '../store/repo';

const sfn = () => new SFNClient({ region: config().region });
const db = () => DynamoDBDocumentClient.from(dynamo(), { marshallOptions: { removeUndefinedValues: true } });
function callbackTable() {
  const name = process.env.WORKFLOW_CALLBACKS_TABLE;
  if (!name) throw new Error('Workflow callback storage is not configured');
  return name;
}
export async function dispatchWorkflow(workflow: Workflow, context: { signal: AbortSignal }) {
  const stateMachineArn = process.env.WORKFLOW_STATE_MACHINE_ARN;
  if (!stateMachineArn) throw new Error('Workflow orchestration is not configured');
  const input = JSON.stringify({ workflowId: workflow.id });
  try {
    const response = await sfn().send(new StartExecutionCommand({ stateMachineArn, name: workflow.id, input }), { abortSignal: context.signal });
    return { executionArn: response.executionArn };
  } catch (error) {
    if ((error as Error).name !== 'ExecutionAlreadyExists') throw error;
    return { executionArn: stateMachineArn.replace(':stateMachine:', ':execution:') + ':' + workflow.id };
  }
}
interface CallbackRecord { pk: 'CALLBACK'; sk: string; token: string; tokenHash: string; executionArn: string; ttl: number }
export async function acceptCallback(workflowId: string, token: string, executionArn: string) {
  const expected = process.env.WORKFLOW_STATE_MACHINE_ARN?.replace(':stateMachine:', ':execution:') + ':' + workflowId;
  if (executionArn !== expected) throw new Error('Execution is not owned by this workflow backend');
  // A stale delivery must not replace a live token after a Step Functions redrive.
  await sfn().send(new SendTaskHeartbeatCommand({ taskToken: token }));
  const record: CallbackRecord = { pk: 'CALLBACK', sk: workflowId, token, tokenHash: createHash('sha256').update(token).digest('hex'), executionArn, ttl: Math.floor(Date.now() / 1000) + 8 * 86400 };
  await db().send(new PutCommand({ TableName: callbackTable(), Item: record }));
}
interface CompletionContext { signal: AbortSignal; lease?: RunLease }
export async function recordExecutionOutcome(workflow: Workflow, executionArn: string, context: CompletionContext, observed?: DescribeExecutionCommandOutput) {
  const execution = observed ?? await sfn().send(new DescribeExecutionCommand({ executionArn }), { abortSignal: context.signal });
  const current = await getRepo().getWorkflow(workflow.id);
  if (!current) return execution;
  if (!context.lease) throw new Error('Execution outcome updates require a workflow lease');
  if (current.executionArn && current.executionArn !== executionArn) throw new Error('Workflow execution identity mismatch');
  const failed = ['FAILED', 'TIMED_OUT', 'ABORTED'].includes(execution.status ?? '');
  if (failed && !TERMINAL_WF.has(current.status)) await getRepo().requestCancellation(current.id, `Step Functions ${execution.status}`, new Date().toISOString());
  const changedSuccess = failed && current.status === 'SUCCEEDED';
  await getRepo().putWorkflow({
    ...current,
    orchestrationStatus: execution.status,
    orchestrationError: execution.error,
    ...(changedSuccess ? {
      computeResultBeforeOrchestrationFailure: current.status,
      status: execution.status === 'ABORTED' ? 'CANCELLED' : 'FAILED',
      message: `작업 결과는 보존됐지만 전체 실행이 ${execution.status} 상태로 종료되었습니다: ${execution.error ?? ''}`,
    } : {}),
  }, context.lease);
  return execution;
}
export async function completeWorkflow(workflow: Workflow, context: CompletionContext) {
  const response = await db().send(new GetCommand({ TableName: callbackTable(), Key: { pk: 'CALLBACK', sk: workflow.id }, ConsistentRead: true }), { abortSignal: context.signal });
  const record = response.Item as CallbackRecord | undefined;
  if (!record) {
    const receipt = await db().send(new GetCommand({ TableName: callbackTable(), Key: { pk: 'COMPLETED', sk: workflow.id }, ConsistentRead: true }));
    if (receipt.Item?.callbackAccepted || receipt.Item?.observedStatus) return;
    if (!workflow.executionArn && !workflow.projectId) return; // imported legacy run, not a Step Functions execution
    throw new Error('Waiting for the workflow execution callback registration');
  }
  let callbackAccepted = false;
  let observedStatus: string | undefined;
  try {
    if (workflow.status === 'SUCCEEDED') {
      await sfn().send(new SendTaskSuccessCommand({ taskToken: record.token, output: JSON.stringify({ workflowId: workflow.id, status: workflow.status }) }), { abortSignal: context.signal });
    } else {
      await sfn().send(new SendTaskFailureCommand({ taskToken: record.token, error: workflow.status, cause: (workflow.message ?? 'Workflow ended').slice(0, 2000) }), { abortSignal: context.signal });
    }
    callbackAccepted = true;
  } catch (error) {
    if (!['TaskTimedOut', 'TaskDoesNotExist', 'InvalidToken'].includes((error as Error).name)) throw error;
    const execution = await sfn().send(new DescribeExecutionCommand({ executionArn: record.executionArn }), { abortSignal: context.signal });
    if (['RUNNING', 'PENDING_REDRIVE'].includes(execution.status ?? '')) throw new Error('Closed callback token does not establish execution completion; waiting for a current token');
    if (!['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'ABORTED'].includes(execution.status ?? '')) throw new Error('Execution completion is not known');
    if (execution.status === 'SUCCEEDED') {
      const output = JSON.parse(execution.output ?? '{}');
      const result = output.result ?? output;
      if (result.workflowId !== workflow.id || result.status !== workflow.status) throw new Error('Execution result does not match the workflow callback');
      callbackAccepted = true;
    } else {
      callbackAccepted = execution.status === 'FAILED' && execution.error === workflow.status && workflow.status !== 'SUCCEEDED';
    }
    observedStatus = execution.status;
    await recordExecutionOutcome(workflow, record.executionArn, context, execution);
  }
  // Keep a receipt rather than a token so duplicate completion messages converge.
  await db().send(new PutCommand({
    TableName: callbackTable(),
    Item: { pk: 'COMPLETED', sk: workflow.id, executionArn: record.executionArn, requestedStatus: workflow.status, callbackAccepted, observedStatus, ttl: Math.floor(Date.now() / 1000) + 90 * 86400 },
  }));
  await db().send(new DeleteCommand({ TableName: callbackTable(), Key: { pk: 'CALLBACK', sk: workflow.id }, ConditionExpression: 'tokenHash = :hash', ExpressionAttributeValues: { ':hash': record.tokenHash } }));
}
export async function heartbeatCallbacks() {
  let lastKey: Record<string, unknown> | undefined;
  do {
    const response = await db().send(new QueryCommand({
      TableName: callbackTable(), KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': 'CALLBACK' }, ExclusiveStartKey: lastKey,
    }));
    const rows = (response.Items ?? []) as CallbackRecord[];
    for (let offset = 0; offset < rows.length; offset += 20) {
      await Promise.all(rows.slice(offset, offset + 20).map(async (record) => {
        try { await sfn().send(new SendTaskHeartbeatCommand({ taskToken: record.token })); }
        catch (error) {
          if (!['TaskTimedOut', 'TaskDoesNotExist', 'InvalidToken'].includes((error as Error).name)) throw error;
          // The EventBridge execution-end event drives cancellation of live work.
        }
      }));
    }
    lastKey = response.LastEvaluatedKey;
  } while (lastKey);
}
