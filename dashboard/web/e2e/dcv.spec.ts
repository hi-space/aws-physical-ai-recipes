import { SSMClient, SendCommandCommand, GetCommandInvocationCommand } from '@aws-sdk/client-ssm';
import { test, expect, requireCondition } from './researcher-helpers/fixture';
test.use({ screenshot: 'off', trace: 'off', video: 'off', ignoreHTTPSErrors: false });

test('Cognito browser session opens the registered DCV desktop through the gateway', async ({ researcher }, info) => {
  test.setTimeout(12 * 60_000);
  requireCondition(researcher.principal.role === 'admin', 'Shared workshop DCV requires a platform administrator');
  const instance = process.env.DCV_TEST_INSTANCE_ID;
  requireCondition(instance, 'DCV_TEST_INSTANCE_ID must identify the registered workshop instance');
  const ssm = new SSMClient({ region: 'us-east-1' });
  async function connectionCount() {
    const command = await ssm.send(new SendCommandCommand({ InstanceIds: [instance!], DocumentName: 'AWS-RunShellScript', Parameters: { commands: ['dcv list-sessions --json'] }, Comment: 'Read DCV connection count for dashboard validation' }));
    for (let attempt = 0; attempt < 15; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      let result;
      try { result = await ssm.send(new GetCommandInvocationCommand({ InstanceId: instance!, CommandId: command.Command!.CommandId! })); }
      catch { continue; }
      if (result.Status === 'Success') return Number((JSON.parse(result.StandardOutputContent!) as Array<Record<string, unknown>>).find((session) => session.id === 'console')?.['num-of-connections'] ?? 0);
      if (['Failed', 'Cancelled', 'TimedOut'].includes(result.Status ?? '')) throw new Error('DCV observation command failed');
    }
    throw new Error('DCV observation deadline exceeded');
  }
  const before = await connectionCount();
  const initial = await researcher.api<{ configured: boolean }>('GET', '/api/sessions/dcv/browser');
  if (!initial.configured) await researcher.api('POST', '/api/sessions/dcv/browser', { action: 'configure' });
  await researcher.poll('DCV host setup', 5 * 60_000, () => researcher.api<{ configured: boolean; status?: string }>('GET', '/api/sessions/dcv/browser'), (status) => {
    if (status.status === 'FAILED') throw new Error('DCV setup failed; inspect the owned setup command');
    return status.configured;
  }, (status) => status.configured ? 'configured' : status.status ?? 'waiting');
  const session = await researcher.api<{ id: string; status: string }>('POST', '/api/sessions/dcv/browser', { action: 'create', ttlMinutes: 10 });
  let desktop;
  try {
    const launch = await researcher.api<{ url: string }>('POST', `/api/sessions/dcv/browser/${session.id}`);
    requireCondition(new URL(launch.url).hostname === `${session.id}.apps.${new URL(researcher.origin).hostname}`, 'Unexpected DCV session origin');
    desktop = await researcher.page.context().newPage();
    try {
      const response = await desktop.goto(launch.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      console.log(`[dcv] main response status=${response?.status()}`);
      expect(response?.status()).toBe(200);
    }
    catch { throw new Error('DCV HTTPS navigation failed (sensitive URL omitted)'); }
    await researcher.poll('DCV browser connection', 120_000, connectionCount, (count) => count > before, (count) => `connections=${count}`);
    await expect(desktop.locator('canvas').first()).toBeVisible({ timeout: 30_000 });
    await info.attach('dcv-connection', { contentType: 'application/json', body: Buffer.from(JSON.stringify({ sessionId: session.id, instanceId: instance, priorConnections: before, connected: true, httpsValidated: true })) });
  } catch (error) {
    if (desktop && !desktop.isClosed()) {
      const text = (await desktop.locator('body').innerText()).slice(0, 1500)
        .replace(/https?:\/\/\S+/g, '[URL omitted]').replace(/v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[token omitted]');
      console.log(`[dcv] page title=${await desktop.title()} text=${text}`);
    }
    throw error;
  } finally {
    await desktop?.close();
    await researcher.api('DELETE', `/api/sessions/dcv/browser/${session.id}`);
  }
});
