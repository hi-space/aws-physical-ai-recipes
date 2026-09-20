/** Browser and service exercise only loopback API fixtures and fake webhook transport. */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { build } from 'esbuild';
import { Repo } from '@/server/store/repo';
import { MemoryKV } from '@/server/store/dynamo';
import type { Project } from '@/server/auth/projects';
import { projectItem } from '@/server/auth/projects';
import { projectFixture } from '@/server/auth/session.test-helpers';
import type { Workflow } from '@/server/store/types';
import { workflowSchema } from '@/server/workflow/schema';
import { webhooksService, enqueueWorkflowWebhook, reconcileWebhookDeliveries, type WebhookDeps, type WebhookSecret } from '@/server/services/webhooks';

let server: Server, browser: Browser, origin: string, d: WebhookDeps;
const project: Project = projectFixture('a', { name: 'Webhook fixture' });
const principal = { user: 'admin', subject: 'sub', role: 'researcher' as const, email: '', groups: ['researchers', 'proj-a-admin'] };
beforeAll(async () => {
  if (!existsSync(chromium.executablePath())) return;
  const repo = new Repo(new MemoryKV()), secrets = new Map<string, WebhookSecret[]>();
  let seq = 0;
  await repo.kv.put(projectItem(project));
  d = { repo, now: Date.now, randomId: () => (++seq).toString(16).padStart(32, '0'), maxAttempts: 1,
    secrets: {
      put: async (ref, value) => { const values = secrets.get(ref) ?? []; values.push(value); secrets.set(ref, values); return values.length; },
      get: async (ref, version) => { const values = secrets.get(ref)!; return { version: version ?? values.length, value: values[(version ?? values.length) - 1] }; },
    },
    resolve: async () => ({ hostname: 'hooks.example.com', address: '93.184.216.34', family: 4, path: '/private' }),
    post: async () => 503,
  };
  const bundle = await build({ stdin: { contents: `import React from'react';import{createRoot}from'react-dom/client';import{QueryClient,QueryClientProvider}from'@tanstack/react-query';import{WebhooksPage}from'./src/components/pages/WebhooksPage';const client=new QueryClient({defaultOptions:{queries:{retry:false}}});window.fixtureClient=client;createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider,{client},React.createElement(WebhooksPage)));`,
    resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, platform: 'browser', format: 'iife',
    define: { 'process.env.NODE_ENV': '"test"' }, plugins: [{ name: 'local-next-link', setup(builder) {
      builder.onResolve({ filter: /^next\/link$/ }, args => ({ path: args.path, namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ loader: 'jsx', resolveDir: process.cwd(),
        contents: `import React from'react';export default function Link({href,children,...props}){return <a href={href} {...props}>{children}</a>}` }));
    } }] });
  server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://fixture');
    if (url.pathname === '/bundle.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(bundle.outputFiles[0].text); return; }
    if (!url.pathname.startsWith('/api/')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<!doctype html><html lang="ko"><meta charset="utf-8"><body><div id="root"></div><script src="/bundle.js"></script></body></html>'); return; }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const service = webhooksService(principal, d);
    const json = (value: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    try {
      if (url.pathname === '/api/webhooks') return json(req.method === 'POST' ? await service.create(body, project) : { project, hooks: await service.list(project), canManage: true });
      const parts = url.pathname.split('/').filter(Boolean), id = parts[2];
      if (parts[3] === 'deliveries' && parts[5] === 'redrive') return json(await service.redrive(id, parts[4], project));
      if (parts[3] === 'deliveries') return json(await service.deliveries(id, project));
      if (parts[3] === 'rotate') return json(await service.rotate(id, body, project));
      if (req.method === 'PATCH') return json(await service.update(id, body, project));
      return json({ error: 'missing fixture' }, 404);
    } catch (error) { return json({ error: (error as Error).message }, (error as { status?: number }).status ?? 500); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
}, 30000);
afterAll(async () => { await browser?.close(); if (server) await new Promise<void>(resolve => server.close(() => resolve())); });

it.skipIf(!existsSync(chromium.executablePath()))('registers without echoing secrets, displays dead letters, explicitly redrives, and rotates safely', async () => {
  const page = await browser.newPage(), errors: string[] = [];
  page.setDefaultTimeout(4000);
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
  const refresh = () => page.evaluate(() => (window as unknown as { fixtureClient: { invalidateQueries(options: unknown): Promise<void> } }).fixtureClient.invalidateQueries({ queryKey: ['api'] }));
  try {
    await page.goto(origin + '/webhooks');
    await page.locator('input').nth(0).fill('Receiver fixture');
    await page.locator('input[type=url]').first().fill('https://hooks.example.com/secret-path?key=private');
    await page.locator('input[type=password]').first().fill('secret-fixture-'.repeat(4));
    await page.getByRole('button', { name: '구독 등록', exact: true }).click();
    await page.getByText('웹훅을 등록했습니다.', { exact: false }).waitFor();
    expect(await page.locator('input[type=password]').first().inputValue()).toBe('');
    expect(await page.locator('input[type=url]').first().inputValue()).toBe('');
    const workflow: Workflow = { id: 'run-a', projectId: 'a', namespace: project.namespace, owner: 'owner', name: 'Training',
      status: 'SUCCEEDED', spec: workflowSchema.parse({ workflow: { name: 'training', tasks: [{ name: 'run', image: 'image', command: ['true'] }] } }),
      specYaml: '', vars: {}, taskCount: 1, succeededCount: 1, failedCount: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await d.repo.putWorkflow(workflow);
    await enqueueWorkflowWebhook(workflow, d);
    await reconcileWebhookDeliveries(new AbortController().signal, d);
    await refresh(); await page.getByText('DEAD', { exact: true }).waitFor();
    d.post = async () => 204;
    await page.getByRole('button', { name: '현재 설정으로 재전달 예약' }).click();
    await page.getByText('현재 설정으로 재전달을 예약했습니다.', { exact: false }).waitFor();
    await reconcileWebhookDeliveries(new AbortController().signal, d);
    await refresh(); await page.getByText('DELIVERED', { exact: true }).waitFor();
    await page.locator('input[type=password]').nth(1).fill('replacement-fixture-'.repeat(3));
    await page.getByRole('button', { name: '암호화 설정 교체' }).click();
    await page.getByText('설정을 교체했습니다.', { exact: false }).waitFor();
    expect(await page.locator('input[type=password]').nth(1).inputValue()).toBe('');
    expect(await page.content()).not.toContain('secret-path');
    expect(await page.content()).not.toContain('replacement-fixture-');
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);
