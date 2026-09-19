import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { build } from 'esbuild';

describe.skipIf(!existsSync(chromium.executablePath()))('local log viewer browser', () => {
  let browser: Browser, server: Server, origin: string;
  let bundle: Awaited<ReturnType<typeof build>>;
  const requests: URL[] = [], errors: string[] = [];
  const target = { namespace: 'team', podName: 'pod', podUid: 'u1', attempt: 1, member: 0, containers: ['main'], phase: 'Running' };
  const snap = (lines: { ts: string; text: string }[]) => ({ source: 'kubernetes', phase: 'Running', target, container: 'main', targets: [target], lines, truncated: false, redaction: 'applied' });
  beforeAll(async () => {
    bundle = await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
      import {LogViewer} from './src/components/workflows/LogViewer';
      createRoot(document.getElementById('root')).render(<LogViewer workflowId="w" tasks={[{name:'train',attempts:1,phase:'RUNNING'}]}/>);`,
      loader: 'tsx', resolveDir: process.cwd() }, write: false, bundle: true, platform: 'browser', format: 'iife', define: { 'process.env.NODE_ENV': '"test"' },
      plugins: [{ name: 'local-link', setup(builder) {
        builder.onResolve({ filter: /^next\/link$/ }, args => ({ path: args.path, namespace: 'local-link' }));
        builder.onLoad({ filter: /.*/, namespace: 'local-link' }, () => ({ loader: 'jsx', resolveDir: process.cwd(),
          contents: `import React from 'react'; export default function Link({href,children,prefetch,...props}) { return <a href={href} {...props}>{children}</a>; }` }));
      } }] });
    server = createServer((req, res) => {
      const url = new URL(req.url!, 'http://fixture');
      if (url.pathname === '/bundle.js') { res.setHeader('content-type', 'text/javascript'); res.end(bundle.outputFiles![0].text); return; }
      if (!url.pathname.startsWith('/api/')) { res.setHeader('content-type', 'text/html'); res.end('<html><body><div id="root"></div><script src="/bundle.js"></script></body></html>'); return; }
      requests.push(url);
      if (url.searchParams.get('follow') === '1') {
        res.setHeader('content-type', 'text/event-stream');
        const since = url.searchParams.get('since');
        if (!since) res.end(`id: 2026-09-19T00:00:02Z\nevent: line\ndata: ${JSON.stringify({ ts: '2026-09-19T00:00:02Z', text: 'live' })}\n\nevent: end\ndata: {"reason":"timeout"}\n\n`);
        else res.end(`id: 2026-09-19T00:00:03Z\nevent: line\ndata: ${JSON.stringify({ ts: '2026-09-19T00:00:03Z', text: 'after reconnect' })}\n\nevent: end\ndata: {"reason":"pod-ended"}\n\n`);
        return;
      }
      res.setHeader('content-type', 'application/json');
      // The empty-ts line is last on purpose: lastTs (read from the tail's last line) must stay
      // empty so the very first SSE connect has no `since`, matching a fresh live-follow request.
      res.end(JSON.stringify(snap([{ ts: '2026-09-19T00:00:00Z', text: 'repeat' }, { ts: '2026-09-19T00:00:01Z', text: 'repeat' }, { ts: '2026-09-19T00:00:01Z', text: 'https://example.test' }, { ts: '', text: '' }])));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  }, 30_000);
  afterAll(async () => { await browser?.close(); server?.closeAllConnections(); if (server) await new Promise<void>(resolve => server.close(() => resolve())); });
  it('follows via SSE, reconnects with since=<last id> after a timeout end, and keeps earlier lines', async () => {
    const context = await browser.newContext();
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const tab = await context.newPage(); tab.setDefaultTimeout(4000); tab.on('pageerror', e => errors.push(e.message));
    try {
      await tab.goto(origin); await tab.getByText('https://example.test', { exact: false }).waitFor();
      await tab.getByRole('button', { name: '계속 보기' }).click();
      await tab.getByText('after reconnect', { exact: false }).waitFor({ timeout: 8000 });
      const content = await tab.locator('[aria-label="작업 로그"]').evaluate(el => {
        const copy = el.cloneNode(true) as HTMLElement; copy.querySelectorAll('.ln').forEach(n => n.remove()); return copy.textContent;
      });
      expect(content?.match(/repeat/g)).toHaveLength(2);
      expect(content).toContain('live');
      expect(requests.some(r => r.searchParams.get('since') === '2026-09-19T00:00:02Z' && r.searchParams.get('follow') === '1')).toBe(true);
      expect(errors).toEqual([]);
    } catch (error) {
      throw new Error(`${String(error)}; browser=${JSON.stringify(errors)}; requests=${requests.map(r => r.pathname + r.search).join(",")}; body=${(await tab.locator('body').innerText()).slice(0, 600)}`);
    } finally { await context.close(); }
  }, 15_000);

  it('never opens SSE for a not-started pod even while follow is on', async () => {
    const localRequests: URL[] = [], localErrors: string[] = [];
    const notStartedServer = createServer((req, res) => {
      const url = new URL(req.url!, 'http://fixture');
      if (url.pathname === '/bundle.js') { res.setHeader('content-type', 'text/javascript'); res.end(bundle.outputFiles![0].text); return; }
      if (!url.pathname.startsWith('/api/')) { res.setHeader('content-type', 'text/html'); res.end('<html><body><div id="root"></div><script src="/bundle.js"></script></body></html>'); return; }
      localRequests.push(url);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ source: 'none', reason: 'not-started', targets: [], lines: [], truncated: false, redaction: 'none' }));
    });
    await new Promise<void>(resolve => notStartedServer.listen(0, '127.0.0.1', resolve));
    const localOrigin = `http://127.0.0.1:${(notStartedServer.address() as AddressInfo).port}`;
    const context = await browser.newContext();
    await context.route('**/*', route => new URL(route.request().url()).origin === localOrigin ? route.continue() : route.abort());
    const tab = await context.newPage(); tab.setDefaultTimeout(4000); tab.on('pageerror', e => localErrors.push(e.message));
    try {
      await tab.goto(localOrigin);
      await tab.getByText('시작 전', { exact: false }).waitFor();
      await new Promise(resolve => setTimeout(resolve, 1500));
      expect(localRequests.some(r => r.searchParams.get('follow') === '1')).toBe(false);
      expect(localErrors).toEqual([]);
    } catch (error) {
      throw new Error(`${String(error)}; browser=${JSON.stringify(localErrors)}; requests=${localRequests.map(r => r.pathname + r.search).join(",")}; body=${(await tab.locator('body').innerText()).slice(0, 600)}`);
    } finally {
      await context.close();
      notStartedServer.closeAllConnections();
      await new Promise<void>(resolve => notStartedServer.close(() => resolve()));
    }
  }, 15_000);
});
