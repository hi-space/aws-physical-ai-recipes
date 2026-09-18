import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { build } from 'esbuild';

describe.skipIf(!existsSync(chromium.executablePath()))('local log replay browser', () => {
  let browser: Browser, server: Server, origin: string;
  const requests: URL[] = [], errors: string[] = [];
  const head = (id: string) => ({ id, state: 'open', sequence: 3, scope: { attempt: 1, member: 0, container: 'main', podName: 'pod', podUid: id.slice(0, 8), restartCount: 0 } });
  const streams = [head('a'.repeat(64)), head('b'.repeat(64))];
  const record = (sequence: number, text: string) => ({ sequence, kind: 'data', data: Buffer.from(text).toString('base64') });
  const page = (records: unknown[], cursor: string, closed = false, stream = streams[0]) => ({ source: 'archive', streams,
    stream: { ...stream, state: closed ? 'closed' : 'open' }, records, cursor: cursor.repeat(43), hasMore: false, coverage: 'captured-only' });
  beforeAll(async () => {
    const bundle = await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
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
      if (url.pathname === '/bundle.js') { res.setHeader('content-type', 'text/javascript'); res.end(bundle.outputFiles[0].text); return; }
      if (!url.pathname.startsWith('/api/')) { res.setHeader('content-type', 'text/html'); res.end('<html><body><div id="root"></div><script src="/bundle.js"></script></body></html>'); return; }
      requests.push(url);
      if (url.searchParams.get('follow') === '1') {
        res.setHeader('content-type', 'text/event-stream');
        res.end(`id: ${'d'.repeat(43)}\nevent: page\ndata: ${JSON.stringify(page([record(2, 'last\n')], 'd'))}\n\n`);
        return;
      }
      let data;
      if (url.searchParams.get('stream') === streams[1].id) data = page([record(5, 'other source')], 'f', true, streams[1]);
      else if (url.searchParams.get('cursor') === 'd'.repeat(43)) data = page([record(3, 'after reconnect')], 'e', true);
      else if (url.searchParams.has('cursor')) data = page([], 'c');
      else data = page([record(1, 'repeat\nrepeat\n\nhttps://example.test\n')], 'c');
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(data));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  }, 30_000);
  afterAll(async () => { await browser?.close(); server?.closeAllConnections(); if (server) await new Promise<void>(resolve => server.close(() => resolve())); });
  it('keeps existing lines across a real SSE disconnect and sends the applied cursor on reconnect', async () => {
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
      expect(content).toContain('https://example.test'); expect(content).toContain('last');
      expect(requests.some(r => r.searchParams.get('cursor') === 'd'.repeat(43) && !r.searchParams.has('follow'))).toBe(true);
      await tab.getByLabel('저장된 로그 소스').selectOption(streams[1].id);
      await tab.getByText('other source', { exact: false }).waitFor();
      expect(requests.find(r => r.searchParams.get('stream') === streams[1].id)?.searchParams.has('cursor')).toBe(false);
      expect(await tab.locator('[aria-label="작업 로그"]').textContent()).not.toContain('repeat');
      expect(errors).toEqual([]);
    } catch (error) {
      throw new Error(`${String(error)}; browser=${JSON.stringify(errors)}; requests=${requests.map(r => r.pathname).join(',')}; body=${(await tab.locator('body').innerText()).slice(0, 600)}`);
    } finally { await context.close(); }
  }, 15_000);
});
