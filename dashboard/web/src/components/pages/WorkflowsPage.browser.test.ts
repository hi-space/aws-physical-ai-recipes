/**
 * Guard test (spec §3.6): WorkflowsPage never shows raw workflow ids, ARNs or bare
 * hex identifiers anywhere in its rendered output. Unlike JobsPage, WorkflowsPage has
 * no [data-technical-details] region at all -- Task 2 removed the id line under the
 * workflow name outright, so the check here is a full-page sweep.
 *
 * Real WorkflowsPage + API client rendered in headless Chromium (esbuild bundle served
 * over loopback HTTP), matching the pattern used by PipelinesPage.browser.test.ts and
 * DagView.browser.test.ts -- this repo has no jsdom/RTL setup.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { build } from 'esbuild';

// Real 8-byte-hex workflow id shape produced by newWorkflowId() in src/server/workflow/submission.ts.
const workflowId = '0b434edd9d2afc20';
const workflow = {
  id: workflowId, name: 'so101-pick-place', namespace: 'default',
  owner: 'alice', ownerSubject: 'alice', status: 'RUNNING',
  succeededCount: 1, failedCount: 0, taskCount: 3,
  createdAt: '2026-09-18T00:00:00Z', startedAt: '2026-09-18T00:01:00Z',
};

describe.skipIf(!existsSync(chromium.executablePath()))('WorkflowsPage identifier guard', () => {
  let browser: Browser, server: Server, origin: string, page: Page;
  const errors: string[] = [];

  beforeAll(async () => {
    const bundle = await build({
      stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
        import React from 'react'; import {createRoot} from 'react-dom/client';
        import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
        import {WorkflowsPage} from './src/components/pages/WorkflowsPage';
        const client = new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false}}});
        createRoot(document.getElementById('root')).render(
          React.createElement(QueryClientProvider,{client},React.createElement(WorkflowsPage)));`,
      },
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
      const json = (value: unknown, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value));
      };
      if (url.pathname === '/bundle.js') {
        res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(bundle.outputFiles[0].text); return;
      }
      if (!url.pathname.startsWith('/api/')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><html lang="ko"><body><div id="root"></div><script src="/bundle.js"></script></body></html>'); return;
      }
      if (url.pathname === '/api/me') return json({
        user: 'alice', subject: 'alice', email: 'alice@example.test', role: 'researcher', region: 'us-east-1',
        accountId: '123456789012', features: {}, clusters: {}, buckets: {}, defaultNamespace: 'default',
        project: { id: 'a', name: 'Project A', role: 'researcher' },
        resources: { hyperPodEks: { clusterName: 'hp-cluster', eksClusterName: 'eks-cluster', logGroupPrefix: '/pai' }, table: 'pai-table' },
      });
      if (url.pathname === '/api/workflows') return json({ items: [workflow] });
      return json({ error: `unhandled fixture ${req.method} ${url.pathname}` }, 404);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  }, 30000);
  beforeEach(async () => {
    page = await (await browser.newContext()).newPage(); page.setDefaultTimeout(3000);
    page.on('pageerror', error => errors.push(error.message));
    await page.context().route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
  });
  afterEach(async () => { await page.context().close(); expect(errors).toEqual([]); });
  afterAll(async () => { await browser?.close(); if (server) await new Promise<void>(resolve => server.close(() => resolve())); });

  it('never shows the raw workflow id, an ARN, or any bare-hex identifier', async () => {
    await page.goto(origin + '/workflows');
    await page.getByText(workflow.name, { exact: true }).waitFor();

    // Sanity: the fixture id would be trivially findable if the id row were restored.
    expect(await page.getByText(workflowId, { exact: false }).count()).toBe(0);

    const bodyText = await page.evaluate(() => document.body.textContent || '');
    expect(bodyText).not.toMatch(/arn:aws/);
    expect(bodyText).not.toMatch(/\b[0-9a-f]{32}\b/);
    expect(bodyText).not.toMatch(/\b[0-9a-f]{16}\b/); // bare workflow-id shape (randomBytes(8).toString('hex'))
    expect(bodyText).toContain(workflow.name); // the page still renders something meaningful
  });
});
