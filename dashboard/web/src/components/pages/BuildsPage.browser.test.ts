/** Only loopback HTTP fixtures; never starts CodeBuild or contacts registries. */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { build } from 'esbuild';

let server: Server, browser: Browser, origin: string;
let requests: { body: Record<string, string>; key: string | undefined; project: string | undefined }[] = [];
let rows: Record<string, unknown>[] = [], loseReply = false, operationsReads = 0;
const gitId = 'src-' + 'a'.repeat(32), snapshotId = 'src-' + 'b'.repeat(32);
beforeAll(async () => {
  if (!existsSync(chromium.executablePath())) return;
  const bundle = await build({ stdin: { contents: `import React from'react';import{createRoot}from'react-dom/client';import{QueryClient,QueryClientProvider}from'@tanstack/react-query';import{BuildsPage}from'./src/components/pages/BuildsPage';const client=new QueryClient({defaultOptions:{queries:{retry:false}}});createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider,{client},React.createElement(BuildsPage)));`,
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
    const json = (value: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (url.pathname === '/api/me') return json({ user: 'user', subject: 'user', role: 'researcher', project: { id: 'a', name: 'Project A', role: 'researcher' } });
    if (url.pathname === '/api/builds') { operationsReads++; return json({ error: 'Operations forbidden' }, 403); }
    if (url.pathname === '/api/builds/sources') return json({ projectId: 'a', targets: [{ id: 'git', sourceType: 'GITHUB', codeBuildProjectName: 'source-git' },
      { id: 'snapshot', sourceType: 'S3', codeBuildProjectName: 'source-snapshot' }], sources: [
      { id: gitId, name: 'Git source', current: true, sourceType: 'GITHUB', repositoryUrl: 'https://github.com/example/source', contentHash: 'a'.repeat(64), dockerfile: 'Dockerfile', context: '.' },
      { id: snapshotId, name: 'Local snapshot', current: true, sourceType: 'S3', snapshot: { versionId: 'version1', sha256: 'b'.repeat(64) }, contentHash: 'b'.repeat(64), dockerfile: 'Dockerfile', context: '.' },
    ] });
    if (url.pathname === '/api/builds/runs' && req.method === 'POST') {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()), key = req.headers['idempotency-key'] as string;
      requests.push({ body, key, project: req.headers['x-pai-project'] as string });
      let row = rows.find(value => value.key === key);
      if (!row) { row = { id: 'sb-' + String(rows.length + 1).padStart(32, 'a'), key, state: 'STARTING', actor: 'user',
        sourceType: body.sourceId === snapshotId ? 'S3' : 'GITHUB', commit: body.commit, snapshot: body.sourceId === snapshotId ? { versionId: 'version1' } : undefined, createdAt: '2026-09-16T00:00:00Z' }; rows.push(row); }
      if (loseReply) { loseReply = false; return json({ error: 'reply interrupted' }, 503); }
      return json(row, 202);
    }
    if (url.pathname === '/api/builds/runs') return json({ items: rows });
    if (url.pathname.startsWith('/api/builds/runs/')) return json(rows.find(row => row.id === url.pathname.split('/')[4]) ?? {});
    return json({ error: 'missing fixture' }, 404);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
}, 30000);
afterAll(async () => { await browser?.close(); if (server) await new Promise<void>(resolve => server.close(() => resolve())); });

it.skipIf(!existsSync(chromium.executablePath()))('requires an immutable Git commit and retries an interrupted response with the same request identity', async () => {
  requests = []; rows = []; loseReply = true; operationsReads = 0;
  const page = await browser.newPage();
  await page.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
  try {
    await page.goto(origin + '/builds');
    await page.getByLabel('등록된 빌드 출처').selectOption(gitId);
    const start = page.getByRole('button', { name: '이미지 빌드 시작', exact: true });
    await page.getByLabel('전체 Git commit SHA').fill('main');
    expect(await start.isDisabled()).toBe(true);
    await page.getByLabel('전체 Git commit SHA').fill('c'.repeat(40));
    await start.click(); await page.getByText('reply interrupted', { exact: false }).waitFor();
    await start.click(); await page.getByText('빌드 요청을 저장했습니다.', { exact: true }).waitFor();
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(requests[1]);
    expect(requests[0].body).toEqual({ sourceId: gitId, commit: 'c'.repeat(40) });
    expect(requests[0].project).toBe('a');
    expect(rows).toHaveLength(1);
    expect(operationsReads).toBe(0);
  } finally { await page.close(); }
}, 15000);
it.skipIf(!existsSync(chromium.executablePath()))('starts the registered local snapshot without inventing a Git commit or claiming runtime readiness', async () => {
  requests = []; rows = []; loseReply = false;
  const page = await browser.newPage();
  await page.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
  try {
    await page.goto(origin + '/builds');
    await page.getByLabel('등록된 빌드 출처').selectOption(snapshotId);
    expect(await page.getByLabel('전체 Git commit SHA').count()).toBe(0);
    await page.getByRole('button', { name: '이미지 빌드 시작', exact: true }).click();
    await page.getByText('빌드 요청을 저장했습니다.', { exact: true }).waitFor();
    expect(requests[0].body).toEqual({ sourceId: snapshotId });
    expect(await page.getByText('워크플로 실행 전 이미지 프로필 승인', { exact: false }).count()).toBe(1);
  } finally { await page.close(); }
}, 15000);
