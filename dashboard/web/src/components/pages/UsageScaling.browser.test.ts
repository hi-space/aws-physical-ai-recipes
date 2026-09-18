/** Local browser/fake HTTP only. No real scale, pricing refresh or cloud requests. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { build } from 'esbuild';
import { createTestSnapshot } from '@/server/aws/hyperpod-rates.fixture';
import { estimateRunUsage } from '@/server/services/usage';
import { parseWorkflowYaml } from '@/server/workflow/template';
import type { Task, Workflow } from '@/server/store/types';

const hash = 'a'.repeat(64), id = '00000000-0000-4000-8000-000000000001';
const startedAt = '2026-09-16T17:00:00Z', finishedAt = '2026-09-16T18:00:00Z';
const spec = parseWorkflowYaml('workflow:\n  name: trained\n  resources: { gpu: { cpu: 8, gpu: 1, platform: ml.g5.8xlarge } }\n  tasks: [{name: train, resource: gpu, image: example:v1, command: [python, train.py]}]').spec;
const workflow = { id: 'known', name: 'Known run', projectId: 'p', backendId: 'default', status: 'SUCCEEDED', spec, createdAt: startedAt, finishedAt } as Workflow;
const task = { workflowId: 'known', name: 'train', phase: 'SUCCEEDED', attempts: 1, replicas: 1, startedAt, finishedAt, updatedAt: finishedAt } as Task;
const testRates = createTestSnapshot('us-east-1', new Date(finishedAt));
const known = estimateRunUsage(workflow, [task], [], testRates, new Date(finishedAt), 'us-east-1');
const unknown = estimateRunUsage({ ...workflow, id: 'unknown', name: 'Missing history' }, [{ ...task, attempts: 2 }], [], testRates, new Date(finishedAt), 'us-east-1');
describe.skipIf(!existsSync(chromium.executablePath()))('F41 usage and scaling browser contracts', () => {
  let browser: Browser, server: Server, page: Page, origin: string;
  let admin: boolean, blocked: boolean, completed: boolean, rateFailure: boolean, policy: Record<string, unknown> | undefined, operation: Record<string, unknown> | undefined, plannedTo: number;
  let calls: Array<{ method: string; path: string; body: Record<string, unknown> }>, errors: string[];
  const snapshot = () => ({ backendId: 'default', cluster: 'hp', group: 'gpu', observedAt: finishedAt, specHash: hash, currentCount: completed ? plannedTo : 3, targetCount: completed ? plannedTo : 3,
    instanceType: 'ml.g5.8xlarge', policy, floor: Math.max(Number(policy?.minCount ?? 0), Number(policy?.baselineCount ?? 0)), idleEligible: false, targets: [], historyHash: 'history', structuralBlockers: [],
    blockers: blocked ? [{ code: 'workflows_active', message: '실행·결과 확정 중인 작업이 있어 축소할 수 없습니다.' }] : [],
    activeOperationId: operation && !completed ? id : undefined });
  beforeAll(async () => {
    const bundle = await build({ stdin: { contents: `import React from 'react';import{createRoot}from'react-dom/client';import{QueryClient,QueryClientProvider}from'@tanstack/react-query';import{UsagePage}from'./src/components/pages/UsagePage';import{ComputePage}from'./src/components/pages/ComputePage';createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider,{client:new QueryClient({defaultOptions:{queries:{retry:false}}})},React.createElement(location.pathname==='/usage'?UsagePage:ComputePage)));`,
      resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, platform: 'browser', format: 'iife', define: { 'process.env.NODE_ENV': '"test"' },
      plugins: [{ name: 'links', setup(builder) {
        builder.onResolve({ filter: /^next\/link$/ }, args => ({ path: args.path, namespace: 'link' }));
        builder.onLoad({ filter: /.*/, namespace: 'link' }, () => ({ loader: 'jsx', resolveDir: process.cwd(), contents: `import React from'react';export default function Link({href,children,...props}){return <a href={href} {...props}>{children}</a>}` }));
      } }] });
    server = createServer(async (req, res) => {
      const url = new URL(req.url!, 'http://fixture');
      if (url.pathname === '/bundle.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(bundle.outputFiles[0].text); return; }
      if (!url.pathname.startsWith('/api/')) { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><html lang="ko"><body><div id="root"></div><script src="/bundle.js"></script></body></html>'); return; }
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      calls.push({ method: req.method!, path: url.pathname + url.search, body });
      const json = (value: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (url.pathname === '/api/me') return json({ user: 'user', role: admin ? 'admin' : 'researcher', region: 'us-east-1', clusters: { eksName: 'eks', eks: 'hp' }, features: { eks: true }, project: { id: 'p', name: 'Project', role: 'researcher' } });
      if (url.pathname === '/api/projects') return json([{ id: 'p', name: 'Project' }]);
      if (url.pathname === '/api/usage') return json({ project: { id: 'p', name: 'Project' }, runs: [known, unknown], cpuHours: null, gpuHours: null, estimatedUsd: null, complete: false, completeDiscovery: true, pricing: known.pricing, discoveryBasis: '조회 기록 기준' });
      if (url.pathname === '/api/usage/rates') return rateFailure ? json({ error: '공식 단가 조회 실패' }, 503) : json(testRates);
      if (url.pathname === '/api/fsx') return json([]);
      if (url.pathname === '/api/clusters') return json({ clusters: [{ name: 'hp', orchestrator: 'eks', status: 'InService',
        groups: [{ name: 'gpu', instanceType: 'ml.g5.8xlarge', current: completed ? plannedTo : 3, target: completed ? plannedTo : 3, isGpu: true, isSystem: false }], nodes: [] }], k8sNodes: [], addons: [] });
      if (url.pathname === '/api/clusters/hp/scale' && req.method === 'GET') return json(snapshot());
      if (url.pathname.endsWith('/scale/policy')) {
        policy = { ...body, version: Number(body.expectedVersion) + 1, protectedInstanceIds: Math.max(Number(body.minCount), Number(body.baselineCount)) > 0 ? ['i-00000000000000003'] : [] };
        return json(policy);
      }
      if (url.pathname.endsWith('/scale/plan')) {
        if (blocked) return json({ status: 'BLOCKED', blockers: snapshot().blockers, snapshot: snapshot() });
        plannedTo = Number(body.count);
        return json({ status: 'PLANNED', blockers: [], snapshot: snapshot(), plan: { id, backendId: 'default', cluster: 'hp', group: 'gpu',
          from: 3, to: plannedTo, mode: body.mode, specHash: hash, policyVersion: policy?.version ?? 0, expiresAt: Date.now() + 300000,
          targets: Array.from({ length: Math.max(0, 3 - plannedTo) }, (_, i) => ({ instanceId: `i-${String(i + 1).padStart(17, '0')}`, name: `gpu-node-${i + 1}`, uid: `u${i + 1}`, resourceVersion: '1' })), status: 'PLANNED' } });
      }
      if (url.pathname === '/api/clusters/hp/scale' && req.method === 'POST') {
        operation = { id, status: 'UNKNOWN', message: '응답이 불명확합니다. 상태를 확인하세요.' }; return json(operation);
      }
      if (url.pathname.endsWith('/scale/reconcile')) return json({ ...operation, status: completed ? 'SUCCEEDED' : 'UNKNOWN', message: completed ? '실제 노드 수를 확인했습니다.' : '아직 결과를 확인하지 못했습니다.' });
      return json({ error: 'Missing fixture API' }, 404);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  }, 30000);
  beforeEach(async () => {
    admin = true; blocked = true; completed = false; rateFailure = false; operation = undefined; plannedTo = 1; calls = []; errors = [];
    policy = { group: 'gpu', version: 1, minCount: 1, baselineCount: 1, idleEnabled: false, idleMinutes: 30, protectedInstanceIds: ['i-00000000000000003'] };
    page = await browser.newPage(); page.setDefaultTimeout(5000); page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
  });
  afterEach(async () => { await page.close(); expect(errors).toEqual([]); });
  afterAll(async () => { await browser?.close(); if (server) await new Promise<void>(resolve => server.close(() => resolve())); });
  it('shows project/run estimates, unknown totals, and timestamped official rate basis without claiming account billing', async () => {
    admin = false; await page.goto(origin + '/usage');
    await page.getByRole('link', { name: 'Known run', exact: true }).waitFor();
    expect(await page.getByText(/\$3\.06/, { exact: false }).count()).toBe(1);
    expect(await page.getByText('알 수 없음', { exact: true }).count()).toBeGreaterThan(0);
    expect(await page.getByText(/가격표 게시/).count()).toBe(1);
    expect(await page.getByRole('link', { name: '공식 AWS 가격표 원문' }).getAttribute('href')).toBe(testRates.sourceUrl);
    expect(await page.getByRole('button', { name: '공식 단가 새로 조회' }).count()).toBe(0);
    expect(calls.some(c => c.path === '/api/cost')).toBe(false);
  });
  it('retains visible source timestamps when an admin price refresh fails', async () => {
    rateFailure = false; // Start with success so pricing is loaded
    admin = true; await page.goto(origin + '/usage');
    await page.getByRole('link', { name: 'Known run', exact: true }).waitFor();
    rateFailure = true; // Now fail the refresh
    await page.getByRole('button', { name: '공식 단가 새로 조회' }).click();
    await page.getByText('공식 단가 조회 실패', { exact: true }).waitFor();
    // Verify that previous pricing basis is still visible
    expect(await page.getByText(/가격표 게시/).count()).toBeGreaterThan(0);
  });
  it('shows blockers, resets review on edits, and treats unknown capacity responses as unknown until separately observed', async () => {
    await page.goto(origin + '/compute');
    await page.getByRole('button', { name: '계획·차단 사유', exact: true }).click();
    await page.getByText(/실행·결과 확정 중인 작업이 있어/).waitFor();
    await page.getByLabel('목표 노드 수', { exact: true }).fill('1');
    await page.getByRole('button', { name: '변경 계획 검사', exact: true }).click();
    expect(await page.getByRole('button', { name: '검토한 계획 실행' }).count()).toBe(0);
    blocked = false;
    await page.getByRole('button', { name: '활동 다시 검사' }).click();
    await page.getByText('현재 관측에서 차단 사유가 없습니다.', { exact: false }).waitFor();
    await page.getByRole('button', { name: '변경 계획 검사', exact: true }).click();
    await page.getByRole('button', { name: '검토한 계획 실행' }).waitFor();
    expect(calls.some(c => c.path === '/api/clusters/hp/scale' && c.method === 'POST')).toBe(false);
    await page.getByLabel('목표 노드 수', { exact: true }).fill('2');
    expect(await page.getByRole('button', { name: '검토한 계획 실행' }).count()).toBe(0);
    await page.getByRole('button', { name: '변경 계획 검사', exact: true }).click();
    await page.getByRole('button', { name: '검토한 계획 실행' }).click();
    await page.getByText('결과 불명확 · 자동 재시도하지 않음', { exact: true }).waitFor();
    expect(calls.filter(c => c.path === '/api/clusters/hp/scale' && c.method === 'POST')).toHaveLength(1);
    await page.getByRole('button', { name: '요청 결과 확인', exact: true }).click();
    await page.getByText('아직 결과를 확인하지 못했습니다.', { exact: true }).waitFor();
    completed = true; await page.getByRole('button', { name: '요청 결과 확인', exact: true }).click();
    await page.getByText('실제 노드 수 확인 완료', { exact: true }).waitFor();
    expect(calls.filter(c => c.path === '/api/clusters/hp/scale' && c.method === 'POST')).toHaveLength(1);
  }, 15000);
  it('requires explicit idle opt-in and retains an existing configured GPU baseline', async () => {
    await page.goto(origin + '/compute');
    await page.getByRole('button', { name: '계획·차단 사유', exact: true }).click();
    await page.getByText('보호 기준·유휴 정책 설정', { exact: true }).click();
    const optIn = page.getByRole('checkbox', { name: '유휴 기간 충족 시 자동 축소 허용' });
    expect(await optIn.isChecked()).toBe(false);
    expect(await page.getByLabel('최소 유지 노드 수').getAttribute('min')).toBe('0');
    expect(await page.getByLabel('최소 유지 노드 수').inputValue()).toBe('1');
    await optIn.check(); await page.getByLabel('유휴 관측 기간 (분)').fill('5');
    await page.getByRole('button', { name: '정책 저장', exact: true }).click();
    await page.getByText('편집 기준 v2 · 서버 v2', { exact: true }).waitFor();
    expect(calls.find(c => c.path.endsWith('/scale/policy'))?.body).toEqual({ group: 'gpu', expectedVersion: 1, minCount: 1, baselineCount: 1, idleMinutes: 5, idleEnabled: true, observedSpecHash: hash });
    expect(calls.some(c => c.path === '/api/clusters/hp/scale' && c.method === 'POST')).toBe(false);
  }, 10000);
  it('prefills the observed baseline and permits an explicit zero policy and reviewed all-node plan without enabling idle', async () => {
    policy = undefined; blocked = false;
    await page.goto(origin + '/compute');
    await page.getByRole('button', { name: '계획·차단 사유', exact: true }).click();
    await page.getByText('보호 기준·유휴 정책 설정', { exact: true }).click();
    const minimum = page.getByLabel('최소 유지 노드 수'), baseline = page.getByLabel('보호 기준 노드 수');
    expect(await minimum.inputValue()).toBe('3'); expect(await baseline.inputValue()).toBe('3');
    expect(await page.getByRole('checkbox', { name: '유휴 기간 충족 시 자동 축소 허용' }).isChecked()).toBe(false);
    expect(calls.some(call => call.path.endsWith('/scale/policy'))).toBe(false);
    await minimum.fill('0'); await baseline.fill('0');
    await page.getByRole('button', { name: '정책 저장', exact: true }).click();
    await page.getByText('편집 기준 v1 · 서버 v1', { exact: true }).waitFor();
    expect(calls.find(call => call.path.endsWith('/scale/policy'))?.body).toMatchObject({ expectedVersion: 0, minCount: 0, baselineCount: 0, idleEnabled: false, observedSpecHash: hash });
    await page.getByLabel('목표 노드 수', { exact: true }).fill('0');
    await page.getByRole('button', { name: '변경 계획 검사', exact: true }).click();
    await page.getByRole('button', { name: '검토한 계획 실행' }).waitFor();
    expect(await page.getByRole('list', { name: '삭제 대상 노드' }).locator('li').count()).toBe(3);
    expect(calls.some(call => call.path === '/api/clusters/hp/scale' && call.method === 'POST')).toBe(false);
    await page.getByRole('button', { name: '검토한 계획 실행' }).click();
    await page.getByText('결과 불명확 · 자동 재시도하지 않음', { exact: true }).waitFor();
    expect(calls.filter(call => call.path === '/api/clusters/hp/scale' && call.method === 'POST')).toHaveLength(1);
  }, 15000);
});
