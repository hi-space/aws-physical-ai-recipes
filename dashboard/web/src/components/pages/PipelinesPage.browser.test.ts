/** Real React components + API client in Chromium; all traffic stays on loopback. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { build } from 'esbuild';
import { startProjectPipeline, type PipelineDeps } from '../../server/services/pipelines';
import { MemoryKV } from '../../server/store/dynamo';
import { HttpError } from '../../server/errors';

const pipelineArn = 'arn:aws:sagemaker:us-east-1:123456789012:pipeline/groot';
const executionArn = `${pipelineArn}/execution/run1`;
const executionPath = `/api/pipelines/executions/${encodeURIComponent(executionArn)}`;
const defaults = [
  { Name: 'HfDatasetId', Type: 'String', DefaultValue: 'org/default' },
  { Name: 'InstanceType', Type: 'String', DefaultValue: 'ml.g5.2xlarge' },
  { Name: 'MaxSteps', Type: 'Integer', DefaultValue: 1000 },
  { Name: 'GlobalBatchSize', Type: 'Integer', DefaultValue: 8 },
  { Name: 'NumGpus', Type: 'Integer', DefaultValue: 0 },
  { Name: 'SaveSteps', Type: 'Integer', DefaultValue: 500 },
];
const expectedDefaults = {
  HfDatasetId: 'org/default', InstanceType: 'ml.g5.2xlarge', MaxSteps: '1000',
  GlobalBatchSize: '8', NumGpus: '0', SaveSteps: '500',
};
type Call = { path: string; method: string; body: Record<string, unknown>; project?: string; key?: string };

describe('pipeline browser contracts', () => {
  let browser: Browser, server: Server, origin: string, page: Page;
  let calls: Call[], errors: string[], parameters: typeof defaults;
  let responseMode: 'success' | 'lost' | 'missing-arn' | 'pending' | 'rejected' | 'unmarked-400' | 'forbidden' | 'conflict', release: (() => void) | undefined;
  let user: string, executionStatus: string, metadata: boolean, fineTuneStarted: boolean;
  let role: 'researcher' | 'viewer', serviceDeps: PipelineDeps | undefined;

  beforeAll(async () => {
    const bundle = await build({
      stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
        import React from 'react'; import {createRoot} from 'react-dom/client';
        import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
        import {PipelinesPage} from './src/components/pages/PipelinesPage';
        import {PipelineExecutionPage} from './src/components/pages/PipelineExecutionPage';
        const client = new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false}}});
        window.fixtureClient = client;
        const view = location.pathname === '/detail'
          ? React.createElement(PipelineExecutionPage,{arn:${JSON.stringify(executionArn)}})
          : React.createElement(PipelinesPage);
        const root = createRoot(document.getElementById('root')); let mount = 0;
        window.fixtureRemount = () => root.render(
          React.createElement(QueryClientProvider,{client,key:mount++},view));
        window.fixtureRemount();` },
      bundle: true, write: false, platform: 'browser', format: 'iife',
      define: { 'process.env.NODE_ENV': '"test"' },
      plugins: [{ name: 'fixture-next', setup(builder) {
        builder.onResolve({ filter: /^next\/(navigation|link)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({
          loader: 'jsx', resolveDir: process.cwd(), contents: args.path.endsWith('navigation')
            ? `export function useRouter(){return {push:url=>{window.fixtureDestination=url}}}
               export function useSearchParams(){return new URLSearchParams(location.search)}`
            : `import React from 'react'; export default function Link({href,children,...props}){return <a href={href} {...props}>{children}</a>}`,
        }));
      } }],
    });
    server = createServer(async (req, res) => {
      const url = new URL(req.url!, 'http://fixture');
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      const authenticatedUser = /(?:^|;\s*)fixture-user=([^;]+)/.exec(req.headers.cookie ?? '')?.[1] ?? user;
      const call: Call = { path: url.pathname, method: req.method!, body,
        project: req.headers['x-pai-project'] as string | undefined, key: req.headers['idempotency-key'] as string | undefined };
      calls.push(call);
      const json = (value: unknown, status = 200) => {
        if (res.destroyed) return;
        res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value));
      };
      if (url.pathname === '/bundle.js') {
        res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(bundle.outputFiles[0].text); return;
      }
      if (!url.pathname.startsWith('/api/')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><html lang="ko"><body><div id="root"></div><script src="/bundle.js"></script></body></html>'); return;
      }
      if (url.pathname === '/api/me') {
        const project = call.project ?? (/pai-project=([^;]+)/.exec(req.headers.cookie ?? '')?.[1] || 'a');
        return json({ user: authenticatedUser, subject: authenticatedUser, role, features: {}, accountId: '123456789012',
          project: { id: project, name: `Project ${project.toUpperCase()}`, role },
          sessionToken: 'MUST_NOT_PERSIST_SESSION' });
      }
      if (url.pathname === '/api/pipelines') return json({
        pipeline: { PipelineName: 'groot', PipelineArn: pipelineArn, PipelineStatus: 'Active',
          CreationTime: '2026-09-18T00:00:00Z', LastModifiedTime: '2026-09-18T01:00:00Z',
          ...(metadata ? { RoleArn: 'arn:aws:iam::123456789012:role/pipeline-role', PipelineVersionDisplayName: 'definition-v7' } : {}),
          parameters, projectTrackingSupported: true },
        executions: [{ PipelineExecutionArn: executionArn, PipelineExecutionDisplayName: 'run1',
          PipelineExecutionStatus: executionStatus, StartTime: '2026-09-18T00:00:00Z' }],
      });
      if (url.pathname === '/api/pipelines/executions' && req.method === 'POST') {
        if (serviceDeps) {
          try {
            const result = await startProjectPipeline(
              { user: authenticatedUser, subject: authenticatedUser, role, email: '' },
              { id: call.project!, name: 'Project A', namespace: 'hyperpod-ns-a', queue: 'default', credentialRefs: [],
                members: { alice: 'researcher', bob: 'researcher' }, createdAt: '', updatedAt: '' },
              body, call.key, serviceDeps,
            );
            // Drop the HTTP receipt after the real service has persisted acceptance.
            return responseMode === 'lost' ? json({ error: 'reply interrupted' }, 503) : json(result, 202);
          } catch (failure) {
            return json({ error: (failure as Error).message,
              ...(failure instanceof HttpError ? { code: failure.code, details: failure.details } : {}),
            }, failure instanceof HttpError ? failure.status : 503);
          }
        }
        if (responseMode === 'pending') { await new Promise<void>(resolve => { release = resolve; }); }
        if (responseMode === 'lost') return json({ error: 'reply interrupted' }, 503);
        if (responseMode === 'rejected') return json({ error: 'parameter rejected before intent',
          code: 'pipeline_not_submitted', details: { submissionState: 'not_submitted', requestId: call.key, projectId: call.project, ownerSubject: user } }, 400);
        if (responseMode === 'unmarked-400') return json({ error: 'unclassified 400', code: 'bad_request' }, 400);
        if (responseMode === 'forbidden') return json({ error: 'access denied', code: 'forbidden' }, 403);
        if (responseMode === 'conflict') return json({ error: 'conflicting request', code: 'error' }, 409);
        if (responseMode === 'missing-arn') return json({}, 202);
        return json({ arn: executionArn }, 202);
      }
      if (url.pathname === executionPath && req.method === 'DELETE') return json({ accepted: true }, 202);
      if (url.pathname === executionPath) return json({
        canStop: true, canArchive: executionStatus === 'Succeeded', projectRecorded: true,
        execution: { PipelineExecutionArn: executionArn, PipelineArn: pipelineArn,
          PipelineExecutionDisplayName: 'run1', PipelineExecutionStatus: executionStatus,
          CreationTime: '2026-09-18T00:00:00Z', LastModifiedTime: '2026-09-18T01:00:00Z',
          ...(metadata ? { PipelineVersionId: 7 } : {}) },
        steps: [
          { StepName: 'SmokeEval', StepStatus: 'Succeeded',
            Metadata: { TrainingJob: { Arn: 'arn:aws:sagemaker:us-east-1:123456789012:training-job/smoke-job' } } },
          { StepName: 'GR00TFinetune', StepStatus: fineTuneStarted ? 'Succeeded' : 'Starting',
            ...(fineTuneStarted ? { Metadata: { TrainingJob: { Arn: 'arn:aws:sagemaker:us-east-1:123456789012:training-job/finetune-job' } } } : {}) },
        ],
        parameters: [{ Name: 'NumGpus', Value: '0' }],
      });
      if (url.pathname.startsWith('/api/pipelines/training-jobs/')) {
        const fineTune = url.pathname.endsWith('/finetune-job');
        return json({ job: { TrainingJobStatus: 'Completed',
          ResourceConfig: { InstanceType: fineTune ? 'ml.g5.2xlarge' : 'ml.m5.xlarge', InstanceCount: 1 } },
          logs: [{ ts: 1, message: fineTune ? 'FINETUNE LOG' : 'SMOKE LOG' }] });
      }
      if (url.pathname === `${executionPath}/archives`) return req.method === 'POST' ? json({ id: 'archive' }, 202) : json([]);
      return json({ error: `unhandled fixture ${req.method} ${url.pathname}` }, 404);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // Missing Chromium fails setup: these regressions must actually run in a browser.
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  }, 30000);
  beforeEach(async () => {
    calls = []; errors = []; parameters = structuredClone(defaults); responseMode = 'success'; release = undefined;
    user = 'alice'; role = 'researcher'; serviceDeps = undefined;
    executionStatus = 'Executing'; metadata = true; fineTuneStarted = true;
    page = await (await browser.newContext()).newPage(); page.setDefaultTimeout(3000);
    page.on('pageerror', error => errors.push(error.message));
    await page.context().route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
  });
  afterEach(async () => { release?.(); await page.context().close(); expect(errors).toEqual([]); });
  afterAll(async () => { await browser?.close(); if (server) await new Promise<void>(resolve => server.close(() => resolve())); });

  const dialog = () => page.getByRole('dialog');
  const parameter = (name: string) => dialog().getByText(name, { exact: true }).locator('..').locator('input');
  const submit = () => dialog().getByRole('button', { name: /^(실행|동일 요청 재시도)$/ });
  const starts = () => calls.filter(call => call.path === '/api/pipelines/executions' && call.method === 'POST');
  const open = async () => { await page.getByRole('button', { name: '실행 시작', exact: true }).click(); };
  const refresh = async () => page.evaluate(async () => {
    await (window as unknown as { fixtureClient: { invalidateQueries(input: unknown): Promise<void> } })
      .fixtureClient.invalidateQueries({ queryKey: ['api'] });
  });
  const accepted = async () => page.waitForFunction(() => Boolean((window as unknown as { fixtureDestination?: string }).fixtureDestination));

  it.each(['researcher', 'viewer'] as const)('shows pipeline submission only for an authorized researcher after client restoration (%s)', async selectedRole => {
    role = selectedRole;
    await page.goto(origin + '/pipelines');
    await page.getByText('run1', { exact: true }).waitFor();
    expect(await page.getByRole('button', { name: '실행 시작', exact: true }).count()).toBe(selectedRole === 'researcher' ? 1 : 0);
    if (selectedRole === 'researcher') {
      await open();
      expect(await submit().isEnabled()).toBe(true);
    }
    expect(starts()).toHaveLength(0);
  });

  it('submits every displayed default including numeric zero', async () => {
    await page.goto(origin + '/pipelines'); await open();
    expect(await parameter('NumGpus').inputValue()).toBe('0');
    await submit().click(); await accepted();
    expect(starts()[0].body).toEqual({ parameters: expectedDefaults, expectedPipelineArn: pipelineArn, expectedOwnerSubject: 'alice' });
    expect(starts()[0].project).toBe('a');
  });

  it('Quick merges supported presets while preserving the chosen dataset and instance', async () => {
    await page.goto(origin + '/pipelines'); await open();
    await parameter('HfDatasetId').fill('org/chosen');
    await parameter('InstanceType').fill('ml.g6.2xlarge');
    await dialog().getByRole('button', { name: 'Quick 검증 설정' }).click();
    expect(await parameter('HfDatasetId').inputValue()).toBe('org/chosen');
    expect(await parameter('InstanceType').inputValue()).toBe('ml.g6.2xlarge');
    await submit().click(); await accepted();
    expect(starts()[0].body.parameters).toEqual({
      ...expectedDefaults, HfDatasetId: 'org/chosen', InstanceType: 'ml.g6.2xlarge',
      MaxSteps: '100', GlobalBatchSize: '4', SaveSteps: '50',
    });
  });

  it('keeps a cleared number blank and blocks blank/fractional input while permitting zero', async () => {
    await page.goto(origin + '/pipelines'); await open();
    await parameter('MaxSteps').fill('');
    expect(await parameter('MaxSteps').inputValue()).toBe('');
    expect(await submit().isDisabled()).toBe(true);
    await parameter('MaxSteps').fill('1.5');
    expect(await submit().isDisabled()).toBe(true);
    await parameter('MaxSteps').fill('0');
    expect(await submit().isEnabled()).toBe(true);
    await submit().click(); await accepted();
    expect(starts()[0].body.parameters).toMatchObject({ MaxSteps: '0', NumGpus: '0' });
  });

  it.each(['lost', 'missing-arn'] as const)('locks an uncertain %s response across close/reopen and retries the same operation', async mode => {
    responseMode = mode;
    await page.goto(origin + '/pipelines'); await open();
    await parameter('HfDatasetId').fill('org/retry');
    await dialog().getByLabel('실행 이름', { exact: true }).fill('retry-run');
    await submit().click();
    await page.getByText(mode === 'lost' ? 'reply interrupted' : '실행 ARN을 받지 못했습니다.', { exact: false }).waitFor();
    await dialog().getByRole('button', { name: '닫기', exact: true }).click(); await open();
    expect(await parameter('HfDatasetId').isDisabled()).toBe(true);
    expect(await dialog().getByLabel('실행 이름', { exact: true }).isDisabled()).toBe(true);
    expect(await dialog().getByRole('button', { name: 'Quick 검증 설정' }).isDisabled()).toBe(true);
    responseMode = 'success'; await submit().click(); await accepted();
    expect(starts()).toHaveLength(2);
    expect(starts()[1]).toEqual(starts()[0]);
    expect(starts()[0].key).toBeTruthy();
  });

  it('allows corrections and a new key only after an authoritative not-submitted receipt', async () => {
    responseMode = 'rejected';
    await page.goto(origin + '/pipelines'); await open(); await submit().click();
    await page.getByText('parameter rejected before intent', { exact: false }).waitFor();
    expect(await parameter('HfDatasetId').isEnabled()).toBe(true);
    expect(await dialog().getByRole('button', { name: 'Quick 검증 설정' }).isEnabled()).toBe(true);
    await page.reload(); await open();
    expect(await parameter('HfDatasetId').isEnabled()).toBe(true);
    await parameter('HfDatasetId').fill('org/corrected');
    responseMode = 'success'; await submit().click(); await accepted();
    expect(starts()[1].body.parameters).toMatchObject({ HfDatasetId: 'org/corrected' });
    expect(starts()[1].key).not.toBe(starts()[0].key);
  });

  it.each(['unmarked-400', 'forbidden', 'conflict'] as const)('retains an uncertain intent after a retry returns %s', async mode => {
    responseMode = 'lost';
    await page.goto(origin + '/pipelines'); await open(); await submit().click();
    await page.getByText('reply interrupted', { exact: false }).waitFor();
    responseMode = mode; await submit().click();
    await page.getByText(mode === 'unmarked-400' ? 'unclassified 400' : mode === 'forbidden' ? 'access denied' : 'conflicting request', { exact: false }).waitFor();
    expect(await parameter('HfDatasetId').isDisabled()).toBe(true);
    expect(await page.getByRole('button', { name: '미제출 초안 버리기', exact: true }).count()).toBe(0);
    await page.reload(); await open(); responseMode = 'success'; await submit().click(); await accepted();
    expect(starts()[1]).toEqual(starts()[0]);
    expect(starts()[2]).toEqual(starts()[0]);
  });

  it('discards an unattempted draft so another project and account can start their own draft', async () => {
    await page.goto(origin + '/pipelines'); await open();
    await parameter('HfDatasetId').fill('org/alice');
    user = 'bob'; await page.evaluate(() => { document.cookie = 'pai-project=b; Path=/'; });
    await page.reload();
    await page.getByRole('button', { name: '미제출 초안 버리기', exact: true }).click();
    await open();
    expect(await parameter('HfDatasetId').inputValue()).toBe('org/default');
    expect(await parameter('HfDatasetId').isEnabled()).toBe(true);
    expect(await page.getByText(/Project B/).count()).toBeGreaterThan(0);
    await submit().click(); await accepted();
    expect(starts()).toHaveLength(1);
    expect(starts()[0].project).toBe('b');
  });

  it('restores project, exact payload and key after reload despite changed cookie and definition defaults', async () => {
    responseMode = 'lost';
    await page.goto(origin + '/pipelines'); await open();
    await parameter('InstanceType').fill('ml.g6.2xlarge');
    await submit().click(); await page.getByText('reply interrupted', { exact: false }).waitFor();
    await page.evaluate(() => { document.cookie = 'pai-project=b; Path=/'; });
    parameters[2].DefaultValue = 9000;
    await page.reload(); await open();
    expect(await parameter('InstanceType').inputValue()).toBe('ml.g6.2xlarge');
    expect(await parameter('MaxSteps').inputValue()).toBe('1000');
    expect(await page.getByText(/Project A/).count()).toBeGreaterThan(0);
    responseMode = 'success'; await submit().click(); await accepted();
    expect(starts()[1]).toEqual(starts()[0]);
    expect(calls.filter(call => call.path === '/api/pipelines').every(call => call.project === 'a')).toBe(true);
    const destination = await page.evaluate(() => (window as unknown as { fixtureDestination: string }).fixtureDestination);
    expect(new URL(destination, origin).searchParams.get('project')).toBe('a');
  });

  it('persists before sending so reload during a pending POST can safely retry', async () => {
    responseMode = 'pending';
    await page.goto(origin + '/pipelines'); await open(); await submit().click();
    await expect.poll(() => starts().length).toBe(1);
    await page.reload(); await open();
    responseMode = 'success'; release?.();
    await submit().click(); await accepted();
    expect(starts()).toHaveLength(2);
    expect(starts()[1]).toEqual(starts()[0]);
  });

  it('clears the confirmed request and starts a fresh editable draft with a new key', async () => {
    await page.goto(origin + '/pipelines'); await open();
    await parameter('HfDatasetId').fill('org/first');
    await submit().click(); await accepted();
    expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
    await page.reload(); await open();
    expect(await parameter('HfDatasetId').inputValue()).toBe('org/default');
    expect(await parameter('HfDatasetId').isEnabled()).toBe(true);
    await parameter('HfDatasetId').fill('org/second'); await submit().click(); await accepted();
    expect(starts()[1].key).not.toBe(starts()[0].key);
  });

  it('does not let a late success from an unmounted page erase a newer unresolved request', async () => {
    responseMode = 'pending';
    await page.goto(origin + '/pipelines'); await open(); await submit().click();
    await expect.poll(() => starts().length).toBe(1);
    const firstReply = release!;
    await page.evaluate(() => (window as unknown as { fixtureRemount(): void }).fixtureRemount());
    await expect.poll(() => dialog().count()).toBe(0);
    await open(); responseMode = 'success'; await submit().click(); await accepted();
    expect(starts()[1]).toEqual(starts()[0]);
    await open(); await parameter('HfDatasetId').fill('org/newer');
    responseMode = 'lost'; await submit().click();
    await page.getByText('reply interrupted', { exact: false }).waitFor();
    const saved = await page.evaluate(() => JSON.stringify(sessionStorage));
    const lateResponse = page.waitForResponse(response => response.url().endsWith('/api/pipelines/executions'));
    responseMode = 'success'; firstReply();
    await (await lateResponse).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    expect(await page.evaluate(() => JSON.stringify(sessionStorage))).toBe(saved);
    await page.reload(); await open(); await submit().click(); await accepted();
    expect(starts()[3]).toEqual(starts()[2]);
    expect(starts()[3].key).not.toBe(starts()[0].key);
  });

  it('stores only the nonsecret draft in this tab and preserves an unsubmitted edit', async () => {
    await page.goto(origin + '/pipelines'); await open();
    await parameter('HfDatasetId').fill('org/edit');
    const stored = await page.evaluate(() => ({ session: JSON.stringify(sessionStorage), local: JSON.stringify(localStorage) }));
    expect(stored.session).toContain('org/edit');
    expect(stored.session).not.toContain('MUST_NOT_PERSIST_SESSION');
    expect(stored.local).toBe('{}');
    await page.reload(); await open();
    expect(await parameter('HfDatasetId').inputValue()).toBe('org/edit');
    const other = await page.context().newPage();
    try {
      await other.goto(origin + '/pipelines');
      await other.getByRole('button', { name: '실행 시작', exact: true }).click();
      expect(await other.getByRole('dialog').getByText('HfDatasetId', { exact: true }).locator('..').locator('input').inputValue()).toBe('org/default');
    } finally { await other.close(); }
  });

  it('does not POST when tab storage cannot durably record the request identity', async () => {
    await page.goto(origin + '/pipelines'); await open();
    await page.evaluate(() => { Storage.prototype.setItem = () => { throw new Error('storage unavailable'); }; });
    await submit().click();
    await page.getByText('이 탭에 실행 요청을 저장하지 못했습니다.', { exact: false }).waitFor();
    expect(starts()).toHaveLength(0);
    expect(await dialog().count()).toBe(1);
  });

  it('does not persist or submit a newly introduced secret parameter', async () => {
    parameters.push({ Name: 'HFToken', Type: 'String', DefaultValue: 'MUST_NOT_PERSIST_SECRET' });
    await page.goto(origin + '/pipelines'); await open();
    expect(await submit().isDisabled()).toBe(true);
    expect(await page.evaluate(() => JSON.stringify(sessionStorage))).not.toContain('MUST_NOT_PERSIST_SECRET');
    expect(await page.content()).not.toContain('MUST_NOT_PERSIST_SECRET');
    expect(starts()).toHaveLength(0);
  });

  it('does not silently retry an unresolved operation as a different signed-in user', async () => {
    responseMode = 'lost';
    await page.goto(origin + '/pipelines'); await open(); await submit().click();
    await page.getByText('reply interrupted', { exact: false }).waitFor();
    user = 'bob';
    await page.reload(); await open();
    expect(await submit().isDisabled()).toBe(true);
    expect(starts()).toHaveLength(1);
  });

  it('rejects a cached Alice retry after Bob signs in in another tab and preserves the frozen request for Alice', async () => {
    const kv = new MemoryKV();
    const startExecution = vi.fn().mockResolvedValue(executionArn);
    serviceDeps = { kv, aws: {
      pipelineName: () => 'groot',
      describePipeline: vi.fn().mockResolvedValue({ PipelineArn: pipelineArn, parameters: defaults }),
      startExecution,
      describeExecution: vi.fn(), stopExecution: vi.fn(),
    } };
    responseMode = 'lost';
    await page.goto(origin + '/pipelines'); await open();
    await parameter('HfDatasetId').fill('org/frozen-alice');
    await dialog().getByLabel('실행 이름', { exact: true }).fill('alice-request');
    await submit().click();
    await page.getByText('reply interrupted', { exact: false }).waitFor();
    const frozen = await page.evaluate(() => sessionStorage.getItem('pai:pipeline-execution-draft:v1'));
    expect(startExecution).toHaveBeenCalledTimes(1);
    const originalIntent = structuredClone(await kv.query('PROJECT#a', 'PIPELINE#'));
    const other = await page.context().newPage();
    try {
      await other.goto(origin + '/pipelines');
      await other.evaluate(() => { document.cookie = 'fixture-user=bob; Path=/'; });
      // No reload or /api/me refresh in Alice's page: its cached identity still permits retry.
      expect(await submit().isEnabled()).toBe(true);
      responseMode = 'success';
      const response = page.waitForResponse(reply => reply.url().endsWith('/api/pipelines/executions'));
      await submit().click();
      const denied = await response, failure = await denied.json();
      expect(denied.status()).toBe(403);
      expect(failure.code).toBe('pipeline_owner_changed');
      expect(failure).not.toHaveProperty('details.submissionState');
      await page.getByText(failure.error, { exact: false }).waitFor();
      expect(starts()[1]).toEqual(starts()[0]);
      expect(starts()[1].body.expectedOwnerSubject).toBe('alice');
      expect(await page.evaluate(() => sessionStorage.getItem('pai:pipeline-execution-draft:v1'))).toBe(frozen);
      expect(await parameter('HfDatasetId').isDisabled()).toBe(true);
      expect(await dialog().getByRole('button', { name: 'Quick 검증 설정' }).isDisabled()).toBe(true);
      expect(await page.getByRole('button', { name: '미제출 초안 버리기', exact: true }).count()).toBe(0);
      expect(await kv.query('PROJECT#a', 'PIPELINE#')).toEqual(originalIntent);
      expect(startExecution).toHaveBeenCalledTimes(1);

      await page.reload(); await open();
      expect(await submit().isDisabled()).toBe(true);
      expect(await page.evaluate(() => sessionStorage.getItem('pai:pipeline-execution-draft:v1'))).toBe(frozen);
      await other.evaluate(() => { document.cookie = 'fixture-user=alice; Path=/'; });
      await page.reload(); await open(); await submit().click(); await accepted();
      expect(starts()).toHaveLength(3);
      expect(starts()[2]).toEqual(starts()[0]);
      expect(startExecution).toHaveBeenCalledTimes(1);
      expect(await kv.get(`PIPELINE_EXECUTION#${executionArn}`, 'META')).toMatchObject({ ownerSubject: 'alice' });
    } finally { await other.close(); }
  });

  it('keeps a corrupt saved request for recovery instead of silently making a fresh operation', async () => {
    responseMode = 'lost';
    await page.goto(origin + '/pipelines'); await open(); await submit().click();
    await page.getByText('reply interrupted', { exact: false }).waitFor();
    await page.evaluate(() => { sessionStorage.setItem('pai:pipeline-execution-draft:v1', '{broken'); });
    await page.reload();
    await page.getByText('저장된 실행 요청을 복원하지 못했습니다.', { exact: false }).waitFor();
    expect(await page.getByRole('button', { name: '실행 시작', exact: true }).isDisabled()).toBe(true);
    expect(await page.evaluate(() => sessionStorage.getItem('pai:pipeline-execution-draft:v1'))).toBe('{broken');
    expect(starts()).toHaveLength(1);
  });

  it('binds list refresh and navigation to the displayed project after cookie drift', async () => {
    await page.goto(origin + '/pipelines');
    await page.getByText('run1', { exact: true }).waitFor();
    await page.evaluate(() => { document.cookie = 'pai-project=b; Path=/'; });
    await page.evaluate(async () => {
      await (window as unknown as { fixtureClient: { invalidateQueries(input: unknown): Promise<void> } })
        .fixtureClient.invalidateQueries({ queryKey: ['api', '/api/pipelines'] });
    });
    expect(calls.filter(call => call.path === '/api/pipelines').every(call => call.project === 'a')).toBe(true);
    await page.getByText('run1', { exact: true }).click(); await accepted();
    expect(new URL(await page.evaluate(() => (window as unknown as { fixtureDestination: string }).fixtureDestination), origin).searchParams.get('project')).toBe('a');
  });

  it('selects fine-tuning by name even when SmokeEval is first, and lets the user select smoke', async () => {
    await page.goto(origin + '/detail?project=a');
    await page.getByText('FINETUNE LOG', { exact: false }).waitFor();
    expect(calls.filter(call => call.path.startsWith('/api/pipelines/training-jobs/')).map(call => call.path))
      .toEqual(['/api/pipelines/training-jobs/finetune-job']);
    await page.getByLabel('Training Job 단계', { exact: true }).selectOption('SmokeEval');
    await page.getByText('SMOKE LOG', { exact: false }).waitFor();
    expect(await page.getByText('ml.m5.xlarge', { exact: true }).count()).toBe(1);
    await refresh();
    expect(await page.getByLabel('Training Job 단계', { exact: true }).inputValue()).toBe('SmokeEval');
    await page.getByLabel('Training Job 단계', { exact: true }).selectOption('GR00TFinetune');
    await page.getByText('FINETUNE LOG', { exact: false }).waitFor();
  });

  it('does not silently substitute smoke details while the fine-tune job has not started', async () => {
    fineTuneStarted = false;
    await page.goto(origin + '/detail?project=a');
    await page.getByText('run1', { exact: true }).waitFor();
    expect(calls.some(call => call.path.startsWith('/api/pipelines/training-jobs/'))).toBe(false);
    await page.getByLabel('Training Job 단계', { exact: true }).selectOption('SmokeEval');
    await page.getByText('SMOKE LOG', { exact: false }).waitFor();
  });

  it('uses the displayed project for detail, job, archive and stop requests despite a different cookie', async () => {
    await page.context().addCookies([{ name: 'pai-project', value: 'b', url: origin }]);
    await page.goto(origin + '/detail?project=a');
    await page.getByText('FINETUNE LOG', { exact: false }).waitFor();
    page.on('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: '실행 중단', exact: true }).click();
    await page.getByRole('button', { name: '중단 요청 접수됨' }).waitFor();
    executionStatus = 'Succeeded'; await refresh();
    await page.getByRole('button', { name: '완료 출력 검증·보관' }).click();
    await expect.poll(() => calls.filter(call => call.path === `${executionPath}/archives` && call.method === 'POST').length).toBe(1);
    expect(calls.filter(call => call.path.startsWith('/api/pipelines/')).every(call => call.project === 'a')).toBe(true);
    expect(calls.find(call => call.path === `${executionPath}/archives` && call.method === 'POST')?.body)
      .toEqual({ trainingStep: 'GR00TFinetune', reportSteps: [] });
  });

  it('shows returned managed identity and version without substituting the current definition for the execution', async () => {
    await page.goto(origin + '/pipelines');
    await page.getByRole('button', { name: '기술 정보' }).click();
    await page.getByText('arn:aws:iam::123456789012:role/pipeline-role', { exact: true }).waitFor();
    expect(await page.getByText('definition-v7', { exact: true }).count()).toBe(1);
    await page.goto(origin + '/detail?project=a');
    await page.getByRole('button', { name: '기술 정보' }).click();
    await page.getByText(executionArn, { exact: true }).waitFor();
    expect(await page.getByText(/SageMaker.*관리형/).count()).toBeGreaterThan(0);
    expect(await page.getByText('실행 정의 버전: 7', { exact: true }).count()).toBe(1);
    metadata = false; await page.reload();
    await page.getByText('run1', { exact: true }).waitFor();
    expect(await page.getByText('실행 정의 버전: 7', { exact: true }).count()).toBe(0);
  });
});
