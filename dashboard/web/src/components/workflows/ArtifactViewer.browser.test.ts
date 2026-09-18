import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { build } from 'esbuild';

/** Real Chromium against a fixture API: gallery tiles load from presigned URLs, JSON renders inline, weights fall back to download. */
describe.skipIf(!existsSync(chromium.executablePath()))('artifact viewer browser', () => {
  let browser: Browser, server: Server, origin: string;
  const requests: URL[] = [], errors: string[] = [];
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const evaluation = { smoke: { passed: 1 }, open_loop: { mse_mean: 185.96, mae_mean: 8.21 }, gate: { passed: 1 } };
  const ready = { dataset: 'eval', version: 1, uri: 's3://archive/projects/p/runs/w/attempts/1/evaluate/h/', state: 'ready', manifestHash: 'h'.repeat(64), fileCount: 3, sizeBytes: 9_000_041_365, mediaCount: 1, truncated: false,
    files: [
      { path: 'evaluation.json', bytes: 1365, kind: 'json', previewable: true },
      { path: 'model.safetensors', bytes: 9_000_000_000, kind: 'other', previewable: false },
      { path: 'plots/traj_0.jpeg', bytes: 40_000, kind: 'image', previewable: true },
    ] };
  const legacy = { dataset: 'old-ckpt', version: 2, uri: 's3://data/checkpoints/workflows/old/train', state: 'unavailable', message: '이 출력은 검증된 manifest 없이 게시된 구버전 결과입니다.', fileCount: 0, sizeBytes: 0, mediaCount: 0, files: [], truncated: false };
  const artifacts = { workflowId: 'w', status: 'SUCCEEDED', mediaCount: 1, fileCount: 3, tasks: [
    { task: 'evaluate', phase: 'SUCCEEDED', attempt: 1, versions: [ready] },
    { task: 'train', phase: 'SUCCEEDED', attempt: 1, versions: [legacy] },
  ] };
  beforeAll(async () => {
    const bundle = await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
      import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
      import {ArtifactViewer} from './src/components/workflows/ArtifactViewer';
      createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient()}><ArtifactViewer workflowId="w" running={false}/></QueryClientProvider>);`,
      loader: 'tsx', resolveDir: process.cwd() }, write: false, bundle: true, platform: 'browser', format: 'iife', define: { 'process.env.NODE_ENV': '"test"' },
      banner: { js: 'var process = { env: { NODE_ENV: "test" } };' } });
    server = createServer((req, res) => {
      const url = new URL(req.url!, 'http://fixture');
      if (url.pathname === '/bundle.js') { res.setHeader('content-type', 'text/javascript'); res.end(bundle.outputFiles[0].text); return; }
      if (url.pathname.startsWith('/files/')) {
        requests.push(url);
        const path = decodeURIComponent(url.pathname.slice('/files/'.length));
        if (path.endsWith('.jpeg')) { res.setHeader('content-type', 'image/png'); res.end(png); return; }
        if (path.endsWith('.json')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(evaluation)); return; }
        res.statusCode = 404; res.end(); return;
      }
      if (!url.pathname.startsWith('/api/')) { res.setHeader('content-type', 'text/html'); res.end('<html><body><div id="root"></div><script src="/bundle.js"></script></body></html>'); return; }
      requests.push(url);
      res.setHeader('content-type', 'application/json');
      if (url.pathname === '/api/workflows/w/artifacts') { res.end(JSON.stringify(artifacts)); return; }
      if (url.pathname === '/api/datasets/eval/versions/1/download') {
        const path = url.searchParams.get('path')!;
        res.end(JSON.stringify({ url: `${origin}/files/${encodeURIComponent(path)}`, size: 1, kind: path.endsWith('.json') ? 'json' : 'image', expiresIn: 300 })); return;
      }
      res.statusCode = 404; res.end(JSON.stringify({ error: 'unexpected ' + url.pathname }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  }, 30_000);
  afterAll(async () => { await browser?.close(); server?.closeAllConnections(); if (server) await new Promise<void>(resolve => server.close(() => resolve())); });

  it('renders the media gallery from presigned inline URLs, previews JSON text and explains legacy versions', async () => {
    const context = await browser.newContext();
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const tab = await context.newPage(); tab.setDefaultTimeout(5000); tab.on('pageerror', e => errors.push(e.message));
    try {
      await tab.goto(origin);
      await tab.getByText('3개 파일 · 미디어 1개 · 작업 2개').waitFor();
      await tab.getByText('구버전 결과', { exact: false }).waitFor();
      const image = tab.locator('img[alt="plots/traj_0.jpeg"]');
      await image.waitFor();
      await expect.poll(() => image.evaluate(el => (el as HTMLImageElement).naturalWidth)).toBe(1);
      const signed = requests.filter(r => r.pathname === '/api/datasets/eval/versions/1/download');
      expect(signed.map(r => [r.searchParams.get('path'), r.searchParams.get('inline')])).toEqual([['plots/traj_0.jpeg', '1']]);

      await tab.getByRole('radio', { name: '파일' }).click();
      await tab.getByRole('button', { name: /evaluation\.json/ }).click();
      await tab.getByText('"mse_mean": 185.96', { exact: false }).waitFor();
      await tab.getByRole('button', { name: /model\.safetensors/ }).click();
      await tab.getByText('브라우저 미리보기를 지원하지 않는 파일입니다').waitFor();
      expect(requests.some(r => r.pathname.startsWith('/files/') && r.pathname.includes('safetensors'))).toBe(false);
      expect(errors).toEqual([]);
    } catch (error) {
      throw new Error(`${String(error)}; browser=${JSON.stringify(errors)}; requests=${requests.map(r => r.pathname + r.search).join(',')}; body=${(await tab.locator('body').innerText()).slice(0, 800)}`);
    } finally { await context.close(); }
  }, 20_000);
});
