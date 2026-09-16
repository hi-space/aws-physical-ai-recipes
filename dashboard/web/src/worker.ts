import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } from '@aws-sdk/client-sqs';
import { config } from './server/config';
import { getRepo } from './server/store/repo';
import { TERMINAL_WF } from './server/store/types';
import { configureController, startController, stopController, controllerStatus, cancelWorkflow } from './server/workflow/controller';
import { seedBuiltinTemplates } from './server/workflow/builtin-templates';
import { productionControllerDeps } from './server/workflow-adapters/dependencies';
import { acceptCallback, completeWorkflow, heartbeatCallbacks, recordExecutionOutcome } from './server/workflow-adapters/dispatch';
import { withRunLease } from './server/workflow/lease';
import { finalizePendingVersions } from './server/services/datasets';
import { handleRuntimeRequest } from './server/runtime';
import { handleTrackingRequest } from './server/tracking-proxy';
import { cleanupExpiredSessions, cancelRunSessions } from './server/services/sessions';
import { cleanupDcvSessions, reconcileDcvSetup } from './server/dcv/sessions';
import { reconcilePipelineIntents } from './server/services/pipelines';
import { refreshBackendChecks } from './server/backends/registry';
import { reconcileWebhookDeliveries } from './server/services/webhooks';

const shutdown = new AbortController();
const sqs = new SQSClient({ region: config().region });
let lastQueuePoll = Date.now();
const sleep = async (ms: number) => { try { await delay(ms, undefined, { signal: shutdown.signal }); } catch (error) { if (!shutdown.signal.aborted) throw error; } };
function expiredToken(error: unknown) { return ['TaskTimedOut', 'TaskDoesNotExist', 'InvalidToken'].includes((error as Error).name); }

async function receiveRequests() {
  const queue = process.env.WORKFLOW_QUEUE_URL;
  if (!queue) throw new Error('WORKFLOW_QUEUE_URL is required');
  while (!shutdown.signal.aborted) {
    try {
      const response = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queue, MaxNumberOfMessages: 10, WaitTimeSeconds: 20 }), { abortSignal: shutdown.signal });
      lastQueuePoll = Date.now();
      for (const message of response.Messages ?? []) {
        try {
          const input = JSON.parse(message.Body ?? '{}');
          if (input.kind === 'workflow.start') {
            const workflow = await getRepo().getWorkflow(input.workflowId);
            if (!workflow || typeof input.token !== 'string') throw new Error('Unknown workflow dispatch');
            try { await acceptCallback(workflow.id, input.token, input.executionArn); }
            catch (error) { if (!expiredToken(error)) throw error; }
            if (TERMINAL_WF.has(workflow.status)) {
              await withRunLease(workflow.id, productionControllerDeps(), (guard) => completeWorkflow(workflow, { signal: guard.signal, lease: guard.lease }));
            }
          } else if (input.kind === 'workflow.execution-ended') {
            const prefix = process.env.WORKFLOW_STATE_MACHINE_ARN?.replace(':stateMachine:', ':execution:') + ':';
            if (typeof input.executionArn !== 'string' || !input.executionArn.startsWith(prefix)) throw new Error('Unknown execution event');
            const workflowId = input.executionArn.slice(prefix.length);
            const workflow = await getRepo().getWorkflow(workflowId);
            if (workflow) {
              const recorded = await withRunLease(workflow.id, productionControllerDeps(), async (guard) => {
                await recordExecutionOutcome(workflow, input.executionArn, { signal: guard.signal, lease: guard.lease }); return true;
              });
              if (!recorded) throw new Error('Workflow is being reconciled; execution event will retry');
            }
          } else throw new Error('Unknown workflow queue message');
          await sqs.send(new DeleteMessageCommand({ QueueUrl: queue, ReceiptHandle: message.ReceiptHandle }), { abortSignal: shutdown.signal });
        } catch (error) {
          console.error('[worker] request not acknowledged', (error as Error).name);
        }
      }
    } catch (error) {
      if (shutdown.signal.aborted) break;
      console.error('[worker] queue poll failed', (error as Error).name);
      await sleep(3000);
    }
  }
}
async function heartbeat() {
  while (!shutdown.signal.aborted) {
    try {
      await heartbeatCallbacks();
      await getRepo().acquireLease('CONTROLLER', `worker-${process.pid}`, 60);
    } catch (error) { console.error('[worker] heartbeat failed', (error as Error).name); }
    await sleep(20_000);
  }
}
async function finalizeDatasets() {
  while (!shutdown.signal.aborted) {
    try { await finalizePendingVersions(shutdown.signal); }
    catch (error) { if (!shutdown.signal.aborted) console.error('[worker] dataset processing failed', (error as Error).name); }
    await sleep(10_000);
  }
}
async function reconcileSessions() {
  while (!shutdown.signal.aborted) {
    const results = await Promise.allSettled([cleanupExpiredSessions(), cleanupDcvSessions(), reconcileDcvSetup(), reconcilePipelineIntents()]);
    for (const result of results) if (result.status === 'rejected') console.error('[worker] session reconciliation failed', result.reason instanceof Error ? result.reason.name : 'error');
    await sleep(5000);
  }
}
async function main() {
  for (const key of ['WORKFLOW_QUEUE_URL', 'WORKFLOW_STATE_MACHINE_ARN', 'WORKFLOW_CALLBACKS_TABLE', 'DASHBOARD_ARTIFACT_BUCKET']) {
    if (!process.env[key]) throw new Error(`${key} is required`);
  }
  configureController({ ...productionControllerDeps(), cancelSessions: (workflow, context) => cancelRunSessions(workflow, context) });
  await seedBuiltinTemplates();
  startController(5000);
  const server = createServer(async (req, res) => {
    if (req.url === '/health') {
      const healthy = Date.now() - lastQueuePoll < 120_000;
      res.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: healthy, controller: controllerStatus().running }));
    } else if (!await handleTrackingRequest(req, res) && !await handleRuntimeRequest(req, res)) { res.writeHead(404); res.end(); }
  }).listen(3001, '0.0.0.0');
  const stop = () => { shutdown.abort(); stopController(); server.close(); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  await Promise.all([receiveRequests(), heartbeat(), finalizeDatasets(), reconcileSessions(), monitorBackends(), deliverWebhooks()]);
}
async function deliverWebhooks() {
  while (!shutdown.signal.aborted) {
    try { await reconcileWebhookDeliveries(shutdown.signal); }
    catch (error) { if (!shutdown.signal.aborted) console.error('[worker] webhook reconciliation failed', (error as Error).name); }
    await sleep(5000);
  }
}
async function monitorBackends() {
  while (!shutdown.signal.aborted) {
    try { await refreshBackendChecks(); }
    catch (error) { console.error('[worker] backend checks unavailable', (error as Error).name); }
    await sleep(5 * 60_000);
  }
}
main().catch((error) => { console.error('[worker] startup failed', (error as Error).message); shutdown.abort(); stopController(); process.exit(1); });
