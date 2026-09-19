/** Isolated browser fixture: real UI/API helper, local responses, no cloud or deployment access. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { build } from 'esbuild';

interface Row {
  id: string; kind: string; projectId: string; workflowId?: string; taskName?: string; attempt?: number;
  status: string; canOpen: boolean; expiresAt: string;
}
const outputPath = '/fsx/checkpoints/projects/team-a/runs/run-a/attempts/2/train';

describe.skipIf(!existsSync(chromium.executablePath()))('task connections browser flow', () => {
  let server: Server, browser: Browser, context: BrowserContext, page: Page, origin: string;
  let status: 'RUNNING' | 'SUCCEEDED', phase: 'RUNNING' | 'SUCCEEDED', role: string, subject: string, ports: string[];
  let gatewayMode: 'host' | 'path';
  let rows: Row[], calls: Array<{ path: string; method: string; project?: string; body: Record<string, unknown> }>;
  let rejectCreate: boolean, rejectLaunch: boolean, errors: string[], launched: string[];
  let hiddenSessionReads: number;
  beforeAll(async () => {
    const bundle = await build({ stdin: { contents: `
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
      import {useApi} from './src/lib/api-client'; import {TaskConnections} from './src/components/workflows/TaskConnections';
      const client = new QueryClient({defaultOptions:{queries:{retry:false}}}); window.fixtureClient = client;
      function Fixture(){ const data=useApi('/fixture'); const [selected,setSelected]=React.useState();
        return data.data ? <TaskConnections workflow={data.data.workflow} tasks={data.data.tasks} selectedTask={selected} onSelectTask={setSelected}/> : <p>Loading fixture</p>; }
      createRoot(document.getElementById('root')).render(<QueryClientProvider client={client}><Fixture/></QueryClientProvider>);`,
      resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, platform: 'browser', format: 'iife',
      define: { 'process.env.NODE_ENV': '"test"' }, plugins: [{ name: 'fixture-link', setup(builder) {
        builder.onResolve({ filter: /^next\/link$/ }, args => ({ path: args.path, namespace: 'fixture-link' }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture-link' }, () => ({ loader: 'jsx', resolveDir: process.cwd(),
          contents: `import React from 'react'; export default function Link({href,children,prefetch,...props}) { return <a href={href} {...props}>{children}</a>; }` }));
      } }] });
    server = createServer(async (req, res) => {
      const url = new URL(req.url!, 'http://fixture');
      const json = (data: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (url.pathname === '/bundle.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(bundle.outputFiles[0].text); return; }
      if (url.pathname === '/fixture') return json({ workflow: { id: 'run-a', projectId: 'team-a', ownerSubject: 'owner-sub', status }, tasks: [
        { workflowId: 'run-a', name: 'train', phase, attempts: 2, outputPath },
      ] });
      if (!url.pathname.startsWith('/api/')) { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><html lang="ko"><body><div id="root"></div><script src="/bundle.js"></script></body></html>'); return; }
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      calls.push({ path: url.pathname, method: req.method!, project: req.headers['x-pai-project'] as string | undefined, body });
      if (url.pathname === '/api/me') return json({ user: 'alice', subject, role, project: { id: 'team-a', role: 'researcher' },
        gateway: gatewayMode === 'path' ? { mode: 'path', origin: 'http://alb.example.com:8080' } : { mode: 'host' } });
      if (url.pathname === '/api/sessions/connect') return json({ replicas: [{ replicaIndex: 0, ports }] });
      if (url.pathname === '/api/sessions' && req.method === 'POST') {
        if (rejectCreate) return json({ error: '프로젝트 권한을 확인하세요.' }, 403);
        if (body.kind !== 'tensorboard' && (status !== 'RUNNING' || phase !== 'RUNNING')) return json({ error: '작업이 종료되었습니다.' }, 409);
        const row: Row = { id: `created-${rows.length + 1}`, kind: body.kind, projectId: 'team-a',
          status: body.kind === 'tensorboard' ? 'QUEUED' : 'READY', canOpen: body.kind !== 'tensorboard', expiresAt: new Date(Date.now() + 60_000).toISOString(),
          ...(body.kind !== 'tensorboard' ? { workflowId: body.workflowId, taskName: body.taskName, attempt: 2 } : {}) };
        rows.push(row); return json(row, 202);
      }
      if (url.pathname === '/api/sessions') {
        if (hiddenSessionReads > 0) { hiddenSessionReads--; return json([]); }
        return json(rows);
      }
      if (url.pathname.endsWith('/launch') && req.method === 'POST') {
        if (rejectLaunch) return json({ error: '접속 권한이 변경되었습니다.' }, 403);
        const id = url.pathname.split('/')[3];
        const count = calls.filter(call => call.path.endsWith('/launch')).length;
        return json({ url: gatewayMode === 'path' ? `http://alb.example.com:8080/s/${id}/?ticket=synthetic-${count}` : `https://${id}.apps.physical-ai.hi-yoo.com/?ticket=synthetic-${count}` });
      }
      return json({ error: 'Unknown fixture route' }, 404);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  }, 30_000);
  beforeEach(async () => {
    status = 'RUNNING'; phase = 'RUNNING'; role = 'researcher'; subject = 'owner-sub'; ports = ['pai-files']; gatewayMode = 'host';
    rows = []; calls = []; errors = []; launched = []; rejectCreate = false; rejectLaunch = false;
    hiddenSessionReads = 0;
    context = await browser.newContext();
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin === origin) return route.continue();
      if (url.hostname.endsWith('.apps.physical-ai.hi-yoo.com') || url.origin === 'http://alb.example.com:8080') {
        launched.push(url.toString());
        return route.fulfill({ contentType: 'text/html', body: '<h1>Isolated fixture session</h1>' });
      }
      return route.abort();
    });
    page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  });
  afterEach(async () => { await context.close(); expect(errors).toEqual([]); });
  afterAll(async () => { await browser?.close(); if (server) await new Promise<void>(resolve => server.close(() => resolve())); });
  const refresh = async (path: string) => page.evaluate((path) => (window as unknown as { fixtureClient: { invalidateQueries(opts: unknown): Promise<void> } }).fixtureClient.invalidateQueries({ queryKey: ['api', path] }), path);

  it('prepares finished results from outputPath, waits for READY, then requests a fresh launch each time', async () => {
    status = 'SUCCEEDED'; phase = 'SUCCEEDED'; await page.goto(origin);
    await page.getByRole('button', { name: 'TensorBoard 준비', exact: true }).click();
    await page.getByText('프로젝트 대기열에서 세션을 준비하고 있습니다.', { exact: false }).waitFor();
    const created = calls.find(call => call.path === '/api/sessions' && call.method === 'POST')!;
    expect(created.project).toBe('team-a');
    expect(created.body).toEqual({ kind: 'tensorboard', logDir: outputPath, ttlMinutes: 60 });
    expect(await page.getByRole('button', { name: 'TensorBoard 열기', exact: true }).isDisabled()).toBe(true);
    expect(await page.getByRole('button', { name: '터미널 준비', exact: true }).isDisabled()).toBe(true);
    expect(calls.some(call => call.path.endsWith('/launch'))).toBe(false);
    rows[0].status = 'READY'; rows[0].canOpen = true; await refresh('/api/sessions');
    for (let i = 0; i < 2; i++) {
      const popup = context.waitForEvent('page');
      await page.getByRole('button', { name: 'TensorBoard 열기', exact: true }).click();
      const tab = await popup; await tab.getByRole('heading', { name: 'Isolated fixture session' }).waitFor(); await tab.close();
    }
    expect(launched).toHaveLength(2); expect(launched[0]).not.toBe(launched[1]);
    expect(calls.filter(call => call.path.endsWith('/launch'))).toEqual([
      expect.objectContaining({ method: 'POST', project: 'team-a' }), expect.objectContaining({ method: 'POST', project: 'team-a' }),
    ]);
    expect(calls.filter(call => call.path === '/api/sessions' && call.method === 'POST')).toHaveLength(1);
  }, 15000);

  it('prefills a live terminal and removes its open action when the workflow finishes', async () => {
    await page.goto(origin);
    await page.getByRole('button', { name: '터미널 준비', exact: true }).click();
    await page.getByText('준비가 끝났습니다.', { exact: false }).waitFor();
    expect(calls.find(call => call.method === 'POST')?.body).toEqual({ kind: 'terminal', workflowId: 'run-a', taskName: 'train', replicaIndex: 0, ttlMinutes: 60 });
    status = 'SUCCEEDED'; phase = 'SUCCEEDED'; await refresh('/fixture');
    await page.getByText('작업이 종료되거나 재시작되어', { exact: false }).waitFor();
    expect(await page.getByRole('button', { name: '터미널 열기', exact: true }).isDisabled()).toBe(true);
    expect(calls.some(call => call.path.endsWith('/launch'))).toBe(false);
    await page.getByText('작업이 종료되거나 재시작되어', { exact: false }).waitFor();
  }, 10000);

  it('keeps checking when a newly created session is not visible in the first list response', async () => {
    status = 'SUCCEEDED'; phase = 'SUCCEEDED'; hiddenSessionReads = 1;
    await page.goto(origin);
    await page.getByRole('button', { name: 'TensorBoard 준비', exact: true }).click();
    await page.getByText('세션 등록 상태를 확인하고 있습니다.', { exact: true }).waitFor();
    rows[0].status = 'READY'; rows[0].canOpen = true;
    await page.getByText('준비가 끝났습니다.', { exact: false }).waitFor({ timeout: 6000 });
    expect(calls.filter(call => call.path === '/api/sessions' && call.method === 'GET').length).toBeGreaterThanOrEqual(2);
    expect(await page.getByRole('button', { name: 'TensorBoard 열기', exact: true }).isEnabled()).toBe(true);
  }, 10000);

  it('prefills the reserved file service and blocks opening an expired session', async () => {
    await page.goto(origin);
    await page.getByRole('button', { name: '작업 파일 준비', exact: true }).click();
    await page.getByText('준비가 끝났습니다.', { exact: false }).waitFor();
    expect(calls.find(call => call.method === 'POST')?.body).toEqual({ kind: 'port-forward', workflowId: 'run-a', taskName: 'train', replicaIndex: 0, portName: 'pai-files', ttlMinutes: 60 });
    rows[0].expiresAt = new Date(Date.now() - 2000).toISOString(); await refresh('/api/sessions');
    await page.getByText('세션이 만료되었습니다.', { exact: false }).waitFor();
    expect(await page.getByRole('button', { name: '작업 파일 열기', exact: true }).isDisabled()).toBe(true);
    expect(calls.some(call => call.path.endsWith('/launch'))).toBe(false);
  }, 10000);

  it('opens a path-mode gateway launch URL under the shared origin and session prefix', async () => {
    gatewayMode = 'path'; await page.goto(origin);
    await page.getByRole('button', { name: '터미널 준비', exact: true }).click();
    await page.getByText('준비가 끝났습니다.', { exact: false }).waitFor();
    const popup = context.waitForEvent('page');
    await page.getByRole('button', { name: '터미널 열기', exact: true }).click();
    const tab = await popup; await tab.getByRole('heading', { name: 'Isolated fixture session' }).waitFor(); await tab.close();
    expect(launched).toHaveLength(1);
    expect(launched[0]).toMatch(/^http:\/\/alb\.example\.com:8080\/s\/created-1\/\?ticket=/);
  }, 10000);

  it('surfaces create and launch authorization errors without showing a successful navigation', async () => {
    await page.goto(origin); rejectCreate = true;
    await page.getByRole('button', { name: '터미널 준비', exact: true }).click();
    await page.getByText('프로젝트 권한을 확인하세요.', { exact: true }).waitFor();
    expect(rows).toHaveLength(0);
    rejectCreate = false; await page.getByRole('button', { name: '터미널 준비', exact: true }).click();
    await page.getByText('준비가 끝났습니다.', { exact: false }).waitFor(); rejectLaunch = true;
    await page.getByRole('button', { name: '터미널 열기', exact: true }).click();
    await page.getByText('접속 권한이 변경되었습니다.', { exact: true }).waitFor();
    expect(launched).toEqual([]);
  }, 10000);
});
