/** Local browser + HTTP fixtures only. Never contacts AWS or a deployed dashboard. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { build } from 'esbuild';
import type { BackendRow } from './backend-ui';

const row = (id: string, ready: boolean): BackendRow => ({ id, version: ready ? 2 : 0, enabled: true, status: ready ? 'READY' : 'UNREADY',
  findings: ready ? [] : [{ code: 'unregistered', message: '관리자 등록이 필요합니다.' }], configVersion: 1,
  profile: { accountId: '123456789012', region: 'us-east-1', vpcId: 'vpc-test', namespaces: ['hyperpod-ns-shared', 'hyperpod-ns-free'],
    eks: { eksClusterName: `eks-${id}`, dataBucket: `data-${id}`, fsxFileSystemId: `fs-${id}` } },
});
type Project = { id: string; name: string; namespace: string; queue: string; backendId?: string; members: Record<string, string> };

describe.skipIf(!existsSync(chromium.executablePath()))('backend administration and project browser contracts', () => {
  let server: Server, browser: Browser, page: Page, origin: string;
  let admin: boolean, rows: BackendRow[], projects: Project[], probeReady: boolean, registryMissing: boolean, createError: boolean, conflict: boolean;
  let calls: Array<{ path: string; method: string; body: Record<string, unknown> }>, errors: string[];
  beforeAll(async () => {
    const bundle = await build({ stdin: { contents: `import React from 'react';import{createRoot}from'react-dom/client';import{QueryClient,QueryClientProvider}from'@tanstack/react-query';import{BackendsPage}from'./src/components/pages/BackendsPage';import{ProjectsPage}from'./src/components/pages/ProjectsPage';import{Sidebar}from'./src/components/layout/Sidebar';createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider,{client:new QueryClient({defaultOptions:{queries:{retry:false}}})},React.createElement(React.Fragment,null,React.createElement(Sidebar),React.createElement(location.pathname==='/projects'?ProjectsPage:BackendsPage))));`,
      resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, platform: 'browser', format: 'iife',
      define: { 'process.env.NODE_ENV': '"test"' }, plugins: [{ name: 'next-fixture', setup(builder) {
        builder.onResolve({ filter: /^next\/(navigation|link)$/ }, args => ({ path: args.path, namespace: 'fixture-next' }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture-next' }, args => ({ loader: 'jsx', resolveDir: process.cwd(), contents: args.path.endsWith('navigation')
          ? `export function usePathname(){return location.pathname}`
          : `import React from 'react';export default function Link({href,children,...props}){return <a href={href} {...props}>{children}</a>}` }));
      } }] });
    server = createServer(async (req, res) => {
      const url = new URL(req.url!, 'http://fixture');
      if (url.pathname === '/bundle.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(bundle.outputFiles[0].text); return; }
      if (!url.pathname.startsWith('/api/')) { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><html lang="ko"><body><div id="root"></div><script src="/bundle.js"></script></body></html>'); return; }
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      calls.push({ path: url.pathname + url.search, method: req.method!, body });
      const json = (value: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (url.pathname === '/api/me') return json({ user: 'user', subject: 'sub', role: admin ? 'admin' : 'researcher', region: 'us-east-1', features: {} });
      if (url.pathname === '/api/admin/users') return json({ users: [] });
      if (url.pathname === '/api/projects') {
        if (req.method === 'GET') return json(projects);
        if (createError) return json({ error: '프로젝트 생성 요청이 거부되었습니다.' }, 409);
        const created = { ...body, queue: `${body.namespace}-localqueue` } as Project;
        projects.push(created); return json(created);
      }
      if (url.pathname === '/api/queues') {
        const id = url.searchParams.get('backendId');
        const selected = /(?:^|;\s*)pai-project=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
        if (selected && id !== (projects.find(p => p.id === selected)?.backendId ?? 'default')) return json({ error: 'Backend is bound to the selected project' }, 403);
        if (!id || (id !== 'default' && !rows.some(r => r.id === id && r.status === 'READY'))) return json({ error: 'Backend is not ready' }, 409);
        return json({ localQueues: [
          { namespace: 'hyperpod-ns-shared', name: 'hyperpod-ns-shared-localqueue' },
          { namespace: 'hyperpod-ns-free', name: 'hyperpod-ns-free-localqueue' },
          { namespace: 'hyperpod-ns-wrong', name: 'unexpected-name' },
        ] });
      }
      if (url.pathname === '/api/backends') {
        if (registryMissing) return json({ error: 'Backend API unavailable' }, 404);
        if (!admin) return json({ error: 'Admin required' }, 403);
        if (req.method === 'POST') {
          const previous = rows.find(r => r.id === body.id)!;
          if (conflict) { previous.version!++; return json({ error: 'Backend registry changed; reload its version' }, 409); }
          if (body.expectedVersion !== previous.version) return json({ error: 'Wrong version' }, 409);
          const saved = { ...previous, version: previous.version! + 1, enabled: body.enabled, status: body.enabled ? 'UNREADY' : 'DISABLED',
            findings: body.enabled ? [{ code: 'capability_probe', message: '연결 및 권한 검사가 필요합니다.' }] : [] };
          rows = rows.map(r => r.id === saved.id ? saved : r); return json(saved);
        }
        return json({ default: { id: 'default', configured: true, clusterName: 'home-eks' }, backends: rows });
      }
      const match = /^\/api\/backends\/([^/]+)(\/check)?$/.exec(url.pathname);
      if (match) {
        const current = rows.find(r => r.id === match[1])!;
        if (match[2]) {
          if (body.version !== current.version) return json({ error: 'Wrong check version' }, 409);
          const saved = { ...current, status: probeReady ? 'READY' : 'UNREADY',
            findings: probeReady ? [] : [{ code: 'worker-api-network', message: 'Worker 네트워크 증거를 확인하지 못했습니다.' }] };
          rows = rows.map(r => r.id === saved.id ? saved : r); return json(saved);
        }
        return json({ backend: current, revisions: current.version ? [{ version: current.version, enabled: current.enabled, createdBy: 'admin', createdAt: '2026-09-16T00:00:00Z' }] : [] });
      }
      return json({ error: 'Missing fixture route' }, 404);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  }, 30000);
  beforeEach(async () => {
    admin = true; rows = [row('alpha', true), row('beta', false)]; probeReady = false; registryMissing = false; createError = false; conflict = false;
    projects = [{ id: 'legacy', name: 'Legacy project', namespace: 'hyperpod-ns-shared', queue: 'hyperpod-ns-shared-localqueue', members: {} }];
    calls = []; errors = [];
    page = await browser.newPage(); page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(3000);
    await page.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
  });
  afterEach(async () => { await page.close(); expect(errors).toEqual([]); });
  afterAll(async () => { await browser?.close(); if (server) await new Promise<void>(resolve => server.close(() => resolve())); });

  it('keeps the configured default usable with no additional targets and shows an admin-only sidebar link', async () => {
    rows = [];
    await page.goto(origin + '/backends');
    await page.getByText('추가로 허용된 backend가 없습니다.', { exact: true }).waitFor();
    expect(await page.getByText('기존 기본 연결 · 설정됨', { exact: true }).count()).toBe(1);
    expect(await page.getByRole('link', { name: '백엔드 연결', exact: true }).count()).toBe(1);
    expect(await page.getByRole('button', { name: '허용된 backend 등록' }).count()).toBe(0);
    await page.goto(origin + '/projects');
    const backend = page.getByLabel(/^실행 backend/), pool = page.getByLabel(/^연구 자원 풀/);
    await pool.locator('option[value="hyperpod-ns-free"]').waitFor({ state: 'attached' });
    expect(await backend.inputValue()).toBe('default');
    expect(await pool.locator('option[value="hyperpod-ns-shared"]').count()).toBe(0);
    await pool.selectOption('hyperpod-ns-free');
    await page.getByLabel('프로젝트 이름', { exact: true }).fill('Default project');
    await page.getByLabel('식별자', { exact: true }).fill('default-project');
    await page.getByRole('button', { name: '프로젝트 만들기', exact: true }).click();
    await page.getByText('프로젝트를 만들었습니다.', { exact: false }).waitFor();
    expect(calls.find(c => c.path === '/api/projects' && c.method === 'POST')?.body).toEqual({ id: 'default-project', name: 'Default project', namespace: 'hyperpod-ns-free', backendId: 'default', members: {} });
  }, 15000);

  it('registers and checks using current revisions, displays UNREADY evidence, and never manufactures readiness', async () => {
    rows = [row('beta', false)];
    await page.goto(origin + '/backends');
    await page.getByRole('button', { name: /^beta/ }).click();
    await page.getByRole('button', { name: '허용된 backend 등록' }).click();
    await page.getByText('연결 및 권한 검사가 필요합니다.', { exact: true }).waitFor();
    expect(calls.find(c => c.path === '/api/backends' && c.method === 'POST')?.body).toEqual({ id: 'beta', expectedVersion: 0, enabled: true });
    await page.getByRole('button', { name: '연결·권한 다시 검사' }).click();
    await page.getByText('Worker 네트워크 증거를 확인하지 못했습니다.', { exact: true }).waitFor();
    expect(await page.getByRole('link', { name: '이 backend로 프로젝트 만들기' }).count()).toBe(0);
    expect(await page.getByRole('textbox').count()).toBe(0);
    probeReady = true;
    await page.getByRole('button', { name: '연결·권한 다시 검사' }).click();
    await page.getByRole('link', { name: '이 backend로 프로젝트 만들기' }).waitFor();
    expect(calls.filter(c => c.path === '/api/backends/beta/check').every(c => c.body.version === 1)).toBe(true);
    await page.getByRole('button', { name: '새 실행에 사용 중지' }).click();
    await page.getByRole('button', { name: '다시 사용 등록' }).waitFor();
    expect(calls.filter(c => c.path === '/api/backends' && c.method === 'POST').at(-1)?.body).toEqual({ id: 'beta', expectedVersion: 1, enabled: false });
    expect(await page.getByRole('link', { name: '이 backend로 프로젝트 만들기' }).count()).toBe(0);
  }, 15000);

  it('resets queue selection on backend changes, allows same namespace on another backend, and preserves form input after HTTP errors', async () => {
    await page.goto(origin + '/projects');
    const pool = page.getByLabel(/^연구 자원 풀/);
    await pool.locator('option[value="hyperpod-ns-free"]').waitFor({ state: 'attached' }); await pool.selectOption('hyperpod-ns-free');
    await page.getByLabel(/^실행 backend/).selectOption('alpha');
    expect(await pool.inputValue()).toBe('');
    expect(await page.getByRole('button', { name: '프로젝트 만들기', exact: true }).isDisabled()).toBe(true);
    await pool.locator('option[value="hyperpod-ns-shared"]').waitFor({ state: 'attached' }); await pool.selectOption('hyperpod-ns-shared');
    expect(await pool.locator('option[value="hyperpod-ns-wrong"]').count()).toBe(0);
    await page.getByLabel('프로젝트 이름', { exact: true }).fill('Alpha project');
    await page.getByLabel('식별자', { exact: true }).fill('alpha-project');
    createError = true;
    await page.getByRole('button', { name: '프로젝트 만들기', exact: true }).click();
    await page.getByText('프로젝트 생성 요청이 거부되었습니다.', { exact: true }).waitFor();
    expect(await page.getByLabel('식별자', { exact: true }).inputValue()).toBe('alpha-project');
    expect(await page.getByText('프로젝트를 만들었습니다.', { exact: false }).count()).toBe(0);
    expect(calls.find(c => c.path === '/api/projects' && c.method === 'POST')?.body).toMatchObject({ backendId: 'alpha', namespace: 'hyperpod-ns-shared' });
    createError = false; await page.getByRole('button', { name: '프로젝트 만들기', exact: true }).click();
    await page.getByText('프로젝트를 만들었습니다.', { exact: false }).waitFor();
  }, 15000);

  it('uses existing global project selection to retrieve another backend queues without silently changing cookies', async () => {
    await page.context().addCookies([{ name: 'pai-project', value: 'legacy', url: origin }]);
    await page.goto(origin + '/projects?backendId=alpha');
    await page.getByText('Backend is bound to the selected project', { exact: true }).waitFor();
    expect(await page.getByRole('button', { name: '프로젝트 만들기', exact: true }).isDisabled()).toBe(true);
    expect((await page.context().cookies()).find(c => c.name === 'pai-project')?.value).toBe('legacy');
    await page.getByLabel('연구 프로젝트', { exact: true }).selectOption('');
    await page.getByLabel(/^연구 자원 풀/).locator('option[value="hyperpod-ns-shared"]').waitFor({ state: 'attached' });
    expect(await page.getByLabel(/^실행 backend/).inputValue()).toBe('alpha');
    expect(await page.getByText('Backend is bound to the selected project', { exact: true }).count()).toBe(0);
  }, 15000);

  it('shows API absence and CAS conflicts as errors without silently retrying mutations', async () => {
    rows = [row('beta', false)]; conflict = true;
    await page.goto(origin + '/backends');
    await page.getByRole('button', { name: /^beta/ }).click();
    await page.getByRole('button', { name: '허용된 backend 등록' }).click();
    await page.getByText('Backend registry changed; reload its version', { exact: true }).waitFor();
    expect(calls.filter(c => c.path === '/api/backends' && c.method === 'POST')).toHaveLength(1);
    expect(await page.getByText('등록 기록 저장', { exact: false }).count()).toBe(0);
    registryMissing = true; await page.goto(origin + '/projects');
    await page.getByText('Backend API unavailable', { exact: true }).waitFor();
    expect(await page.getByRole('button', { name: '프로젝트 만들기', exact: true }).isDisabled()).toBe(true);
  }, 15000);

  it('hides backend administration and creation controls from a researcher without requesting admin APIs', async () => {
    admin = false;
    await page.goto(origin + '/backends');
    await page.getByText('플랫폼 관리자 전용', { exact: true }).waitFor();
    expect(await page.getByRole('link', { name: '백엔드 연결', exact: true }).count()).toBe(0);
    expect(calls.some(c => c.path.startsWith('/api/backends'))).toBe(false);
    await page.goto(origin + '/projects');
    await page.getByRole('heading', { name: '프로젝트 목록', exact: true }).waitFor();
    expect(await page.getByRole('button', { name: '프로젝트 만들기', exact: true }).count()).toBe(0);
    expect(calls.some(c => c.path.startsWith('/api/backends') || c.path === '/api/admin/users')).toBe(false);
  }, 10000);
});
