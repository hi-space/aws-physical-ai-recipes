import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { getRepo } from './server/store/repo';
import { configureController, startController, stopController, controllerStatus, reconcileFresh } from './server/workflow/controller';
import { seedBuiltinTemplates } from './server/workflow/builtin-templates';
import { productionControllerDeps } from './server/workflow-adapters/dependencies';
import { finalizePendingVersions } from './server/services/datasets';
import { handleRuntimeRequest } from './server/runtime';
import { handleTrackingRequest } from './server/tracking-proxy';
import { cleanupExpiredSessions, cancelRunSessions } from './server/services/sessions';
import { cleanupDcvSessions, reconcileDcvSetup } from './server/dcv/sessions';
import { reconcilePipelineIntents } from './server/services/pipelines';
import { reconcileSourceBuilds } from './server/services/source-builds';
import { refreshBackendChecks } from './server/backends/registry';
import { reconcileWebhookDeliveries } from './server/services/webhooks';
import { idleScalingTick } from './server/services/idle-scaling';

const shutdown = new AbortController();
const sleep = async (ms: number) => { try { await delay(ms, undefined, { signal: shutdown.signal }); } catch (error) { if (!shutdown.signal.aborted) throw error; } };
async function heartbeat() {
  while (!shutdown.signal.aborted) {
    try {
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
    const results = await Promise.allSettled([cleanupExpiredSessions(), cleanupDcvSessions(), reconcileDcvSetup()]);
    for (const result of results) if (result.status === 'rejected') console.error('[worker] session reconciliation failed', result.reason instanceof Error ? result.reason.name : 'error');
    await sleep(5000);
  }
}
async function main() {
  if (!process.env.DASHBOARD_ARTIFACT_BUCKET) throw new Error('DASHBOARD_ARTIFACT_BUCKET is required');
  configureController({ ...productionControllerDeps(), cancelSessions: (workflow, context) => cancelRunSessions(workflow, context) });
  await seedBuiltinTemplates();
  startController(5000);
  const server = createServer(async (req, res) => {
    if (req.url === '/health') {
      const healthy = reconcileFresh();
      res.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: healthy, controller: controllerStatus().running }));
    } else if (!await handleTrackingRequest(req, res) && !await handleRuntimeRequest(req, res)) { res.writeHead(404); res.end(); }
  }).listen(3001, '0.0.0.0');
  const stop = () => { shutdown.abort(); stopController(); server.close(); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  await Promise.all([heartbeat(), finalizeDatasets(), reconcileSessions(), reconcilePipelines(),
    manageSourceBuilds(), monitorBackends(), deliverWebhooks(), manageIdleCapacity()]);
}
async function reconcilePipelines() {
  while (!shutdown.signal.aborted) {
    try { await reconcilePipelineIntents(undefined, shutdown.signal); }
    catch (error) { if (!shutdown.signal.aborted) console.error('[worker] pipeline reconciliation failed', (error as Error).name); }
    await sleep(5000);
  }
}
async function manageSourceBuilds() {
  while (!shutdown.signal.aborted) {
    try { await reconcileSourceBuilds(shutdown.signal); }
    catch (error) { if (!shutdown.signal.aborted) console.error('[worker] source build reconciliation failed', (error as Error).name); }
    await sleep(5000);
  }
}
async function manageIdleCapacity() {
  while (!shutdown.signal.aborted) {
    try { await idleScalingTick(shutdown.signal); }
    catch (error) { if (!shutdown.signal.aborted) console.error('[worker] idle policy check failed', (error as Error).name); }
    await sleep(60_000);
  }
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
