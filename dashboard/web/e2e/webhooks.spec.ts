import { readFile, writeFile } from 'node:fs/promises';
import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { SSMClient, DeleteParameterCommand } from '@aws-sdk/client-ssm';
import { test, expect, requireCondition } from './researcher-helpers/fixture';
import { producerWorkflow } from './researcher-helpers/workflows';
test.use({ screenshot: 'off', trace: 'off', video: 'off' });

test('an owned AWS receiver verifies a real workflow webhook and the delivery ledger', async ({ researcher }, info) => {
  test.setTimeout(15 * 60_000);
  requireCondition(process.env.PAI_WEBHOOK_FIXTURE_FILE, 'Set the private manifest path of an owned AWS receiver');
  const receiver = JSON.parse(await readFile(process.env.PAI_WEBHOOK_FIXTURE_FILE, 'utf8')) as {
    region: string; url: string; secret: string; projectId: string; logGroup: string; testId: string; cleaned?: boolean;
  };
  requireCondition(receiver.region === 'us-east-1' && receiver.projectId === researcher.project.id &&
    !receiver.cleaned && receiver.secret?.length >= 32 && receiver.url?.endsWith('.lambda-url.us-east-1.on.aws/'), 'Owned receiver identity/configuration mismatch');
  const logs = new CloudWatchLogsClient({ region: receiver.region });
  const ssm = new SSMClient({ region: receiver.region });
  const started = Date.now();
  const hookName = `AWS-receiver-${researcher.tag}`;
  let hookId: string | undefined;
  try {
    const hook = await researcher.api<{ id: string }>('POST', '/api/webhooks', {
      name: hookName, endpointUrl: receiver.url, secret: receiver.secret, statuses: ['SUCCEEDED'],
    });
    hookId = hook.id;
    requireCondition(/^wh-[a-f0-9]{32}$/.test(hookId), 'Invalid owned webhook id');
    const workflow = producerWorkflow(await researcher.recipe(), researcher.tag);
    const run = await researcher.submit(workflow);
    await researcher.completed(run.id);
    type Delivery = { id: string; eventId: string; runId: string; state: string; lastHttpStatus?: number; totalAttempts: number };
    const deliveries = await researcher.poll('durable webhook delivery', 120_000,
      () => researcher.api<Delivery[]>('GET', `/api/webhooks/${hookId}/deliveries`),
      rows => rows.some(row => row.runId === run.id && row.state === 'DELIVERED'),
      rows => rows.map(row => `${row.runId}:${row.state}:${row.lastHttpStatus ?? ''}`).join(',') || 'pending');
    const delivery = deliveries.find(row => row.runId === run.id && row.state === 'DELIVERED')!;
    expect(delivery.lastHttpStatus).toBe(200);
    const receipts = await researcher.poll('AWS receiver signature receipt', 90_000, async () => {
      const response = await logs.send(new FilterLogEventsCommand({
        logGroupName: receiver.logGroup, startTime: started, limit: 100,
        filterPattern: `{ $.kind = "pai-webhook-receipt" && $.runId = "${run.id}" }`,
      }));
      return (response.events ?? []).map(event => {
        try { return JSON.parse(event.message ?? '{}'); } catch { return {}; }
      });
    }, rows => rows.some(row => row.eventId === delivery.eventId && row.signatureVerified === true),
    rows => `${rows.length} verified receipt candidates`);
    const receipt = receipts.find(row => row.eventId === delivery.eventId && row.signatureVerified === true);
    expect(receipt).toMatchObject({ deliveryId: delivery.id, runId: run.id, projectId: researcher.project.id, status: 'SUCCEEDED', signatureVerified: true });
    const proofPath = info.outputPath('aws-webhook-proof.json');
    await writeFile(proofPath, JSON.stringify({
      runId: run.id, hookId, receiverTestId: receiver.testId, delivery, receipt, noExternalRecipient: true,
    }, null, 2));
    await info.attach('aws-webhook-proof', { contentType: 'application/json', path: proofPath });
  } finally {
    if (!hookId) {
      const listed = await researcher.api<{ hooks: { id: string; name: string; projectId: string; createdBy: string }[] }>('GET', '/api/webhooks');
      const owned = listed.hooks.filter(hook => hook.name === hookName && hook.projectId === researcher.project.id && hook.createdBy === researcher.principal.subject);
      requireCondition(owned.length <= 1, 'Ambiguous owned webhook registration; refusing broad cleanup');
      hookId = owned[0]?.id;
    }
    if (hookId) {
      await researcher.api('DELETE', `/api/webhooks/${hookId}`);
      try { await ssm.send(new DeleteParameterCommand({ Name: `/physical-ai/projects/${researcher.project.id}/webhooks/${hookId}` })); }
      catch (error) { if (!(error instanceof Error) || error.name !== 'ParameterNotFound') throw error; }
    }
    logs.destroy(); ssm.destroy();
  }
});
