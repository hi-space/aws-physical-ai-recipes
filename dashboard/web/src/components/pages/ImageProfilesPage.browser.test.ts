/** Real browser/UI and service with memory storage + fake probes; no cloud calls. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { build } from 'esbuild';
import { MemoryKV } from '@/server/store/dynamo';
import { Repo } from '@/server/store/repo';
import { imageProfilesService, type ImageProfileDeps } from '@/server/services/image-profiles';
import { parseWorkflowYaml } from '@/server/workflow/template';
import type { Project } from '@/server/auth/projects';
import { projectItem } from '@/server/auth/projects';
import { projectFixture } from '@/server/auth/session.test-helpers';

const image = '123456789012.dkr.ecr.us-east-1.amazonaws.com/recipes/cpu:stable';
const digest = 'sha256:' + 'a'.repeat(64), resolved = image.replace(':stable', '@' + digest);
const project: Project = projectFixture('a', { name: 'Browser fixture' });

describe.skipIf(!existsSync(chromium.executablePath()))('image profile browser contracts', () => {
  let server: Server, browser: Browser, page: Page, origin: string;
  let d: ImageProfileDeps, admin = true, calls: string[] = [], errors: string[] = [];
  beforeAll(async () => {
    const bundle = await build({ stdin: { contents: `import React from 'react';import{createRoot}from'react-dom/client';import{QueryClient,QueryClientProvider}from'@tanstack/react-query';import{ImageProfilesPage}from'./src/components/pages/ImageProfilesPage';createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider,{client:new QueryClient({defaultOptions:{queries:{retry:false}}})},React.createElement(ImageProfilesPage)));`,
      resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, platform: 'browser', format: 'iife',
      define: { 'process.env.NODE_ENV': '"test"' }, plugins: [{ name: 'local-next-link', setup(builder) {
        builder.onResolve({ filter: /^next\/link$/ }, args => ({ path: args.path, namespace: 'fixture' }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ loader: 'jsx', resolveDir: process.cwd(),
          contents: `import React from 'react';export default function Link({href,children,...props}){return <a href={href} {...props}>{children}</a>}` }));
      } }] });
    server = createServer(async (req, res) => {
      const url = new URL(req.url!, 'http://fixture');
      if (url.pathname === '/bundle.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(bundle.outputFiles[0].text); return; }
      if (!url.pathname.startsWith('/api/')) { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><html lang="ko"><body><div id="root"></div><script src="/bundle.js"></script></body></html>'); return; }
      calls.push(url.pathname + url.search);
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      const service = imageProfilesService({ user: 'user', subject: 'sub', email: '', role: admin ? 'admin' : 'researcher' }, d);
      const json = (value: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
      try {
        if (url.pathname === '/api/image-profiles') {
          if (req.method === 'POST') return json(await service.approve(body, project));
          return json({ project, profiles: await service.list(project), capabilities: { canApprove: admin, canSeed: admin } });
        }
        if (url.pathname === '/api/image-profiles/preflight') return json(await service.preflight(parseWorkflowYaml(body.yaml).spec, project));
        const id = /^\/api\/image-profiles\/([a-z0-9-]+)$/.exec(url.pathname)?.[1];
        if (id) return json(await service.get(id, project, url.searchParams.has('version') ? Number(url.searchParams.get('version')) : undefined));
        return json({ error: 'No fixture route' }, 404);
      } catch (error) { return json({ error: (error as Error).message }, (error as { status?: number }).status ?? 500); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  }, 30000);
  beforeEach(async () => {
    admin = true; calls = []; errors = [];
    const repo = new Repo(new MemoryKV());
    await repo.kv.put(projectItem(project));
    d = { repo, scope: { accountId: '123456789012', region: 'us-east-1' }, environment: {}, now: () => new Date(),
      inspectImage: async () => ({ requestedImage: image, resolvedImage: resolved, digest, repository: 'recipes/cpu',
        accountId: '123456789012', region: 'us-east-1', architectures: ['amd64'],
        manifests: [{ digest, configDigest: 'sha256:' + 'b'.repeat(64), architecture: 'amd64', os: 'linux' }],
        inspectedAt: new Date().toISOString(), source: 'ecr-manifest-config' }),
      hardware: async () => ({ source: 'eks-nodes+ec2-instance-types', checkedAt: new Date().toISOString(), catalogAvailable: true, nodes: [{
        name: 'cpu-a', architecture: 'amd64', instanceType: 'c5.4xlarge', ready: true, schedulable: true,
        allocatable: { cpu: 15, memoryMiB: 30000 }, catalog: { cpu: 16, memoryMiB: 32768, architectures: ['amd64'], gpuCount: 0, gpuNames: [] },
      }] }),
    };
    page = await browser.newPage(); page.setDefaultTimeout(4000);
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
  });
  afterEach(async () => { await page.close(); expect(errors).toEqual([]); });
  afterAll(async () => { await browser?.close(); if (server) await new Promise<void>(resolve => server.close(() => resolve())); });

  it('approves revisions, refreshes displayed evidence, and preflights without submitting workflows', async () => {
    await page.goto(origin + '/image-profiles');
    await page.getByRole('textbox', { name: /식별자/ }).fill('cpu');
    await page.getByRole('textbox', { name: /^이름$/ }).first().fill('CPU fixture');
    await page.getByRole('textbox', { name: /Private ECR/ }).fill(image);
    await page.getByRole('button', { name: '검사하고 승인 버전 저장' }).click();
    await page.getByText(/v1.*저장/, { exact: false }).waitFor();
    expect(await page.getByRole('combobox', { name: /버전/ }).inputValue()).toBe('1');
    await page.getByRole('button', { name: '검사용 예제 작성' }).click();
    expect(await page.getByRole('textbox', { name: /사전 검사/ }).inputValue()).toContain(resolved);
    await page.getByRole('button', { name: '호환성 검사', exact: true }).click();
    await page.getByText('추가 확인 필요', { exact: true }).waitFor();
    await page.getByText('모델·라이선스·데이터 접근과 실제 애플리케이션 실행은 검사하지 않았습니다.', { exact: false }).waitFor();
    await page.getByRole('textbox', { name: /^이름$/ }).first().fill('CPU revised');
    await page.getByRole('button', { name: '검사하고 승인 버전 저장' }).click();
    await page.getByText(/v2.*저장/, { exact: false }).waitFor();
    expect(await page.getByRole('combobox', { name: /버전/ }).inputValue()).toBe('2');
    await page.getByRole('combobox', { name: /버전/ }).selectOption('1');
    await page.getByRole('heading', { name: 'CPU fixture · 증거와 이력' }).waitFor();
    expect(calls.some(path => path.includes('/api/workflows') || path.includes('null'))).toBe(false);
    expect(calls).toContain('/api/image-profiles/cpu?version=2');
  }, 30000);
  it('keeps administrator approval controls unavailable to researchers', async () => {
    admin = false;
    await page.goto(origin + '/image-profiles');
    await page.getByText('등록된 이미지가 없습니다.', { exact: true }).waitFor();
    expect(await page.getByRole('button', { name: '검사하고 승인 버전 저장' }).count()).toBe(0);
    expect(await page.getByRole('button', { name: '배포 이미지 후보 검사' }).count()).toBe(0);
  }, 10000);
});
